import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import type { SessionProvider, UnifiedSession } from "./types.js";
import { resolveAgentPath } from "../core/paths.js";

// ---------------------------------------------------------------------------
// 路径工具
// ---------------------------------------------------------------------------

/**
 * 从全局 DB 路径反推 Cursor User 数据目录。
 * 例: .../Cursor/User/globalStorage/state.vscdb → .../Cursor/User
 */
function getUserDirFromDbPath(dbPath: string): string {
  // dbPath 格式: <userDir>/globalStorage/state.vscdb
  return path.dirname(path.dirname(dbPath));
}

function getWorkspaceStorageDir(userDir: string): string {
  return path.join(userDir, "workspaceStorage");
}

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

/** cursorDiskKV 表行 */
interface KVRow {
  key: string;
  value: string;
}

/** composer.composerData 中 selectedComposerIds 等映射 */
interface WorkspaceComposerMeta {
  selectedComposerIds?: string[];
  lastFocusedComposerIds?: string[];
  allComposerIds?: string[];
  [key: string]: unknown;
}

/** composerData value 中我们关心的字段 (宽松类型，防止结构变动) */
interface ComposerRaw {
  composerId?: string;
  name?: string | null;
  status?: string;
  createdAt?: number | null;
  lastUpdatedAt?: number | null;
  conversation?: unknown[];
  fullConversationHeadersOnly?: unknown[];
  context?: {
    workspaceDirectory?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** conversation 中单条消息的最小结构 */
interface ConversationBubble {
  type?: number; // 1 = human, 2 = AI (常见约定)
  text?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 安全解析 JSON，失败返回 undefined
 */
function safeParse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * 在 conversation 数组中找第一条 / 最后一条人类消息文本。
 *
 * 为了性能，不深度遍历整个数组:
 * - firstMessage: 从前向后最多扫 20 条
 * - lastMessage: 从后向前最多扫 20 条
 */
function extractUserMessages(conversation: unknown[]): {
  first: string;
  last: string;
} {
  const SCAN_LIMIT = 20;

  let first = "";
  let last = "";

  // 向前扫
  const forwardLen = Math.min(conversation.length, SCAN_LIMIT);
  for (let i = 0; i < forwardLen; i++) {
    const bubble = conversation[i] as ConversationBubble | undefined;
    if (bubble && bubble.type === 1 && typeof bubble.text === "string" && bubble.text.trim()) {
      first = bubble.text.trim();
      break;
    }
  }

  // 向后扫
  const backwardStart = Math.max(0, conversation.length - SCAN_LIMIT);
  for (let i = conversation.length - 1; i >= backwardStart; i--) {
    const bubble = conversation[i] as ConversationBubble | undefined;
    if (bubble && bubble.type === 1 && typeof bubble.text === "string" && bubble.text.trim()) {
      last = bubble.text.trim();
      break;
    }
  }

  return { first, last };
}

/**
 * 从 name / firstMessage / workingDirectory 解析显示标题
 */
function resolveTitle(
  name: string | null | undefined,
  firstMessage: string,
  workingDirectory?: string,
): string {
  if (name && name.trim()) {
    return name.trim();
  }
  if (firstMessage) {
    const oneLine = firstMessage.replace(/\n/g, " ").trim();
    return oneLine.length > 80 ? oneLine.slice(0, 80) + "..." : oneLine;
  }
  // name 和 firstMessage 都为空时，用目录名作为 fallback
  if (workingDirectory) {
    return `Untitled [${path.basename(workingDirectory)}]`;
  }
  return "Untitled";
}

// ---------------------------------------------------------------------------
// Workspace 映射构建
// ---------------------------------------------------------------------------

/**
 * 遍历 workspaceStorage，构建 composerId → folder 映射。
 *
 * 1. 读取每个 <hash>/workspace.json → folder URI
 * 2. 读取每个 <hash>/state.vscdb ItemTable → composer.composerData key
 *    拿到该 workspace 关联的 composerIds
 * 3. 将 composerId → folder 进行反向映射
 */
function buildComposerToFolderMap(userDir: string): Map<string, string> {
  const result = new Map<string, string>();

  const wsDir = getWorkspaceStorageDir(userDir);
  if (!fs.existsSync(wsDir)) {
    return result;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(wsDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const wsPath = path.join(wsDir, entry.name);

    // 1) 读取 folder
    const workspaceJsonPath = path.join(wsPath, "workspace.json");
    let folder: string | undefined;
    try {
      if (fs.existsSync(workspaceJsonPath)) {
        const raw = fs.readFileSync(workspaceJsonPath, "utf-8");
        const parsed = safeParse<{ folder?: string }>(raw);
        if (parsed?.folder) {
          // 去掉 file:// 前缀
          folder = parsed.folder.replace(/^file:\/\//, "");
        }
      }
    } catch {
      // ignore
    }

    if (!folder) continue;

    // 2) 读取该 workspace 的 state.vscdb
    const wsDbPath = path.join(wsPath, "state.vscdb");
    if (!fs.existsSync(wsDbPath)) continue;

    let db: InstanceType<typeof Database> | undefined;
    try {
      db = new Database(wsDbPath, { readonly: true });

      // 尝试从 ItemTable 表读取
      const row = db
        .prepare(
          `SELECT value FROM ItemTable WHERE key = 'composer.composerData'`,
        )
        .get() as { value: string } | undefined;

      if (row?.value) {
        const meta = safeParse<WorkspaceComposerMeta>(row.value);
        if (meta) {
          // 收集所有能找到的 composerIds
          const ids = new Set<string>();
          for (const id of meta.allComposerIds ?? []) ids.add(id);
          for (const id of meta.selectedComposerIds ?? []) ids.add(id);
          for (const id of meta.lastFocusedComposerIds ?? []) ids.add(id);

          for (const id of ids) {
            result.set(id, folder);
          }
        }
      }
    } catch {
      // DB 打不开或表不存在，跳过
    } finally {
      db?.close();
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// CursorProvider
// ---------------------------------------------------------------------------

export class CursorProvider implements SessionProvider {
  readonly name = "cursor" as const;
  readonly displayName = "Cursor";

  private readonly customPath?: string;

  constructor(dataPath?: string) {
    this.customPath = dataPath;
  }

  /** 动态解析全局 DB 路径 */
  private resolveDataPath(): string | null {
    return resolveAgentPath("cursor", this.customPath);
  }

  async isAvailable(): Promise<boolean> {
    return this.resolveDataPath() !== null;
  }

  async getSessions(): Promise<UnifiedSession[]> {
    const globalDbPath = this.resolveDataPath();
    if (!globalDbPath) {
      return [];
    }

    // --- 构建 composerId → folder 映射 (来自 workspace 侧) ---
    const userDir = getUserDirFromDbPath(globalDbPath);
    const composerToFolder = buildComposerToFolderMap(userDir);

    // --- 从全局 DB 读取所有 composerData:* ---
    let db: InstanceType<typeof Database>;
    try {
      db = new Database(globalDbPath, { readonly: true });
    } catch {
      return [];
    }

    try {
      const rows = db
        .prepare(
          `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'`,
        )
        .all() as KVRow[];

      const sessions: UnifiedSession[] = [];

      for (const row of rows) {
        const data = safeParse<ComposerRaw>(row.value);
        if (!data) continue;

        const composerId = data.composerId;
        if (!composerId) continue;

        // 跳过无创建时间的
        if (data.createdAt == null) continue;

        const conversation = Array.isArray(data.conversation)
          ? data.conversation
          : [];
        const headersOnly = Array.isArray(data.fullConversationHeadersOnly)
          ? data.fullConversationHeadersOnly
          : [];

        const name = data.name ?? null;

        // 过滤规则: 跳过 name 为空且 conversation 为空的
        const hasName = typeof name === "string" && name.trim().length > 0;
        const hasConversation = conversation.length > 0;
        if (!hasName && !hasConversation) continue;

        // 提取用户消息
        const { first, last } = hasConversation
          ? extractUserMessages(conversation)
          : { first: "", last: "" };

        // 工作目录: 优先 workspace 映射，其次 context.workspaceDirectory
        let workingDirectory =
          composerToFolder.get(composerId) ??
          data.context?.workspaceDirectory ??
          "";
        // 去掉可能残留的 file:// 前缀
        if (workingDirectory.startsWith("file://")) {
          workingDirectory = workingDirectory.replace(/^file:\/\//, "");
        }

        const title = resolveTitle(name, first, workingDirectory);

        // 消息数: 优先 conversation，其次 headersOnly
        const messageCount =
          conversation.length > 0
            ? conversation.length
            : headersOnly.length > 0
              ? headersOnly.length
              : undefined;

        const createdAt = new Date(data.createdAt);
        const updatedAt = new Date(data.lastUpdatedAt ?? data.createdAt);

        // workingDirectory 为空时无法打开项目，不提供 resume 能力
        const hasWorkDir = workingDirectory.length > 0;
        const resumeCommand = hasWorkDir ? `cursor ${workingDirectory}` : "";

        sessions.push({
          id: composerId,
          agent: "cursor",
          title,
          firstMessage: first,
          lastMessage: last || undefined,
          workingDirectory,
          createdAt,
          updatedAt,
          messageCount,
          status: data.status ?? undefined,
          resumeCommand,
          canResume: hasWorkDir,
        });
      }

      // 按 updatedAt 降序排列
      sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

      return sessions;
    } finally {
      db.close();
    }
  }
}
