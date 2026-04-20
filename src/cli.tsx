import fs from "node:fs";
import { createInterface } from "node:readline";
import { Command } from "commander";
import chalk from "chalk";
import { render } from "ink";
import React from "react";
import { formatDistanceToNow } from "date-fns";

import { ProviderRegistry } from "./providers/registry.js";
import { applyFilters } from "./core/aggregator.js";
import { SessionCache } from "./core/cache.js";
import { ConfigManager, type AsmConfig } from "./core/config.js";
import { openSession } from "./core/opener.js";
import { getSessionHistory } from "./core/history.js";
import { deleteSession, getDeleteDescription } from "./core/deleter.js";
import { App } from "./ui/App.js";
import {
  AGENT_CONFIGS,
  type AgentType,
  type FilterOptions,
  type UnifiedSession,
} from "./providers/types.js";

// -- Provider imports ---------------------------------------------------------
import { ClaudeCodeProvider } from "./providers/claude-code.js";
import { CodexProvider } from "./providers/codex.js";
import { CursorProvider } from "./providers/cursor.js";
import { OpenCodeProvider } from "./providers/opencode.js";

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

function createRegistry(config?: AsmConfig): ProviderRegistry {
  const disabled = new Set(config?.disabledAgents ?? []);
  const paths = config?.paths ?? {};
  const registry = new ProviderRegistry();
  if (!disabled.has("claude-code")) registry.register(new ClaudeCodeProvider(paths["claude-code"]));
  if (!disabled.has("codex")) registry.register(new CodexProvider(paths["codex"]));
  if (!disabled.has("cursor")) registry.register(new CursorProvider(paths["cursor"]));
  if (!disabled.has("opencode")) registry.register(new OpenCodeProvider(paths["opencode"]));
  return registry;
}

/**
 * 带缓存的会话获取。对每个 provider 独立判断缓存是否有效，
 * 命中缓存的 provider 不重新扫描，未命中的重新扫描并更新缓存。
 *
 * @param refresh 为 true 时跳过缓存，强制全量扫描
 */
async function getCachedSessions(
  registry: ProviderRegistry,
  refresh = false,
  config?: AsmConfig,
): Promise<UnifiedSession[]> {
  const cache = new SessionCache(undefined, config?.paths);
  const cacheData = refresh ? { version: 1 as const, providers: {} } : cache.load();
  const providers = await registry.getAvailableProviders();

  const allSessions: UnifiedSession[] = [];

  for (const provider of providers) {
    const cached = cacheData.providers[provider.name];

    if (!refresh && cached && cache.isValid(provider.name, cached)) {
      // 缓存命中，直接反序列化
      allSessions.push(...SessionCache.deserializeSessions(cached.sessions));
    } else {
      // 缓存未命中或强制刷新，重新扫描
      try {
        const sessions = await provider.getSessions();
        allSessions.push(...sessions);
        // 更新缓存
        cacheData.providers[provider.name] = {
          fingerprint: cache.getFingerprint(provider.name),
          sessions: SessionCache.serializeSessions(sessions),
          cachedAt: Date.now(),
        };
      } catch {
        // provider 失败不影响其他
      }
    }
  }

  // 保存更新后的缓存
  cache.save(cacheData);

  // 按 updatedAt 倒序
  allSessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return allSessions;
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 将 "7d", "30d", "1h" 等字符串转换为 Date */
function parseSince(value: string): Date {
  const match = value.match(/^(\d+)([dhms])$/i);
  if (!match) {
    console.error(
      chalk.red(`Invalid --since value: "${value}". Use format like 7d, 30d, 1h`),
    );
    process.exit(1);
  }
  const num = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  const now = Date.now();
  const ms: Record<string, number> = {
    d: 86400_000,
    h: 3600_000,
    m: 60_000,
    s: 1000,
  };
  return new Date(now - num * (ms[unit] ?? 86400_000));
}

/**
 * 计算字符串的显示宽度（中文/全角字符占 2 列，ASCII 占 1 列）
 */
function displayWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK Unified Ideographs, CJK Compatibility, Fullwidth Forms, etc.
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||  // CJK
      (code >= 0xf900 && code <= 0xfaff) ||  // CJK Compatibility
      (code >= 0xfe30 && code <= 0xfe4f) ||  // CJK Compatibility Forms
      (code >= 0xff00 && code <= 0xff60) ||  // Fullwidth Forms
      (code >= 0xffe0 && code <= 0xffe6) ||  // Fullwidth Signs
      (code >= 0x20000 && code <= 0x2fa1f)   // CJK Extension
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/** 按显示宽度截断字符串 */
function truncate(str: string, maxWidth: number): string {
  let width = 0;
  let i = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 0;
    const cw =
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x2fa1f)
        ? 2 : 1;
    if (width + cw > maxWidth - 1) {
      return str.slice(0, i) + "…";
    }
    width += cw;
    i += ch.length;
  }
  return str;
}

/** 按显示宽度右填充空格 */
function padDisplay(str: string, targetWidth: number): string {
  const w = displayWidth(str);
  return w >= targetWidth ? str : str + " ".repeat(targetWidth - w);
}

/** 缩短路径 */
function shortenPath(p: string, maxLen = 24): string {
  if (!p) return "";
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
  let display = p;
  if (home && display.startsWith(home)) {
    display = "~" + display.slice(home.length);
  }
  if (display.length <= maxLen) return display;
  return display.slice(0, 10) + "…" + display.slice(-(maxLen - 11));
}

/** 相对时间 */
function relativeTime(date: Date): string {
  try {
    return formatDistanceToNow(date, { addSuffix: true });
  } catch {
    return "";
  }
}

/** 交互式确认 */
function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

/** Agent badge 着色 */
function agentBadge(agent: AgentType): string {
  const config = AGENT_CONFIGS[agent];
  const colorFn = (chalk as unknown as Record<string, (s: string) => string>)[
    config.color
  ];
  return colorFn ? colorFn(config.icon) : config.icon;
}

// ── 列宽常量（和 TUI App.tsx 保持一致）──────────────────────
const COL_TITLE  = 36;
const COL_DIR    = 26;
const COL_BRANCH = 20;
const COL_TIME   = 16;

/** 非交互式表格输出 — 列顺序和 TUI 一致: badge title dir branch time */
function printSessionTable(sessions: UnifiedSession[], showId = false): void {
  if (sessions.length === 0) {
    console.log(chalk.gray("No sessions found."));
    return;
  }

  for (const s of sessions) {
    const badge = agentBadge(s.agent);
    const idHint = showId ? chalk.gray(s.id.slice(0, 8)) + " " : "";
    const title  = padDisplay(truncate(s.title, COL_TITLE), COL_TITLE);
    const dir    = chalk.gray(padDisplay(shortenPath(s.workingDirectory, COL_DIR), COL_DIR));
    const branch = s.gitBranch
      ? chalk.green(padDisplay(truncate(s.gitBranch, COL_BRANCH), COL_BRANCH))
      : " ".repeat(COL_BRANCH);
    const time   = chalk.gray(relativeTime(s.updatedAt));

    console.log(`${badge} ${idHint}${title} ${dir} ${branch} ${time}`);
  }

  console.log(chalk.gray(`\nTotal: ${sessions.length} sessions`));
}

// ---------------------------------------------------------------------------
// CLI 定义
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("asm")
  .description(
    "Agent Sessions Manager - Unified session manager for coding agents",
  )
  .version("0.1.0")
  .addHelpText(
    "after",
    `
${chalk.bold("About")}

  asm 诞生于一个朴素的痛点：AI 大幅提效让并行工作暴增，会话散落在不同
  agent、不同目录、不同分支。"我记得做过这件事，但在哪个会话？"成了日常。
  asm 扫描所有 agent 的本地会话数据，汇聚成一张统一视图——搜索、过滤、
  一键恢复，从此告别翻目录的日子。

${chalk.bold("Supported Agents")}

  ${chalk.magenta("CC")}  Claude Code    ${chalk.green("full resume")}   claude -r <id>
  ${chalk.green("CX")}  Codex          ${chalk.green("full resume")}   codex --resume <id>
  ${chalk.blue("CR")}  Cursor         ${chalk.yellow("open workspace")}  cursor <dir>
  ${chalk.cyan("OC")}  OpenCode       ${chalk.green("full resume")}   opencode --session <id>

${chalk.bold("Examples")}

  ${chalk.gray("$")} asm                          Interactive TUI
  ${chalk.gray("$")} asm list                     List all sessions
  ${chalk.gray("$")} asm list -a claude-code       Filter by agent
  ${chalk.gray("$")} asm list -s 7d               Last 7 days
  ${chalk.gray("$")} asm list -d ~/Projects       Filter by directory
  ${chalk.gray("$")} asm search "auth"            Fuzzy search
  ${chalk.gray("$")} asm open <session-id>        Resume directly
`,
  );

// asm list
program
  .command("list")
  .description("List all sessions (non-interactive)")
  .option("-a, --agent <agent>", "Filter by agent type")
  .option("-d, --dir <directory>", "Filter by working directory prefix")
  .option("-s, --since <duration>", "Only show sessions updated within duration (e.g. 7d, 30d)")
  .option("-l, --limit <number>", "Limit number of results", parseInt)
  .option("--id", "Show session ID prefix (for use with asm open/history)")
  .option("-r, --refresh", "Force refresh, skip cache")
  .action(async (opts) => {
    const config = ConfigManager.load();
    const registry = createRegistry(config);
    const all = await getCachedSessions(registry, opts.refresh, config);

    const filterOptions: FilterOptions = {};
    if (opts.agent) {
      filterOptions.agent = opts.agent as AgentType;
    }
    if (opts.dir) {
      filterOptions.directory = opts.dir;
    }
    if (opts.since) {
      filterOptions.since = parseSince(opts.since);
    } else if (config.defaults?.sinceDays) {
      filterOptions.since = new Date(Date.now() - config.defaults.sinceDays * 86400_000);
    }
    if (opts.limit) {
      filterOptions.limit = opts.limit;
    } else if (config.defaults?.limit) {
      filterOptions.limit = config.defaults.limit;
    }

    const sessions = applyFilters(all, filterOptions);
    printSessionTable(sessions, opts.id);
  });

// asm search <keyword>
program
  .command("search <keyword>")
  .description("Search sessions by keyword")
  .option("-a, --agent <agent>", "Filter by agent type")
  .option("-l, --limit <number>", "Limit number of results", parseInt)
  .option("--id", "Show session ID prefix")
  .option("-r, --refresh", "Force refresh, skip cache")
  .action(async (keyword: string, opts) => {
    const config = ConfigManager.load();
    const registry = createRegistry(config);
    const all = await getCachedSessions(registry, opts.refresh, config);

    const filterOptions: FilterOptions = {
      keyword,
    };
    if (opts.agent) {
      filterOptions.agent = opts.agent as AgentType;
    }
    if (opts.limit) {
      filterOptions.limit = opts.limit;
    } else if (config.defaults?.limit) {
      filterOptions.limit = config.defaults.limit;
    }

    const sessions = applyFilters(all, filterOptions);
    printSessionTable(sessions, opts.id);
  });

// asm open <id>
program
  .command("open <id>")
  .description("Open/resume a session by ID")
  .action(async (id: string) => {
    const config = ConfigManager.load();
    const registry = createRegistry(config);
    const sessions = await getCachedSessions(registry, false, config);

    // 支持 ID 前缀匹配
    const session = sessions.find((s) => s.id === id || s.id.startsWith(id));
    if (!session) {
      console.error(chalk.red(`Session not found: ${id}`));
      process.exit(1);
    }

    if (!session.canResume) {
      console.error(
        chalk.yellow(
          `Session "${session.title}" (${session.agent}) does not support resume.`,
        ),
      );
      process.exit(1);
    }

    openSession(session);
  });

// asm history <id>
program
  .command("history <id>")
  .description("View message history of a session")
  .option("-l, --limit <number>", "Limit number of messages", parseInt)
  .action(async (id: string, opts: { limit?: number }) => {
    const config = ConfigManager.load();
    const registry = createRegistry(config);
    const sessions = await getCachedSessions(registry, false, config);

    // ID 前缀匹配 + 标题模糊匹配
    let matches = sessions.filter((s) => s.id.startsWith(id));
    if (matches.length === 0) {
      // fallback: 按标题包含关键词搜索
      const kw = id.toLowerCase();
      matches = sessions.filter((s) => s.title.toLowerCase().includes(kw));
    }

    if (matches.length === 0) {
      console.error(chalk.red(`No session found matching: ${id}`));
      console.error(chalk.gray(`Tip: use "asm list --id" to see session IDs`));
      process.exit(1);
    }

    if (matches.length > 1) {
      console.error(
        chalk.yellow(
          `Ambiguous ID prefix "${id}" matches ${matches.length} sessions. Please be more specific:`,
        ),
      );
      for (const s of matches.slice(0, 10)) {
        const badge = agentBadge(s.agent);
        console.error(`  ${badge} ${s.id}  ${s.title}`);
      }
      if (matches.length > 10) {
        console.error(chalk.gray(`  ... and ${matches.length - 10} more`));
      }
      process.exit(1);
    }

    const session = matches[0]!;
    console.log(
      chalk.bold(`Session: ${session.title}`),
    );
    console.log(
      chalk.gray(
        `${agentBadge(session.agent)} ${session.agent}  ${shortenPath(session.workingDirectory)}  ${relativeTime(session.updatedAt)}`,
      ),
    );
    console.log();

    const history = await getSessionHistory(
      session.id,
      session.agent,
      session.workingDirectory,
    );

    if (history.messages.length === 0) {
      console.log(chalk.gray("No message history available for this session."));
      process.exit(0);
    }

    let messages = history.messages;
    if (opts.limit && opts.limit > 0) {
      messages = messages.slice(-opts.limit);
    }

    for (const msg of messages) {
      const roleColor = msg.role === "user" ? chalk.cyan : msg.role === "assistant" ? chalk.green : chalk.gray;
      const roleLabel = roleColor(`[${msg.role}]`);
      const timeStr = msg.timestamp
        ? chalk.gray(msg.timestamp.toLocaleString())
        : "";

      // assistant 消息截断到 200 字符，user 消息完整显示
      let content = msg.content.replace(/\n/g, " ").trim();
      if (msg.role === "assistant" && content.length > 200) {
        content = content.slice(0, 197) + "...";
      }

      console.log(`${roleLabel} ${timeStr}`);
      console.log(`  ${content}`);
      console.log();
    }

    console.log(chalk.gray(`Total: ${history.messages.length} messages`));
  });

// asm delete <id>
program
  .command("delete <id>")
  .description("Delete/archive a session (with safety backup)")
  .option("-f, --force", "Skip confirmation prompt")
  .action(async (id: string, opts: { force?: boolean }) => {
    const config = ConfigManager.load();
    const registry = createRegistry(config);
    const sessions = await getCachedSessions(registry, false, config);

    // ID 前缀匹配
    let matches = sessions.filter((s) => s.id.startsWith(id));
    if (matches.length === 0) {
      // fallback: 按标题包含关键词搜索
      const kw = id.toLowerCase();
      matches = sessions.filter((s) => s.title.toLowerCase().includes(kw));
    }

    if (matches.length === 0) {
      console.error(chalk.red(`No session found matching: ${id}`));
      console.error(chalk.gray(`Tip: use "asm list --id" to see session IDs`));
      process.exit(1);
    }

    if (matches.length > 1) {
      console.error(
        chalk.yellow(
          `Ambiguous ID prefix "${id}" matches ${matches.length} sessions. Please be more specific:`,
        ),
      );
      for (const s of matches.slice(0, 10)) {
        const badge = agentBadge(s.agent);
        console.error(`  ${badge} ${s.id}  ${s.title}`);
      }
      if (matches.length > 10) {
        console.error(chalk.gray(`  ... and ${matches.length - 10} more`));
      }
      process.exit(1);
    }

    const session = matches[0]!;

    // 显示会话信息
    console.log(chalk.bold("确定要删除以下会话？"));
    console.log(
      `  ${agentBadge(session.agent)}  ${session.title}  ${chalk.gray(shortenPath(session.workingDirectory))}  ${chalk.gray(relativeTime(session.updatedAt))}`,
    );
    console.log(
      chalk.gray(`  操作: ${getDeleteDescription(session.agent)}`),
    );
    console.log();

    // 确认
    if (!opts.force) {
      const confirmed = await confirm(`输入 ${chalk.bold("y")} 确认删除: `);
      if (!confirmed) {
        console.log(chalk.gray("已取消"));
        process.exit(0);
      }
    }

    // 执行删除
    const result = await deleteSession(session);
    if (result.success) {
      console.log(chalk.green(`✓ ${result.message}`));
      if (result.recoveryHint) {
        console.log(chalk.gray(`  恢复提示: ${result.recoveryHint}`));
      }
    } else {
      console.error(chalk.red(`✗ ${result.message}`));
      process.exit(1);
    }
  });

// 默认命令: 交互式 TUI
program.action(async () => {
  const config = ConfigManager.load();
  const registry = createRegistry(config);
  const sessions = await getCachedSessions(registry, false, config);

  if (sessions.length === 0) {
    console.log(chalk.gray("No sessions found from any agent."));
    console.log(
      chalk.gray(
        "Supported agents: Claude Code, Codex, Cursor, OpenCode",
      ),
    );
    process.exit(0);
  }

  // 用 Promise 把选中的 session 传出来，等 Ink 完全退出后再 spawn
  let selectedSession: UnifiedSession | null = null;

  const { waitUntilExit } = render(
    <App
      sessions={sessions}
      onSelect={(session) => {
        selectedSession = session;
      }}
    />,
  );

  await waitUntilExit();

  // Ink 已完全退出、stdin raw mode 已还原，现在安全地 spawn 子进程
  if (selectedSession) {
    openSession(selectedSession);
  }
});

// asm config
const configCmd = program
  .command("config")
  .description("Manage configuration");

// asm config show
configCmd
  .command("show")
  .description("Show current configuration")
  .action(() => {
    const configPath = ConfigManager.getConfigPath();
    console.log(`Config file: ${configPath}\n`);
    const config = ConfigManager.load();
    console.log(JSON.stringify(config, null, 2));
  });

// asm config path
configCmd
  .command("path")
  .description("Show configuration file path")
  .action(() => {
    console.log(ConfigManager.getConfigPath());
  });

// asm config init
configCmd
  .command("init")
  .description("Create default configuration file (if not exists)")
  .action(() => {
    const configPath = ConfigManager.getConfigPath();
    const exists = fs.existsSync(configPath);
    const config = ConfigManager.init();
    if (exists) {
      console.log(chalk.yellow(`Config file already exists: ${configPath}`));
    } else {
      console.log(chalk.green(`Created config file: ${configPath}`));
    }
    console.log(JSON.stringify(config, null, 2));
  });

// asm config set <key> <value>
configCmd
  .command("set <key> <value>")
  .description("Set a configuration value (e.g. defaults.sinceDays 30)")
  .action((key: string, value: string) => {
    const config = ConfigManager.load();

    // 自动识别 value 类型
    const parsed = parseConfigValue(key, value);

    // 用点号分隔的 key path 设置值
    setNestedValue(config as Record<string, unknown>, key, parsed);

    ConfigManager.save(config);
    console.log(chalk.green(`Set ${key} = ${JSON.stringify(parsed)}`));
  });

/** 根据 key 和原始字符串推断类型 */
function parseConfigValue(key: string, raw: string): unknown {
  // disabledAgents 特殊处理：逗号分隔转数组
  if (key === "disabledAgents") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  // boolean
  if (raw === "true") return true;
  if (raw === "false") return false;
  // number
  const num = Number(raw);
  if (!Number.isNaN(num) && raw.trim() !== "") return num;
  // string
  return raw;
}

/** 按点号路径设置嵌套属性 */
function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const keys = keyPath.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (current[k] === undefined || typeof current[k] !== "object" || current[k] === null) {
      current[k] = {};
    }
    current = current[k] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
}

program.parse();
