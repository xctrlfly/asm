import fs from "node:fs";
import Database from "better-sqlite3";
import type { SessionProvider, UnifiedSession } from "./types.js";
import { resolveAgentPath } from "../core/paths.js";

/**
 * OpenCode CLI 会话数据存储在 ~/.local/share/opencode/opencode.db (SQLite)
 *
 * 核心表:
 * - session: 会话列表 (id, title, directory, project_id, time_created, time_updated, time_archived)
 * - message: 消息列表 (id, session_id, data JSON, time_created)
 * - project: 项目列表 (id, worktree, vcs)
 * - workspace: 工作区 (id, branch, directory, project_id)
 */

interface SessionRow {
  id: string;
  title: string;
  directory: string;
  project_id: string;
  time_created: number; // ms timestamp
  time_updated: number; // ms timestamp
  time_archived: number | null;
  worktree: string | null;
  branch: string | null;
}

export class OpenCodeProvider implements SessionProvider {
  readonly name = "opencode" as const;
  readonly displayName = "OpenCode";

  private readonly customPath?: string;

  constructor(dataPath?: string) {
    this.customPath = dataPath;
  }

  /** 动态解析数据库路径 */
  private resolveDataPath(): string | null {
    return resolveAgentPath("opencode", this.customPath);
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
      return [];
    }

    try {
      const rows = db
        .prepare(
          `SELECT
             s.id,
             s.title,
             s.directory,
             s.project_id,
             s.time_created,
             s.time_updated,
             s.time_archived,
             p.worktree,
             w.branch
           FROM session s
           LEFT JOIN project p ON s.project_id = p.id
           LEFT JOIN workspace w ON s.workspace_id = w.id
           WHERE s.time_archived IS NULL
           ORDER BY s.time_updated DESC`,
        )
        .all() as SessionRow[];

      return rows
        .filter((row) => {
          // 跳过空标题的会话
          if (!row.title || row.title.trim() === "") return false;
          // 跳过 subagent 内部会话
          if (row.title.includes("@general subagent")) return false;
          if (row.title.includes("(@")) return false;
          return true;
        })
        .map((row) => {
          const workingDirectory = row.directory || row.worktree || "";

          return {
            id: row.id,
            agent: "opencode" as const,
            title: row.title,
            firstMessage: "",
            lastMessage: undefined,
            workingDirectory,
            gitBranch: row.branch ?? undefined,
            createdAt: new Date(row.time_created),
            updatedAt: new Date(row.time_updated),
            messageCount: undefined,
            model: undefined,
            status: "active",
            resumeCommand: `opencode --session ${row.id}`,
            canResume: true,
          };
        });
    } catch {
      return [];
    } finally {
      db.close();
    }
  }
}
