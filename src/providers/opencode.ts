import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { SessionProvider, UnifiedSession } from "./types.js";

/**
 * OpenCode 会话数据存储在 ~/Library/Application Support/ai.opencode.desktop/
 *
 * 核心数据源:
 * - opencode.global.dat       → 全局状态 (项目列表、布局、最近会话)
 * - opencode.workspace.*.dat  → 每个 workspace 的状态 (vcs、model、session 等)
 *
 * globalSync.project 包含所有已知项目及其 worktree 路径和时间戳
 * layout.page.lastProjectSession 包含每个项目最后活跃的 session ID
 * workspace dat 文件中的 workspace:vcs 包含 git 分支信息
 * workspace dat 文件中的 workspace:model-selection 包含会话使用的模型
 */

/** Application Support 目录 (macOS) */
const APP_SUPPORT_DIR = path.join(
  os.homedir(),
  "Library/Application Support/ai.opencode.desktop",
);

const GLOBAL_DAT = path.join(APP_SUPPORT_DIR, "opencode.global.dat");

/** globalSync.project 中的项目条目 */
interface ProjectEntry {
  id: string;
  worktree: string;
  vcs?: string;
  icon?: { color?: string };
  time: {
    created: number;
    updated: number;
    initialized?: number;
  };
  sandboxes?: string[];
}

/** layout.page.lastProjectSession 中的条目 */
interface LastSessionEntry {
  directory: string;
  id: string;
  at: number;
}

/** workspace:vcs 解析后的值 */
interface VcsValue {
  value?: {
    branch?: string;
    default_branch?: string;
  };
}

/** workspace:model-selection 解析后的值 */
interface ModelSelection {
  session?: Record<
    string,
    {
      agent?: string;
      model?: { providerID?: string; modelID?: string };
      variant?: string | null;
    }
  >;
}

/** workspace dat 文件中的 session 信息 */
interface WorkspaceSessionInfo {
  sessionIds: string[];
  gitBranch?: string;
  defaultBranch?: string;
  modelId?: string;
}

/**
 * 安全解析 JSON 字符串，失败返回 undefined
 */
function safeParseJson<T>(raw: unknown): T | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * 安全读取并解析 JSON 文件
 */
function readJsonFile<T = Record<string, unknown>>(
  filePath: string,
): T | undefined {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return undefined;
  }
}

/**
 * 从 workspace dat 文件名中尝试推断 worktree 路径前缀
 *
 * 文件名格式: opencode.workspace.<encoded_path>.<hash>.dat
 * 其中 encoded_path 可能是:
 * - base64 编码 (如 L1VzZXJz → /Users)
 * - 短横线分隔路径 (如 -Users-john → /Users/john)
 * 两者都是截断的，无法得到完整路径
 */
function decodeWorkspaceFilename(filename: string): {
  pathPrefix: string;
  hash: string;
} {
  // 去掉 opencode.workspace. 前缀和 .dat 后缀
  const stripped = filename
    .replace(/^opencode\.workspace\./, "")
    .replace(/\.dat$/, "");

  // 最后一个 . 之后是 hash
  const lastDot = stripped.lastIndexOf(".");
  if (lastDot === -1) {
    return { pathPrefix: "", hash: stripped };
  }

  const encoded = stripped.substring(0, lastDot);
  const hash = stripped.substring(lastDot + 1);

  let pathPrefix = "";

  if (encoded.startsWith("-")) {
    // 短横线分隔路径: -Users-john → /Users/john
    pathPrefix = encoded.replace(/-/g, "/");
  } else {
    // 尝试 base64 解码
    try {
      // 补齐 base64 padding
      const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
      pathPrefix = Buffer.from(padded, "base64").toString("utf-8");
    } catch {
      pathPrefix = encoded;
    }
  }

  return { pathPrefix, hash };
}

/**
 * 解析 workspace dat 文件，提取 session ID、vcs 和 model 信息
 */
function parseWorkspaceDat(filePath: string): WorkspaceSessionInfo | undefined {
  const data = readJsonFile<Record<string, string>>(filePath);
  if (!data) return undefined;

  // 提取所有 session ID (from keys like "session:<id>:comments")
  const sessionIds = new Set<string>();
  for (const key of Object.keys(data)) {
    const match = key.match(/^session:(ses_[^:]+):/);
    if (match) {
      sessionIds.add(match[1]);
    }
  }

  // 解析 VCS 信息
  let gitBranch: string | undefined;
  let defaultBranch: string | undefined;
  const vcsRaw = data["workspace:vcs"];
  if (vcsRaw) {
    const vcs = safeParseJson<VcsValue>(vcsRaw);
    gitBranch = vcs?.value?.branch;
    defaultBranch = vcs?.value?.default_branch;
  }

  // 解析 model 信息 (取第一个 session 的 model)
  let modelId: string | undefined;
  const modelRaw = data["workspace:model-selection"];
  if (modelRaw) {
    const modelSel = safeParseJson<ModelSelection>(modelRaw);
    if (modelSel?.session) {
      const firstSession = Object.values(modelSel.session)[0];
      if (firstSession?.model?.modelID) {
        modelId = firstSession.model.modelID;
      }
    }
  }

  return {
    sessionIds: [...sessionIds],
    gitBranch,
    defaultBranch,
    modelId,
  };
}

/**
 * 将 worktree 路径缩短为显示用的短路径
 * /Users/john/Projects/my-app → my-app
 * /Users/john/Work → Work
 */
function shortPath(worktree: string): string {
  return path.basename(worktree) || worktree;
}

export class OpenCodeProvider implements SessionProvider {
  readonly name = "opencode" as const;
  readonly displayName = "OpenCode";

  async isAvailable(): Promise<boolean> {
    return fs.existsSync(APP_SUPPORT_DIR);
  }

  async getSessions(): Promise<UnifiedSession[]> {
    if (!fs.existsSync(GLOBAL_DAT)) {
      return [];
    }

    const globalData = readJsonFile<Record<string, string>>(GLOBAL_DAT);
    if (!globalData) {
      return [];
    }

    // 1. 解析项目列表 (来源: globalSync.project)
    const projectSync = safeParseJson<{ value?: ProjectEntry[] }>(
      globalData["globalSync.project"],
    );
    const projects = projectSync?.value ?? [];

    // 2. 解析最近会话映射 (来源: layout.page.lastProjectSession)
    const layoutPage = safeParseJson<{
      lastProjectSession?: Record<string, LastSessionEntry>;
    }>(globalData["layout.page"]);
    const lastSessions = layoutPage?.lastProjectSession ?? {};

    // 3. 扫描所有 workspace dat 文件，建立 hash → 解析结果 映射
    const workspaceDats = new Map<string, WorkspaceSessionInfo>();
    const hashToFileStat = new Map<string, fs.Stats>();

    try {
      const files = fs.readdirSync(APP_SUPPORT_DIR);
      for (const file of files) {
        if (
          !file.startsWith("opencode.workspace.") ||
          !file.endsWith(".dat") ||
          file === "opencode.global.dat"
        ) {
          continue;
        }

        const filePath = path.join(APP_SUPPORT_DIR, file);
        const { hash } = decodeWorkspaceFilename(file);
        const parsed = parseWorkspaceDat(filePath);

        if (parsed) {
          workspaceDats.set(hash, parsed);
          try {
            hashToFileStat.set(hash, fs.statSync(filePath));
          } catch {
            // ignore stat errors
          }
        }
      }
    } catch {
      return [];
    }

    // 4. 为每个有意义的项目建立会话
    //    策略: 从 globalSync.project 出发，匹配 workspace dat
    //    通过 lastProjectSession 中的 session ID 关联 workspace dat
    const sessions: UnifiedSession[] = [];

    // 建立 sessionId → hash 的反向映射
    const sessionIdToHash = new Map<string, string>();
    for (const [hash, info] of workspaceDats) {
      for (const sid of info.sessionIds) {
        sessionIdToHash.set(sid, hash);
      }
    }

    for (const project of projects) {
      // 跳过 global 根目录项目
      if (project.id === "global" || project.worktree === "/") {
        continue;
      }

      const worktree = project.worktree;
      const lastSession = lastSessions[worktree];

      // 尝试通过 lastSession 找到对应的 workspace dat
      let workspaceInfo: WorkspaceSessionInfo | undefined;
      let workspaceHash: string | undefined;

      if (lastSession) {
        workspaceHash = sessionIdToHash.get(lastSession.id);
        if (workspaceHash) {
          workspaceInfo = workspaceDats.get(workspaceHash);
        }
      }

      // 如果通过 lastSession 没有找到 workspace dat，
      // 尝试遍历所有 dat，找到包含该项目 session 的那个
      if (!workspaceInfo) {
        for (const [hash, info] of workspaceDats) {
          // 只要有 vcs 信息就可能是这个项目的 workspace
          // 但这不够精确，暂时跳过
          if (info.sessionIds.length > 0) {
            // 看看 notification 中能否确认
            continue;
          }
        }
      }

      // 确定 git 分支 — 优先用 workspace dat 里的
      let gitBranch = workspaceInfo?.gitBranch;

      // 如果 workspace dat 没有 vcs 信息，也尝试从其他没有 session 的 dat 文件中找
      // (有些 dat 文件只包含 workspace:vcs，没有 session keys)
      if (!gitBranch) {
        for (const [hash, info] of workspaceDats) {
          if (info.sessionIds.length === 0 && info.gitBranch) {
            // 无法精确匹配，但如果只有一个候选，就用它
            // 实际上我们无法确认这个 dat 属于哪个项目
            // 暂时跳过非精确匹配
          }
        }
      }

      // 确定时间戳
      let createdAt: Date;
      let updatedAt: Date;

      if (project.time) {
        createdAt = new Date(project.time.created);
        updatedAt = new Date(project.time.updated);
      } else if (workspaceHash && hashToFileStat.has(workspaceHash)) {
        const stat = hashToFileStat.get(workspaceHash)!;
        createdAt = stat.birthtime;
        updatedAt = stat.mtime;
      } else {
        createdAt = new Date();
        updatedAt = new Date();
      }

      // 如果有 lastSession.at 时间戳，用它作为 updatedAt (更精确)
      if (lastSession?.at) {
        updatedAt = new Date(lastSession.at);
      }

      // 确定模型
      const model = workspaceInfo?.modelId;

      // 确定 session ID
      const sessionId = lastSession?.id ?? `workspace-${project.id}`;

      // 标题: 项目目录名 + git 分支 (如有)
      const dirName = shortPath(worktree);
      const branchHint = gitBranch && gitBranch !== "main" && gitBranch !== "master"
        ? ` (${gitBranch})`
        : "";
      const title = dirName + branchHint;

      sessions.push({
        id: sessionId,
        agent: "opencode",
        title,
        firstMessage: "",
        lastMessage: undefined,
        workingDirectory: worktree,
        gitBranch: gitBranch ?? undefined,
        createdAt,
        updatedAt,
        model,
        status: "active",
        resumeCommand: "opencode",
        canResume: true,
      });
    }

    // 5. 补充: 处理有 workspace dat 但没有出现在 globalSync.project 中的孤立文件
    const coveredHashes = new Set<string>();
    for (const session of sessions) {
      const hash = sessionIdToHash.get(session.id);
      if (hash) coveredHashes.add(hash);
    }

    for (const [hash, info] of workspaceDats) {
      if (coveredHashes.has(hash)) continue;
      // 如果这个 dat 没有 session 也没有 vcs，跳过
      if (info.sessionIds.length === 0 && !info.gitBranch) continue;

      // 尝试从文件名推断路径
      // 找到对应的文件名
      let datFilename = "";
      try {
        const files = fs.readdirSync(APP_SUPPORT_DIR);
        for (const file of files) {
          if (file.includes(`.${hash}.dat`)) {
            datFilename = file;
            break;
          }
        }
      } catch {
        continue;
      }

      if (!datFilename) continue;

      const { pathPrefix } = decodeWorkspaceFilename(datFilename);
      const stat = hashToFileStat.get(hash);

      const orphanDir = pathPrefix || "";

      // 跳过路径不完整或不存在的孤立 workspace
      // (文件名编码信息不足，无法确定完整路径)
      if (!orphanDir || !fs.existsSync(orphanDir)) {
        continue;
      }

      const orphanDirName = path.basename(orphanDir) || orphanDir;
      const orphanBranchHint = info.gitBranch && info.gitBranch !== "main" && info.gitBranch !== "master"
        ? ` (${info.gitBranch})`
        : "";

      sessions.push({
        id: info.sessionIds[0] ?? `workspace-${hash}`,
        agent: "opencode",
        title: orphanDirName + orphanBranchHint,
        firstMessage: "",
        lastMessage: undefined,
        workingDirectory: orphanDir,
        gitBranch: info.gitBranch,
        createdAt: stat?.birthtime ?? new Date(),
        updatedAt: stat?.mtime ?? new Date(),
        model: info.modelId,
        status: "active",
        resumeCommand: "opencode",
        canResume: true,
      });
    }

    // 按 updatedAt 降序排列
    sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    return sessions;
  }
}
