import Fuse from "fuse.js";
import type { UnifiedSession, FilterOptions, AgentType } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/registry.js";

/**
 * 会话聚合器
 *
 * 从所有可用 Provider 并行收集会话，合并后支持过滤、排序、模糊搜索。
 */
export class SessionAggregator {
  constructor(private registry: ProviderRegistry) {}

  /**
   * 从所有可用 Provider 并行获取会话，按 updatedAt 倒序排序
   */
  async getAllSessions(): Promise<UnifiedSession[]> {
    const providers = await this.registry.getAvailableProviders();

    const results = await Promise.allSettled(
      providers.map((p) => p.getSessions()),
    );

    const sessions: UnifiedSession[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        sessions.push(...result.value);
      }
      // rejected 的 provider 静默忽略，避免一个 provider 失败影响全局
    }

    // 按 updatedAt 倒序
    sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    return sessions;
  }

  /**
   * 获取会话并应用 FilterOptions 过滤
   */
  async getFilteredSessions(options: FilterOptions = {}): Promise<UnifiedSession[]> {
    let sessions = await this.getAllSessions();
    sessions = applyFilters(sessions, options);
    return sessions;
  }
}

/**
 * 对已有会话列表应用过滤条件（纯函数，也可独立使用）
 */
export function applyFilters(
  sessions: UnifiedSession[],
  options: FilterOptions,
): UnifiedSession[] {
  let result = sessions;

  // 按 Agent 类型过滤
  if (options.agent) {
    const agents: AgentType[] = Array.isArray(options.agent)
      ? options.agent
      : [options.agent];
    result = result.filter((s) => agents.includes(s.agent));
  }

  // 按目录前缀过滤
  if (options.directory) {
    const dir = options.directory;
    result = result.filter(
      (s) => s.workingDirectory && s.workingDirectory.startsWith(dir),
    );
  }

  // 按时间过滤
  if (options.since) {
    const since = options.since.getTime();
    result = result.filter((s) => s.updatedAt.getTime() >= since);
  }

  // 关键词模糊搜索
  if (options.keyword && options.keyword.trim()) {
    result = fuzzySearch(result, options.keyword.trim());
  }

  // 数量限制
  if (options.limit && options.limit > 0) {
    result = result.slice(0, options.limit);
  }

  return result;
}

/**
 * 使用 fuse.js 进行模糊搜索
 */
function fuzzySearch(
  sessions: UnifiedSession[],
  keyword: string,
): UnifiedSession[] {
  if (sessions.length === 0) return [];

  const fuse = new Fuse(sessions, {
    keys: [
      { name: "title", weight: 0.4 },
      { name: "firstMessage", weight: 0.3 },
      { name: "workingDirectory", weight: 0.2 },
      { name: "gitBranch", weight: 0.1 },
    ],
    threshold: 0.4,
    includeScore: true,
    ignoreLocation: true,
  });

  return fuse.search(keyword).map((r) => r.item);
}
