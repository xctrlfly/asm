# 贡献指南

感谢你有兴趣为 asm 做贡献！本指南帮助你快速上手。

## 开发环境

```bash
git clone https://github.com/xctrlfly/asm.git
cd agent-sessions-manager
npm install
npm run build     # 构建一次
npm run dev       # 监听模式构建
npm link          # 全局安装 `asm` 用于测试
```

## 项目结构

```
src/
├── cli.tsx                 # CLI 入口（Commander.js，7 个子命令 + 缓存集成）
├── core/
│   ├── aggregator.ts       # 会话聚合 + fuse.js 模糊搜索
│   ├── cache.ts            # 基于 mtime 的增量缓存（~/.config/asm/cache.json）
│   ├── config.ts           # 配置文件管理（~/.config/asm/config.json）
│   ├── deleter.ts          # 安全删除/归档会话 + 回收站（~/.config/asm/trash/）
│   ├── history.ts          # 各 agent 的对话历史提取
│   ├── opener.ts           # cd + resume 命令执行
│   └── paths.ts            # 动态数据路径检测（多候选 + 环境变量 + 平台适配）
├── providers/
│   ├── types.ts            # UnifiedSession 模型 + SessionProvider 接口 + AgentConfig
│   ├── claude-code.ts      # Claude Code provider（JSONL 流式解析）
│   ├── codex.ts            # Codex provider（SQLite threads 表）
│   ├── cursor.ts           # Cursor provider（SQLite + workspace 映射）
│   ├── opencode.ts         # OpenCode provider（SQLite session 表）
│   └── registry.ts         # Provider 注册中心 + 可用性检测
└── ui/
    └── App.tsx             # 交互式 TUI（Ink / React）
```

## 添加新的 Agent Provider

这是最常见的贡献类型。以下是完整的步骤：

### 第 1 步：创建 Provider 文件

创建 `src/providers/<agent-名称>.ts`，实现 `SessionProvider` 接口：

```typescript
import type { SessionProvider, UnifiedSession } from "./types.js";

export class MyAgentProvider implements SessionProvider {
  readonly name = "my-agent" as const;
  readonly displayName = "My Agent";

  async isAvailable(): Promise<boolean> {
    // 检查该 agent 的数据文件是否存在
  }

  async getSessions(): Promise<UnifiedSession[]> {
    // 读取 agent 的会话数据，映射为 UnifiedSession[]
  }
}
```

你需要搞清楚：
- **数据在哪**：agent 把会话存在什么路径、什么格式（SQLite / JSON / JSONL / 其他）
- **有哪些元数据**：标题、时间戳、工作目录、git 分支、消息内容
- **如何恢复**：从命令行恢复会话的具体命令（作为 `resumeCommand` 字段的值）

### 第 2 步：注册 Provider

在 `src/cli.tsx` 中导入并注册：

```typescript
import { MyAgentProvider } from "./providers/my-agent.js";

// 在 createRegistry() 函数中：
if (!disabled.has("my-agent")) registry.register(new MyAgentProvider(paths["my-agent"]));
```

注意：provider 构造函数接受可选的 `dataPath` 参数，用于用户自定义路径覆盖默认检测。

### 第 3 步：添加类型和配置

在 `src/providers/types.ts` 中：

```typescript
// 添加到 AgentType 联合类型
export type AgentType = "claude-code" | "opencode" | "codex" | "cursor" | "my-agent";

// 添加到 AGENT_CONFIGS
export const AGENT_CONFIGS: Record<AgentType, AgentConfig> = {
  // ...已有 agent...
  "my-agent": {
    type: "my-agent",
    displayName: "My Agent",
    color: "red",    // chalk 颜色名
    icon: "MA",      // 2 字符标识
  },
};
```

### 第 4 步：添加历史支持（可选）

在 `src/core/history.ts` 的 `getSessionHistory()` 中添加对应的 case。

### 第 5 步：添加删除支持

在 `src/core/deleter.ts` 的 `deleteSession()` 中添加对应的删除策略（归档/移到回收站）。

### 第 6 步：添加路径候选

在 `src/core/paths.ts` 的 `getAgentCandidates()` 中添加新 agent 的候选路径列表。

### 第 7 步：更新缓存指纹

在 `src/core/cache.ts` 中添加 fingerprint 计算策略。

### 第 8 步：更新文档

- 更新 `README.md` 中的 Agent 支持表
- 更新 `src/cli.tsx` 和 `src/ui/App.tsx` 中的帮助文本

## 代码规范

- TypeScript 严格模式
- ESM 模块（import/export，import 路径带 `.js` 后缀）
- 内置模块使用 `node:` 前缀（`node:fs`、`node:path` 等）
- 所有文件 I/O 操作用 try/catch 包裹
- SQLite 数据库扫描时以 `readonly: true` 模式打开；仅删除操作以写入模式打开

## 测试

目前项目通过手动测试验证：

```bash
npm run build
asm list                    # 验证所有 agent 被检测到
asm list --agent <name>     # 验证特定 agent
asm search "关键词"         # 验证搜索
asm history <id> --limit 5  # 验证历史提取
asm delete <id>             # 验证删除（建议先用测试会话）
```

## 提交变更

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feat-add-windsurf-support`
3. 完成修改
4. 构建并测试：`npm run build && asm list`
5. 提交（commit message 用中文，说明"为什么"和"改了什么"）
6. 发起 Pull Request
