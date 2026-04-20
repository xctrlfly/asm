# asm

**统一管理你所有 coding agent 的会话。**

`asm` 扫描你本地所有 coding agent（Claude Code、Codex、Cursor、OpenCode）的会话数据，汇聚成一张可搜索的统一视图。找到你要的会话，按下回车，直接恢复上下文。

[功能特性](#功能特性) • [安装](#安装) • [使用方法](#使用方法) • [配置](#配置) • [扩展新 Agent](#扩展新-agent) • [English](README_EN.md)

## 为什么需要 asm

AI 驱动的 coding agent 让并行工作效率飙升，但也带来了一个新问题：**会话散落各处。**

不同的 agent、不同的目录、不同的 git 分支。你记得做过某件事，却想不起来在哪。于是开始翻找——打开终端，`cd` 到某个目录，启动 agent，翻一圈会话……不在这。换个目录试试，再换个 agent……

`asm` 就是为了终结这个循环。

## 功能特性

- **统一视图**：一处看到 Claude Code、Codex、Cursor、OpenCode 的所有会话
- **交互式 TUI**：fzf 风格的模糊搜索——输入关键词实时过滤，方向键导航，回车恢复
- **一键恢复**：自动 `cd` 到对应目录并启动 agent，直接进入会话上下文
- **智能标题**：从会话名称、首条消息、自定义标题、git 分支中提取有意义的标题
- **灵活过滤**：按 agent 类型、工作目录、时间范围、关键词筛选
- **消息历史**：在 TUI 中按 `h` 预览对话历史，或用 `asm history <id>` 查看
- **安全删除**：在 TUI 中按 `d` 或用 `asm delete <id>` 清理不需要的会话（归档/移到回收站，可恢复）
- **增量缓存**：基于文件修改时间的缓存机制，只有数据变化的 agent 才重新扫描（`-r` 强制刷新）
- **动态路径检测**：自动检测各 agent 的数据目录，支持多平台、环境变量和自定义路径
- **易于扩展**：添加新 agent 只需实现一个简单接口

## 支持的 Agent

| 标识 | Agent | 恢复能力 | 命令 |
|------|-------|---------|------|
| **CC** | Claude Code | 完整恢复 | `claude -r <session-id>` |
| **CX** | Codex | 完整恢复 | `codex --resume <thread-id>` |
| **CR** | Cursor | 打开 workspace | `cursor <directory>` |
| **OC** | OpenCode | 完整恢复 | `opencode --session <session-id>` |

> **完整恢复** = cd 到对应目录 + 恢复到具体的对话上下文
> **打开 workspace** = 打开项目目录（Cursor 在 IDE 内部管理会话，无法从 CLI 定位到具体会话）

## 安装

需要 [Node.js](https://nodejs.org/) 22 或更高版本。

### 从 GitHub 安装（推荐）

```bash
npm install -g github:xctrlfly/asm
```

### 从源码安装

```bash
git clone https://github.com/xctrlfly/asm.git
cd asm
npm install
npm run build
npm link
```

### 验证

```bash
asm --version
# 0.1.0
```

## 使用方法

### 交互式 TUI（默认模式）

直接运行：

```bash
asm
```

打开交互式会话浏览器：

```
 ┌──────────────────────────────────────────────────────────────────┐
 │ Press / to search                                   [All Agents] │
 └──────────────────────────────────────────────────────────────────┘
 ┌──────────────────────────────────────────────────────────────────┐
 │ >CC refactor-auth-module        ~/Projects/web…   10 minutes ago  │
 │  CC implement-search-feature   ~/Projects/app…   about 3 hrs ago │
 │  OC my-cool-project            ~/Projects/my-…   6 days ago      │
 │  CX fix-login-bug              ~/Projects/api…   7 days ago      │
 │  CR 调试分页组件                   ~/Projects/web…   7 days ago      │
 │  ...                                                    [1-15/85]│
 └──────────────────────────────────────────────────────────────────┘
  Enter 恢复  ↑↓ 导航  Tab 过滤  / 搜索  h 历史  d 删除  ? 帮助  q 退出
```

#### 快捷键

| 按键 | 操作 |
|------|------|
| `↑`/`↓` 或 `j`/`k` | 上下导航 |
| `Enter` | 恢复选中会话（cd + 启动 agent） |
| `/` | 进入搜索模式（模糊匹配） |
| `Tab` | 切换 Agent 过滤器（全部 → Claude Code → Codex → Cursor → OpenCode） |
| `h` | 预览选中会话的对话历史 |
| `d` | 删除/归档选中会话（有确认步骤） |
| `?` | 显示帮助面板 |
| `q` 或 `Esc` | 退出 |

### 列出会话

```bash
# 列出所有会话
asm list

# 显示会话 ID（用于 open/history 命令）
asm list --id

# 按 agent 类型过滤
asm list --agent claude-code

# 按时间过滤
asm list --since 7d

# 按目录过滤
asm list --dir ~/Projects

# 组合过滤
asm list -a claude-code -s 30d --id

# 强制刷新缓存（跳过增量缓存，重新扫描所有 agent）
asm list --refresh
```

### 搜索

```bash
# 模糊搜索（匹配标题、目录、分支）
asm search "vehicle"

# 在指定 agent 中搜索
asm search "api" -a cursor
```

### 直接打开会话

```bash
# 用完整或部分 session ID
asm open ff9a1d0e

# 实际执行的命令:
# $ cd /Users/you/Projects/myapp && claude -r ff9a1d0e-...
```

### 查看对话历史

```bash
# 用 session ID 前缀
asm history ff9a --limit 10

# 用标题关键词（ID 未匹配时自动按标题搜索）
asm history "登录"

# 查看完整历史
asm history a4b0af81
```

### 删除会话

```bash
# 删除指定会话（有确认提示）
asm delete ff9a1d0e

# 跳过确认直接删除
asm delete ff9a1d0e --force
```

删除操作是安全的：
- **Claude Code**：将 `.jsonl` 文件移到回收目录 `~/.config/asm/trash/`，可手动移回恢复
- **OpenCode / Codex**：软删除（标记归档），不删除数据，可通过 SQL 恢复
- **Cursor**：先备份到回收目录，再删除

## 配置

配置文件位于 `~/.config/asm/config.json`。

```bash
# 创建默认配置
asm config init

# 查看当前配置
asm config show

# 设置配置项
asm config set defaults.sinceDays 30
asm config set defaults.limit 50
asm config set disabledAgents cursor

# 查看配置文件路径
asm config path
```

### 配置项

| 键 | 类型 | 默认值 | 说明 |
|----|------|--------|------|
| `defaults.sinceDays` | number | 30 | 只显示最近 N 天的会话 |
| `defaults.limit` | number | 50 | 最大显示数量 |
| `disabledAgents` | string[] | [] | 禁用的 agent（不扫描） |
| `paths.claude-code` | string | 自动检测 | Claude Code 项目目录路径 |
| `paths.codex` | string | 自动检测 | Codex SQLite 数据库路径 |
| `paths.cursor` | string | 自动检测 | Cursor 状态数据库路径 |
| `paths.opencode` | string | 自动检测 | OpenCode 全局数据路径 |

## 工作原理

`asm` 默认只读——扫描和搜索不会修改任何 agent 的数据。删除操作采用安全策略（归档/移到回收站），详见上方"删除会话"章节。

1. **扫描**：每个 provider 读取对应 agent 的本地存储（JSONL 文件、SQLite 数据库、JSON 状态文件）
2. **缓存**：扫描结果缓存在 `~/.config/asm/cache.json`，基于文件修改时间判断是否需要重新扫描
3. **聚合**：所有 agent 的会话合并、按最后活动时间排序，通过 fuse.js 提供模糊搜索
4. **恢复**：选中会话后，执行 `cd "<目录>" && <agent-resume-命令>`，agent 进程接管终端

### Agent 数据位置（macOS）

| Agent | 路径 | 格式 |
|-------|------|------|
| Claude Code | `~/.claude/projects/<编码路径>/<uuid>.jsonl` | JSONL |
| Codex | `~/.codex/state_5.sqlite` | SQLite |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | SQLite |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite |

> 以上为默认路径。asm 会自动检测多个候选位置（环境变量、XDG 规范、平台差异），也可通过 `config.paths` 自定义。

## 项目结构

```
src/
├── cli.tsx                 # CLI 入口（Commander.js，7 个子命令）
├── core/
│   ├── aggregator.ts       # 会话聚合 + fuse.js 模糊搜索
│   ├── cache.ts            # 基于 mtime 的增量缓存
│   ├── config.ts           # 配置文件管理
│   ├── deleter.ts          # 安全删除/归档会话 + 回收站机制
│   ├── history.ts          # 对话历史提取
│   ├── opener.ts           # cd + resume 命令执行
│   └── paths.ts            # 动态数据路径检测（多候选 + 平台适配）
├── providers/
│   ├── types.ts            # 统一会话模型 + Provider 接口
│   ├── claude-code.ts      # Claude Code（JSONL 流式解析）
│   ├── codex.ts            # Codex（SQLite）
│   ├── cursor.ts           # Cursor（SQLite + workspace 映射）
│   ├── opencode.ts         # OpenCode（SQLite）
│   └── registry.ts         # Provider 注册中心
└── ui/
    └── App.tsx             # 交互式 TUI（Ink / React）
```

## 扩展新 Agent

`asm` 的 provider 架构设计让扩展非常简单：

1. 创建 `src/providers/<名称>.ts`，实现 `SessionProvider` 接口
2. 在 `src/cli.tsx` 注册 provider
3. 在 `src/providers/types.ts` 添加类型和配置

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

```bash
git clone https://github.com/xctrlfly/asm.git
cd asm
npm install
npm run dev       # 监听模式构建
npm link          # 全局安装用于测试
```

## 开源协议

`asm` 基于 [MIT License](LICENSE) 开源。
