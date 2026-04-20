/**
 * 统一会话模型和 Provider 接口定义
 */

/** 支持的 Agent 类型 */
export type AgentType = "claude-code" | "opencode" | "codex" | "cursor";

/** Agent 显示配置 */
export interface AgentConfig {
  type: AgentType;
  displayName: string;
  color: string; // chalk 颜色名
  icon: string; // 终端 badge
}

/** 已知 Agent 配置表 */
export const AGENT_CONFIGS: Record<AgentType, AgentConfig> = {
  "claude-code": {
    type: "claude-code",
    displayName: "Claude Code",
    color: "magenta",
    icon: "CC",
  },
  opencode: {
    type: "opencode",
    displayName: "OpenCode",
    color: "cyan",
    icon: "OC",
  },
  codex: {
    type: "codex",
    displayName: "Codex",
    color: "green",
    icon: "CX",
  },
  cursor: {
    type: "cursor",
    displayName: "Cursor",
    color: "blue",
    icon: "CR",
  },
};

/** 统一会话数据模型 */
export interface UnifiedSession {
  /** 原始 session ID */
  id: string;
  /** Agent 类型 */
  agent: AgentType;
  /** 会话名称/主题 (优先 name > first_msg 截断) */
  title: string;
  /** 首条用户消息 (完整内容) */
  firstMessage: string;
  /** 最后一条用户消息 */
  lastMessage?: string;
  /** 工作目录 */
  workingDirectory: string;
  /** Git 分支 */
  gitBranch?: string;
  /** 创建时间 */
  createdAt: Date;
  /** 最后活动时间 */
  updatedAt: Date;
  /** 消息数量 */
  messageCount?: number;
  /** 使用的模型 */
  model?: string;
  /** 会话状态 */
  status?: string;
  /** 恢复命令 (完整的 shell 命令) */
  resumeCommand: string;
  /** 是否支持恢复 */
  canResume: boolean;
}

/** Session Provider 接口 - 每个 Agent 实现一个 */
export interface SessionProvider {
  /** Agent 类型标识 */
  readonly name: AgentType;
  /** 显示名称 */
  readonly displayName: string;
  /** 检测该 Agent 是否可用 (已安装/有数据) */
  isAvailable(): Promise<boolean>;
  /** 获取所有会话 */
  getSessions(): Promise<UnifiedSession[]>;
}

/** 搜索/过滤选项 */
export interface FilterOptions {
  /** 按 Agent 类型过滤 */
  agent?: AgentType | AgentType[];
  /** 按工作目录前缀过滤 */
  directory?: string;
  /** 按时间过滤 (只返回此时间之后的会话) */
  since?: Date;
  /** 关键词搜索 */
  keyword?: string;
  /** 每页数量限制 */
  limit?: number;
}
