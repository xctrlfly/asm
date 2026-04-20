import fs from "node:fs";
import Database from "better-sqlite3";
import type { SessionProvider, UnifiedSession } from "./types.js";
import { resolveAgentPath } from "../core/paths.js";

/** threads 表行类型 */
interface ThreadRow {
  id: string;
  title: string;
  first_user_message: string;
  cwd: string;
  git_branch: string | null;
  created_at: number;
  updated_at: number;
  model_provider: string;
  archived: number;
  has_user_event: number;
}

/** 被视为无效标题的命令列表 */
const INVALID_TITLES = new Set(["/exit", "exit", "/quit", "quit", "/q"]);

/**
 * 从 title / first_user_message 中提取有效的显示标题
 */
function resolveTitle(title: string, firstMessage: string): string {
  const trimmed = title.trim();
  if (trimmed && !INVALID_TITLES.has(trimmed.toLowerCase())) {
    return trimmed;
  }
  // fallback 到 first_user_message 的前 80 字符
  if (firstMessage) {
    const oneLine = firstMessage.replace(/\n/g, " ").trim();
    return oneLine.length > 80 ? oneLine.slice(0, 80) + "..." : oneLine;
  }
  return "(untitled)";
}

export class CodexProvider implements SessionProvider {
  readonly name = "codex" as const;
  readonly displayName = "Codex";

  private readonly customPath?: string;

  constructor(dataPath?: string) {
    this.customPath = dataPath;
  }

  /** 动态解析数据库路径 */
  private resolveDataPath(): string | null {
    return resolveAgentPath("codex", this.customPath);
  }

  async isAvailable(): Promise<boolean> {
    return this.resolveDataPath() !== null;
  }

  async getSessions(): Promise<UnifiedSession[]> {
    const dbPath = this.resolveDataPath();
    if (!dbPath) {
      return [];
    }

    let db: InstanceType<typeof Database>;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      // 数据库文件损坏或被锁定等情况
      return [];
    }

    try {
      const rows = db
        .prepare(
          `SELECT id, title, first_user_message, cwd, git_branch,
                  created_at, updated_at, model_provider,
                  archived, has_user_event
           FROM threads
           WHERE archived = 0
           ORDER BY updated_at DESC`,
        )
        .all() as ThreadRow[];

      const sessions: UnifiedSession[] = [];

      for (const row of rows) {
        const trimmedTitle = row.title.trim();
        const trimmedFirstMsg = row.first_user_message.trim();

        // 跳过标题和首条消息都为空的会话
        if (!trimmedTitle && !trimmedFirstMsg) {
          continue;
        }

        // 跳过标题是退出命令、且首条消息也是退出命令或为空的会话
        // (如果 title 是 /exit 但 first_user_message 有有意义内容，则保留并用 first_user_message 做标题)
        if (
          INVALID_TITLES.has(trimmedTitle.toLowerCase()) &&
          (!trimmedFirstMsg || INVALID_TITLES.has(trimmedFirstMsg.toLowerCase()))
        ) {
          continue;
        }

        sessions.push({
          id: row.id,
          agent: "codex",
          title: resolveTitle(row.title, row.first_user_message),
          firstMessage: row.first_user_message,
          lastMessage: undefined,
          workingDirectory: row.cwd,
          gitBranch: row.git_branch ?? undefined,
          createdAt: new Date(row.created_at * 1000),
          updatedAt: new Date(row.updated_at * 1000),
          model: row.model_provider,
          status: row.archived ? "archived" : "active",
          resumeCommand: `codex resume ${row.id}`,
          canResume: row.archived === 0,
        });
      }

      return sessions;
    } finally {
      db.close();
    }
  }
}
