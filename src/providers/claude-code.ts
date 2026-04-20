/**
 * Claude Code Session Provider
 *
 * 读取 ~/.claude/projects/<encoded-path>/<uuid>.jsonl 会话文件，
 * 解析 JSONL 行并映射为 UnifiedSession。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { SessionProvider, UnifiedSession } from "./types.js";
import { resolveAgentPath } from "../core/paths.js";

// ─── JSONL 行类型定义 ────────────────────────────────────────────

interface JMessage {
  role: string;
  content: string | Array<{ type: string; [k: string]: unknown }>;
  model?: string;
}

interface JLine {
  type: string;
  message?: JMessage;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  gitBranch?: string;
  version?: string;
  model?: string;
  slug?: string;
  customTitle?: string;
  toolUseResult?: unknown;
}

// ─── 工具函数 ──────────────────────────────────────────────────

/**
 * 判断 user 行是否是"真实用户输入"。
 * 排除：
 *  1. content 中含有 `<local-command` / `<command-name` / `<local-command-stdout` 标签
 *  2. content 是 tool_result 数组（toolUseResult 存在的行）
 */
function isRealUserMessage(line: JLine): boolean {
  if (line.type !== "user") return false;
  // tool_result 类型（工具执行结果回传）不算用户消息
  if (line.toolUseResult != null) return false;

  const content = line.message?.content;
  if (content == null) return false;

  // content 是数组时，检查是否全是 tool_result
  if (Array.isArray(content)) {
    const allToolResult = content.every((c) => c.type === "tool_result");
    if (allToolResult) return false;
    // 数组中如果有 text 类型，把文本拼起来检查标签
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => String(c.text ?? ""))
      .join("");
    return !isSystemCommand(text);
  }

  // content 是字符串
  return !isSystemCommand(content);
}

/** 检查字符串是否是系统命令内容 */
function isSystemCommand(text: string): boolean {
  if (!text) return true;
  return (
    text.startsWith("<local-command") ||
    text.startsWith("<command-name") ||
    text.startsWith("<local-command-stdout") ||
    text.startsWith("<local-command-caveat")
  );
}

/** 从 user message 中提取纯文本 */
function extractText(content: string | Array<{ type: string; [k: string]: unknown }>): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text")
      .map((c) => String(c.text ?? ""))
      .join("\n");
  }
  return "";
}

/**
 * 从目录名反推工作目录（fallback 方案）。
 * `-Users-john-Projects` → `/Users/john/Projects`
 *
 * 策略：依次尝试从最长路径到最短路径，检查哪个路径真实存在。
 * 如果都不存在，就把所有 `-` 替换为 `/` 返回最简单的结果。
 */
function decodeDirName(dirName: string): string {
  // 开头的 `-` 代表根 `/`
  if (!dirName.startsWith("-")) return dirName;
  const segments = dirName.slice(1).split("-");
  // 逐步合并：尝试贪心地拼回目录
  // 例如 segments = ['Users','john','Projects','my-app']
  // 尝试 /Users 存在? → /Users/john 存在? → ...
  let resolved = "";
  for (const seg of segments) {
    const tryAppend = resolved + "/" + seg;
    const tryMerge = resolved + "-" + seg;
    if (fs.existsSync(tryAppend)) {
      resolved = tryAppend;
    } else if (resolved && fs.existsSync(tryMerge)) {
      resolved = tryMerge;
    } else if (resolved) {
      // 两个都不存在，优先 `/` 分隔
      resolved = tryAppend;
    } else {
      resolved = "/" + seg;
    }
  }
  return resolved || "/" + segments.join("/");
}

// ─── 单个会话文件解析 ──────────────────────────────────────────

interface ParsedSession {
  id: string;
  title: string;
  firstMessage: string;
  lastMessage: string;
  workingDirectory: string;
  gitBranch?: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  model?: string;
}

/**
 * 流式解析单个 JSONL 会话文件。
 * 只遍历一次文件，但只保留必要信息，避免大量内存开销。
 */
async function parseSessionFile(
  filePath: string,
  dirName: string,
): Promise<ParsedSession | null> {
  const fileName = path.basename(filePath, ".jsonl");

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let firstRealMsg = "";
    let lastRealMsg = "";
    let firstTimestamp: string | undefined;
    let cwd: string | undefined;
    let gitBranch: string | undefined;
    let model: string | undefined;
    let messageCount = 0;
    let slug: string | undefined;
    let customTitle: string | undefined;

    rl.on("line", (raw) => {
      if (!raw) return;
      let line: JLine;
      try {
        line = JSON.parse(raw) as JLine;
      } catch {
        return; // 跳过损坏行
      }

      const t = line.type;

      // 统计消息数（user + assistant）
      if (t === "user" || t === "assistant") {
        messageCount++;
      }

      // 获取时间戳（取第一条非空时间戳作为创建时间）
      if (!firstTimestamp && line.timestamp) {
        firstTimestamp = line.timestamp;
      }

      // 获取工作目录 & git 分支（取第一次出现的值）
      if (!cwd && line.cwd) {
        cwd = line.cwd;
      }
      if (!gitBranch && line.gitBranch) {
        gitBranch = line.gitBranch;
      }

      // 获取 slug（会话的生成昵称）
      if (!slug && line.slug) {
        slug = line.slug;
      }

      // 获取 custom-title（用户/系统设定的会话标题，取最后一个）
      if (t === "custom-title" && line.customTitle) {
        customTitle = line.customTitle;
      }

      // 获取模型
      if (!model) {
        const m = line.message?.model ?? line.model;
        if (m && m !== "<synthetic>") {
          model = m;
        }
      }

      // 处理真实用户消息
      if (isRealUserMessage(line)) {
        const text = extractText(line.message!.content);
        if (!firstRealMsg) {
          firstRealMsg = text;
        }
        lastRealMsg = text;
      }
    });

    rl.on("close", () => {
      // 没有任何真实用户消息且没有 slug 的会话直接跳过
      if (!firstRealMsg && !slug) {
        resolve(null);
        return;
      }

      const workingDirectory = cwd || decodeDirName(dirName);

      // 标题优先级: customTitle > 首条真实用户消息 > slug > session ID
      let title: string;
      if (customTitle) {
        title = customTitle;
      } else if (firstRealMsg) {
        const oneLine = firstRealMsg.replace(/\n/g, " ").trim();
        title = oneLine.length > 80 ? oneLine.slice(0, 77) + "..." : oneLine;
      } else if (slug) {
        title = slug;
      } else {
        title = fileName;
      }

      // 对于过短的单词标题（不含空格且 < 15 字符），附加项目目录名增强可辨识度
      if (!title.includes(" ") && title.length < 15 && workingDirectory) {
        const dirBasename = path.basename(workingDirectory);
        if (dirBasename && dirBasename !== "~") {
          title = `${title} [${dirBasename}]`;
        }
      }

      resolve({
        id: fileName,
        title,
        firstMessage: firstRealMsg,
        lastMessage: lastRealMsg,
        workingDirectory,
        gitBranch: gitBranch === "HEAD" ? undefined : gitBranch,
        createdAt: firstTimestamp ? new Date(firstTimestamp) : stat.birthtime,
        updatedAt: stat.mtime,
        messageCount,
        model,
      });
    });

    rl.on("error", () => {
      resolve(null);
    });
    stream.on("error", () => {
      rl.close();
      resolve(null);
    });
  });
}

// ─── ClaudeCodeProvider ────────────────────────────────────────

export class ClaudeCodeProvider implements SessionProvider {
  readonly name = "claude-code" as const;
  readonly displayName = "Claude Code";

  private readonly customPath?: string;

  constructor(dataPath?: string) {
    this.customPath = dataPath;
  }

  /** 动态解析 projects 目录路径 */
  private resolveDataPath(): string | null {
    return resolveAgentPath("claude-code", this.customPath);
  }

  async isAvailable(): Promise<boolean> {
    const projectsDir = this.resolveDataPath();
    if (!projectsDir) return false;
    try {
      const stat = await fs.promises.stat(projectsDir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async getSessions(): Promise<UnifiedSession[]> {
    const projectsDir = this.resolveDataPath();
    if (!projectsDir) return [];

    // 列出所有项目目录
    let projectDirs: string[];
    try {
      const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
      projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }

    // 收集所有 .jsonl 文件
    const tasks: Array<{ file: string; dirName: string }> = [];
    for (const dirName of projectDirs) {
      // 跳过特殊目录
      if (dirName === "memory" || dirName.startsWith(".")) continue;

      const dirPath = path.join(projectsDir, dirName);
      let files: string[];
      try {
        files = await fs.promises.readdir(dirPath);
      } catch {
        continue;
      }
      for (const file of files) {
        if (file.endsWith(".jsonl")) {
          tasks.push({ file: path.join(dirPath, file), dirName });
        }
      }
    }

    // 并发解析所有会话文件（限制并发数避免打开过多文件）
    const CONCURRENCY = 20;
    const results: UnifiedSession[] = [];
    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
      const batch = tasks.slice(i, i + CONCURRENCY);
      const parsed = await Promise.all(
        batch.map(({ file, dirName }) => parseSessionFile(file, dirName)),
      );
      for (const p of parsed) {
        if (p) {
          results.push({
            id: p.id,
            agent: "claude-code",
            title: p.title,
            firstMessage: p.firstMessage,
            lastMessage: p.lastMessage,
            workingDirectory: p.workingDirectory,
            gitBranch: p.gitBranch,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            messageCount: p.messageCount,
            model: p.model,
            resumeCommand: `claude -r ${p.id}`,
            canResume: true,
          });
        }
      }
    }

    // 按最后活动时间倒序排列
    results.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return results;
  }
}
