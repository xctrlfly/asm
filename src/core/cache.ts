import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UnifiedSession, AgentType } from "../providers/types.js";
import { resolveAgentPath } from "./paths.js";

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

/** 用户自定义路径映射类型 */
export type AgentPaths = Partial<Record<AgentType, string>>;

/** 缓存文件路径 */
const CACHE_FILE = path.join(HOME, ".config", "asm", "cache.json");

// ─── SessionCache ────────────────────────────────────────────

/**
 * 会话索引缓存
 *
 * 将聚合后的 session 列表缓存到本地 JSON 文件，下次运行时
 * 对比各数据源文件的 mtime，只有发生变化的 provider 才重新扫描。
 */
export class SessionCache {
  private readonly cacheFile: string;
  private readonly agentPaths: AgentPaths;

  constructor(cacheFile?: string, agentPaths?: AgentPaths) {
    this.cacheFile = cacheFile ?? CACHE_FILE;
    this.agentPaths = agentPaths ?? {};
  }

  /** 动态解析指定 agent 的数据路径 */
  private resolveDataPath(agent: AgentType): string | null {
    return resolveAgentPath(agent, this.agentPaths[agent]);
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
      const resolved = this.resolveDataPath(agent);
      if (!resolved) return "";

      switch (agent) {
        case "claude-code":
          return this.getClaudeCodeFingerprint(resolved);
        case "codex":
          return this.getSingleFileFingerprint("codex", resolved);
        case "cursor":
          return this.getSingleFileFingerprint("cursor", resolved);
        case "opencode":
          return this.getSingleFileFingerprint("opencode", resolved);
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
   * 对每个子目录，取子目录 mtime 和其中最新 .jsonl 文件 mtime 的较大值。
   * 这样无论是新增会话（子目录 mtime 变）还是现有会话被追加写入
   * （JSONL 文件 mtime 变），都能检测到变化。
   */
  private getClaudeCodeFingerprint(projectsDir: string): string {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    const signals: number[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const dirPath = path.join(projectsDir, entry.name);
        const dirMtime = fs.statSync(dirPath).mtimeMs;

        // 找该目录下最新的 .jsonl 文件 mtime
        let latestFile = 0;
        try {
          const files = fs.readdirSync(dirPath);
          for (const f of files) {
            if (!f.endsWith(".jsonl")) continue;
            try {
              const fstat = fs.statSync(path.join(dirPath, f));
              if (fstat.mtimeMs > latestFile) latestFile = fstat.mtimeMs;
            } catch { /* skip */ }
          }
        } catch { /* skip */ }

        signals.push(Math.max(dirMtime, latestFile));
      } catch {
        // 单个目录 stat 失败跳过
      }
    }

    signals.sort((a, b) => a - b);
    return `claude-code:${signals.join(",")}`;
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
