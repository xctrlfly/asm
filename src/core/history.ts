/**
 * 会话消息历史提取模块
 *
 * 为不同 agent 实现消息历史读取，将原始数据映射为统一的 HistoryMessage 格式。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import Database from "better-sqlite3";
import type { AgentType } from "../providers/types.js";

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  content: string; // 纯文本内容（去掉工具调用等复杂结构）
  timestamp?: Date;
}

export interface SessionHistory {
  sessionId: string;
  agent: AgentType;
  messages: HistoryMessage[];
}

// ---------------------------------------------------------------------------
// Claude Code (JSONL)
// ---------------------------------------------------------------------------

/** JSONL 行结构（简化版，只取我们关心的字段） */
interface ClaudeLine {
  type: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
  };
  timestamp?: string;
  toolUseResult?: unknown;
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

/** 从 message content 中提取纯文本 */
function extractText(
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }>,
): string {
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
 * 遍历 ~/.claude/projects/ 目录，查找名为 <sessionId>.jsonl 的文件
 */
function findClaudeSessionFile(sessionId: string): string | null {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return null;

  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }

  for (const dir of dirs) {
    if (dir === "memory" || dir.startsWith(".")) continue;
    const filePath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

/**
 * 解析 Claude Code JSONL 文件，提取消息历史
 */
async function getClaudeHistory(sessionId: string): Promise<HistoryMessage[]> {
  const filePath = findClaudeSessionFile(sessionId);
  if (!filePath) return [];

  return new Promise((resolve) => {
    const messages: HistoryMessage[] = [];
    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (raw) => {
      if (!raw) return;
      let line: ClaudeLine;
      try {
        line = JSON.parse(raw) as ClaudeLine;
      } catch {
        return;
      }

      const timestamp = line.timestamp ? new Date(line.timestamp) : undefined;

      if (line.type === "user") {
        // 跳过工具结果回传
        if (line.toolUseResult != null) return;

        const content = line.message?.content;
        if (content == null) return;

        // 数组形式：跳过全是 tool_result 的行
        if (Array.isArray(content)) {
          const allToolResult = content.every((c) => c.type === "tool_result");
          if (allToolResult) return;
        }

        const text = extractText(content);
        if (isSystemCommand(text)) return;
        if (!text.trim()) return;

        messages.push({ role: "user", content: text, timestamp });
      } else if (line.type === "assistant") {
        const content = line.message?.content;
        if (content == null) return;

        const text = extractText(content);
        if (!text.trim()) return;

        messages.push({ role: "assistant", content: text, timestamp });
      }
    });

    rl.on("close", () => resolve(messages));
    rl.on("error", () => resolve(messages));
    stream.on("error", () => {
      rl.close();
      resolve(messages);
    });
  });
}

// ---------------------------------------------------------------------------
// Codex (SQLite) — MVP: 仅返回 first_user_message
// ---------------------------------------------------------------------------

/** threads 表行类型 */
interface CodexThreadRow {
  first_user_message: string;
}

function getCodexHistory(sessionId: string): HistoryMessage[] {
  const dbPath = path.join(os.homedir(), ".codex", "state_5.sqlite");
  if (!fs.existsSync(dbPath)) return [];

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return [];
  }

  try {
    const row = db
      .prepare(`SELECT first_user_message FROM threads WHERE id = ?`)
      .get(sessionId) as CodexThreadRow | undefined;

    if (!row?.first_user_message?.trim()) return [];

    return [{ role: "user", content: row.first_user_message.trim() }];
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Cursor (SQLite) — 从 composerData 中提取 conversation
// ---------------------------------------------------------------------------

/** Cursor conversation bubble 结构 */
interface CursorBubble {
  type?: number; // 1 = human, 2 = AI
  text?: string;
  bubbleContent?: string;
  [key: string]: unknown;
}

/** cursorDiskKV 表行 */
interface CursorKVRow {
  value: string;
}

/** composerData JSON 结构 */
interface CursorComposerData {
  conversation?: CursorBubble[];
  [key: string]: unknown;
}

function getCursorHistory(sessionId: string): HistoryMessage[] {
  const cursorDataDir =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Cursor", "User")
      : "";
  if (!cursorDataDir) return [];

  const globalDbPath = path.join(cursorDataDir, "globalStorage", "state.vscdb");
  if (!fs.existsSync(globalDbPath)) return [];

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(globalDbPath, { readonly: true });
  } catch {
    return [];
  }

  try {
    const row = db
      .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
      .get(`composerData:${sessionId}`) as CursorKVRow | undefined;

    if (!row?.value) return [];

    let data: CursorComposerData;
    try {
      data = JSON.parse(row.value) as CursorComposerData;
    } catch {
      return [];
    }

    const conversation = data.conversation;
    if (!Array.isArray(conversation)) return [];

    const messages: HistoryMessage[] = [];
    for (const bubble of conversation) {
      const text = (bubble.text || bubble.bubbleContent || "").trim();
      if (!text) continue;

      if (bubble.type === 1) {
        messages.push({ role: "user", content: text });
      } else if (bubble.type === 2) {
        messages.push({ role: "assistant", content: text });
      }
    }

    return messages;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// OpenCode — 不存储消息历史
// ---------------------------------------------------------------------------

function getOpenCodeHistory(): HistoryMessage[] {
  return [];
}

// ---------------------------------------------------------------------------
// 核心 API
// ---------------------------------------------------------------------------

/**
 * 获取指定会话的消息历史
 * @param sessionId 会话 ID
 * @param agent agent 类型
 * @param workingDirectory 工作目录（用于定位 Claude Code 的 JSONL 文件）
 */
export async function getSessionHistory(
  sessionId: string,
  agent: AgentType,
  _workingDirectory: string,
): Promise<SessionHistory> {
  let messages: HistoryMessage[];

  switch (agent) {
    case "claude-code":
      messages = await getClaudeHistory(sessionId);
      break;
    case "codex":
      messages = getCodexHistory(sessionId);
      break;
    case "cursor":
      messages = getCursorHistory(sessionId);
      break;
    case "opencode":
      messages = getOpenCodeHistory();
      break;
    default:
      messages = [];
  }

  return { sessionId, agent, messages };
}
