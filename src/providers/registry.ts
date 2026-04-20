import type { SessionProvider, AgentType } from "./types.js";

/**
 * Provider 注册中心
 *
 * 管理所有已注册的 SessionProvider，并提供可用性查询。
 */
export class ProviderRegistry {
  private providers: SessionProvider[] = [];

  /** 注册一个 Provider */
  register(provider: SessionProvider): void {
    this.providers.push(provider);
  }

  /** 获取所有已注册的 Provider */
  getProviders(): SessionProvider[] {
    return [...this.providers];
  }

  /** 获取所有 isAvailable() 为 true 的 Provider */
  async getAvailableProviders(): Promise<SessionProvider[]> {
    const results = await Promise.all(
      this.providers.map(async (p) => ({
        provider: p,
        available: await p.isAvailable(),
      })),
    );
    return results.filter((r) => r.available).map((r) => r.provider);
  }

  /** 按 agent 类型获取 Provider */
  getByName(name: AgentType): SessionProvider | undefined {
    return this.providers.find((p) => p.name === name);
  }

  /** 已注册的 Provider 数量 */
  get size(): number {
    return this.providers.length;
  }
}
