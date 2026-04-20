/**
 * 会话删除/归档模块
 *
 * 安全策略：能软删除的绝不硬删除，硬删除前先备份。
 *
 * | Agent       | 方式                            |
 * |-------------|--------------------------------|
 * | Claude Code | 将 .jsonl 移动到回收目录         |
 * | OpenCode    | UPDATE session SET time_archived |
 * | Codex       | UPDATE threads SET archived = 1  |
 * | Cursor      | 先备份 value，再 DELETE          |
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { UnifiedSession } from "../providers/types.js";
import { resolveAgentPath } from "./paths.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const TRASH_DIR = path.join(HOME, ".config", "asm", "trash");

// ---------------------------------------------------------------------------
// 公开接口
// ---------------------------------------------------------------------------

export interface DeleteResult {
  success: boolean;
  message: string;
  /** 软删除/移动后的恢复路径或说明 */
  recoveryHint?: string;
}

/**
 * 删除/归档一个会话
 *
 * @param session 要删除的会话
 * @returns 删除结果
 */
export async function deleteSession(session: UnifiedSession): Promise<DeleteResult> {
  switch (session.agent) {
    case "claude-code":
      return deleteClaudeCodeSession(session);
    case "opencode":
      return deleteOpenCodeSession(session);
    case "codex":
      return deleteCodexSession(session);
    case "cursor":
      return deleteCursorSession(session);
    default:
      return { success: false, message: `不支持的 agent 类型: ${session.agent}` };
  }
}

/**
 * 获取某个 agent 的删除操作描述（用于确认 UI）
 */
export function getDeleteDescription(agent: string): string {
  switch (agent) {
    case "claude-code":
      return "将 .jsonl 会话文件移动到回收目录 (~/.config/asm/trash/claude-code/)";
    case "opencode":
      return "软删除：标记会话为已归档 (time_archived)，不删除数据";
    case "codex":
      return "软删除：标记会话为已归档 (archived=1)，不删除数据";
    case "cursor":
      return "备份会话数据到回收目录后从数据库删除";
    default:
      return "未知操作";
  }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 确保目录存在 */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Claude Code: 移动 .jsonl 到回收目录
// ---------------------------------------------------------------------------

/**
 * 遍历 ~/.claude/projects/ 目录，查找名为 <sessionId>.jsonl 的文件
 */
function findClaudeSessionFile(sessionId: string): string | null {
  const projectsDir = resolveAgentPath("claude-code");
  if (!projectsDir) return null;

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

async function deleteClaudeCodeSession(session: UnifiedSession): Promise<DeleteResult> {
  try {
    const filePath = findClaudeSessionFile(session.id);
    if (!filePath) {
      return {
        success: false,
        message: `找不到 Claude Code 会话文件: ${session.id}`,
      };
    }

    const trashDir = path.join(TRASH_DIR, "claude-code");
    ensureDir(trashDir);

    const destPath = path.join(trashDir, `${session.id}.jsonl`);

    // 如果回收目录已有同名文件，加时间戳后缀
    const finalDest = fs.existsSync(destPath)
      ? path.join(trashDir, `${session.id}_${Date.now()}.jsonl`)
      : destPath;

    fs.renameSync(filePath, finalDest);

    return {
      success: true,
      message: `Claude Code 会话文件已移动到回收目录`,
      recoveryHint: `文件已移动到 ${finalDest}，可手动移回恢复`,
    };
  } catch (err) {
    return {
      success: false,
      message: `删除 Claude Code 会话失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// OpenCode: UPDATE session SET time_archived = <now_ms>
// ---------------------------------------------------------------------------

async function deleteOpenCodeSession(session: UnifiedSession): Promise<DeleteResult> {
  try {
    const dbPath = resolveAgentPath("opencode");
    if (!dbPath || !fs.existsSync(dbPath)) {
      return {
        success: false,
        message: `找不到 OpenCode 数据库`,
      };
    }

    const db = new Database(dbPath);
    try {
      const now = Date.now();
      const result = db
        .prepare(`UPDATE session SET time_archived = ? WHERE id = ?`)
        .run(now, session.id);

      if (result.changes === 0) {
        return {
          success: false,
          message: `OpenCode 数据库中未找到会话: ${session.id}`,
        };
      }

      return {
        success: true,
        message: `OpenCode 会话已归档`,
        recoveryHint: `会话已归档，OpenCode 中不再显示。可通过 SQL 恢复: UPDATE session SET time_archived = NULL WHERE id = '${session.id}'`,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      success: false,
      message: `归档 OpenCode 会话失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Codex: UPDATE threads SET archived = 1, archived_at = <now_unix>
// ---------------------------------------------------------------------------

async function deleteCodexSession(session: UnifiedSession): Promise<DeleteResult> {
  try {
    const dbPath = resolveAgentPath("codex");
    if (!dbPath || !fs.existsSync(dbPath)) {
      return {
        success: false,
        message: `找不到 Codex 数据库`,
      };
    }

    const db = new Database(dbPath);
    try {
      const nowUnix = Math.floor(Date.now() / 1000);
      const result = db
        .prepare(`UPDATE threads SET archived = 1, archived_at = ? WHERE id = ?`)
        .run(nowUnix, session.id);

      if (result.changes === 0) {
        return {
          success: false,
          message: `Codex 数据库中未找到会话: ${session.id}`,
        };
      }

      return {
        success: true,
        message: `Codex 会话已归档`,
        recoveryHint: `会话已归档。可通过 SQL 恢复: UPDATE threads SET archived = 0, archived_at = NULL WHERE id = '${session.id}'`,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      success: false,
      message: `归档 Codex 会话失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Cursor: 备份 value → 回收目录，再 DELETE
// ---------------------------------------------------------------------------

/** cursorDiskKV 表行 */
interface CursorKVRow {
  value: string;
}

async function deleteCursorSession(session: UnifiedSession): Promise<DeleteResult> {
  try {
    const dbPath = resolveAgentPath("cursor");
    if (!dbPath || !fs.existsSync(dbPath)) {
      return {
        success: false,
        message: `找不到 Cursor 数据库`,
      };
    }

    const db = new Database(dbPath);
    try {
      const key = `composerData:${session.id}`;

      // 1. 先读取要备份的 value
      const row = db
        .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
        .get(key) as CursorKVRow | undefined;

      if (!row?.value) {
        return {
          success: false,
          message: `Cursor 数据库中未找到会话: ${session.id}`,
        };
      }

      // 2. 备份到回收目录
      const trashDir = path.join(TRASH_DIR, "cursor");
      ensureDir(trashDir);

      const backupPath = path.join(trashDir, `${session.id}.json`);
      const finalBackup = fs.existsSync(backupPath)
        ? path.join(trashDir, `${session.id}_${Date.now()}.json`)
        : backupPath;

      // 确保写入完整的 JSON（验证格式）
      try {
        JSON.parse(row.value);
      } catch {
        // value 不是有效 JSON 也照样备份原始内容
      }
      fs.writeFileSync(finalBackup, row.value, "utf-8");

      // 3. 验证备份已写入
      if (!fs.existsSync(finalBackup)) {
        return {
          success: false,
          message: `Cursor 会话备份写入失败，已取消删除`,
        };
      }

      // 4. 删除记录
      db.prepare(`DELETE FROM cursorDiskKV WHERE key = ?`).run(key);

      return {
        success: true,
        message: `Cursor 会话已删除（数据已备份）`,
        recoveryHint: `会话数据已备份到 ${finalBackup}`,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      success: false,
      message: `删除 Cursor 会话失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
