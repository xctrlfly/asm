import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UnifiedSession, AgentType } from "../providers/types.js";

// ─── 缓存数据结构 ────────────────────────────────────────────

/** 序列化的会话（Date 转为 ISO string，可直接 JSON 化） */
export interface SerializedSession {
  id: string;
  agent: string;
  title: string;
  firstMessage: string;
  lastMessage?: string;
  workingDirectory: string;
  gitBranch?: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  messageCount?: number;
  model?: string;
  status?: string;
  resumeCommand: string;
  canResume: boolean;
}

/** 单个 provider 的缓存条目 */
export interface ProviderCache {
  /** provider 数据源的标记（用于判断是否有变化） */
  fingerprint: string;
  /** 缓存的会话列表 */
  sessions: SerializedSession[];
  /** 缓存时间 (epoch ms) */
  cachedAt: number;
}

/** 缓存文件顶层结构 */
export interface CacheData {
  version: 1;
  /** 每个 provider 的缓存状态 */
  providers: Record<string, ProviderCache>;
}

// ─── 各 provider 数据源路径 ──────────────────────────────────

const HOME = os.homedir();

/** 各 provider 数据源关键路径 */
const DATA_PATHS: Record<AgentType, string> = {
  "claude-code": path.join(HOME, ".claude", "projects"),
  codex: path.join(HOME, ".codex", "state_5.sqlite"),
  cursor: (() => {
    // macOS: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
    // Linux: ~/.config/Cursor/User/globalStorage/state.vscdb
    if (process.platform === "darwin") {
      return path.join(
        HOME,
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      );
    }
    return path.join(
      HOME,
      ".config",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  })(),
  opencode: path.join(
    HOME,
    "Library",
    "Application Support",
    "ai.opencode.desktop",
    "opencode.global.dat",
  ),
};

/** 缓存文件路径 */
const CACHE_DIR = path.join(HOME, ".config", "asm");
const CACHE_FILE = path.join(CACHE_DIR, "cache.json");

// ─── SessionCache ────────────────────────────────────────────

/**
 * 会话索引缓存
 *
 * 将聚合后的 session 列表缓存到本地 JSON 文件，下次运行时
 * 对比各数据源文件的 mtime，只有发生变化的 provider 才重新扫描。
 */
export class SessionCache {
  private readonly cacheFile: string;

  constructor(cacheFile?: string) {
    this.cacheFile = cacheFile ?? CACHE_FILE;
  }

  // ── 持久化 ──────────────────────────────────────────────

  /** 读取缓存。如果缓存不存在或解析失败，返回空对象 */
  load(): CacheData {
    try {
      const raw = fs.readFileSync(this.cacheFile, "utf-8");
      const data = JSON.parse(raw) as CacheData;
      if (data?.version === 1 && data.providers) {
        return data;
      }
    } catch {
      // 缓存不存在或损坏，静默忽略
    }
    return { version: 1, providers: {} };
  }

  /** 保存缓存到磁盘 */
  save(data: CacheData): void {
    try {
      const dir = path.dirname(this.cacheFile);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(data, null, 2), "utf-8");
    } catch {
      // 写入失败不影响正常功能
    }
  }

  // ── Fingerprint ─────────────────────────────────────────

  /** 获取指定 provider 数据源的当前 fingerprint */
  getFingerprint(agent: AgentType): string {
    try {
      switch (agent) {
        case "claude-code":
          return this.getClaudeCodeFingerprint();
        case "codex":
          return this.getSingleFileFingerprint("codex", DATA_PATHS.codex);
        case "cursor":
          return this.getSingleFileFingerprint("cursor", DATA_PATHS.cursor);
        case "opencode":
          return this.getSingleFileFingerprint("opencode", DATA_PATHS.opencode);
        default:
          return "";
      }
    } catch {
      // 数据源不存在时返回空字符串，与缓存中的 fingerprint 一定不同，
      // 从而触发重新扫描
      return "";
    }
  }

  /**
   * Claude Code fingerprint 策略：
   * 扫描 ~/.claude/projects 下所有直接子目录的 mtime，排序后拼接。
   */
  private getClaudeCodeFingerprint(): string {
    const projectsDir = DATA_PATHS["claude-code"];
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    const mtimes: number[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          const stat = fs.statSync(path.join(projectsDir, entry.name));
          mtimes.push(stat.mtimeMs);
        } catch {
          // 单个目录 stat 失败跳过
        }
      }
    }

    mtimes.sort((a, b) => a - b);
    return `claude-code:${mtimes.join(",")}`;
  }

  /** 单文件数据源的 fingerprint：<agent>:<mtime> */
  private getSingleFileFingerprint(prefix: string, filePath: string): string {
    const stat = fs.statSync(filePath);
    return `${prefix}:${stat.mtimeMs}`;
  }

  // ── 校验 ────────────────────────────────────────────────

  /** 判断某个 provider 的缓存是否仍然有效 */
  isValid(agent: AgentType, cache: ProviderCache): boolean {
    if (!cache || !cache.fingerprint) {
      return false;
    }
    const current = this.getFingerprint(agent);
    // fingerprint 为空说明数据源不可达，缓存无法验证
    if (!current) {
      return false;
    }
    return cache.fingerprint === current;
  }

  // ── 序列化 / 反序列化 ──────────────────────────────────

  /** 将 UnifiedSession 序列化为可 JSON 化的格式 */
  static serializeSessions(sessions: UnifiedSession[]): SerializedSession[] {
    return sessions.map((s) => ({
      id: s.id,
      agent: s.agent,
      title: s.title,
      firstMessage: s.firstMessage,
      lastMessage: s.lastMessage,
      workingDirectory: s.workingDirectory,
      gitBranch: s.gitBranch,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      messageCount: s.messageCount,
      model: s.model,
      status: s.status,
      resumeCommand: s.resumeCommand,
      canResume: s.canResume,
    }));
  }

  /** 从缓存的 SerializedSession 还原为 UnifiedSession（Date 转换） */
  static deserializeSessions(
    sessions: SerializedSession[],
  ): UnifiedSession[] {
    return sessions.map((s) => ({
      id: s.id,
      agent: s.agent as AgentType,
      title: s.title,
      firstMessage: s.firstMessage,
      lastMessage: s.lastMessage,
      workingDirectory: s.workingDirectory,
      gitBranch: s.gitBranch,
      createdAt: new Date(s.createdAt),
      updatedAt: new Date(s.updatedAt),
      messageCount: s.messageCount,
      model: s.model,
      status: s.status,
      resumeCommand: s.resumeCommand,
      canResume: s.canResume,
    }));
  }
}
