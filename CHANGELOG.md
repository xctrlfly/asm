# 更新日志

格式基于 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [语义化版本](https://semver.org/)。

## [0.1.0] - 2026-04-20

### 新增

- 首个版本发布
- **4 个 Agent Provider**：Claude Code（JSONL）、Codex（SQLite）、Cursor（SQLite + workspace 映射）、OpenCode（SQLite）
- **交互式 TUI**：fzf 风格模糊搜索、方向键导航、Tab 切换 Agent 过滤器
- **CLI 命令**：`asm list`、`asm search`、`asm open`、`asm history`、`asm delete`、`asm config`
- **会话恢复**：自动 `cd` 到工作目录 + 执行 agent 对应的恢复命令（`claude -r`、`codex resume`、`opencode --session` 等）
- **安全删除**：`asm delete <id>` 或 TUI 中按 `d` 键。Claude Code 移到回收站，OpenCode/Codex 软删除（归档），Cursor 备份后删除。回收目录：`~/.config/asm/trash/`
- **帮助系统**：`asm --help` 带丰富输出，TUI 中按 `?` 弹出帮助面板（快捷键 / Agent 支持表 / 使用示例）
- **历史查看**：`asm history <id>` 查看对话历史，TUI 中按 `h` 预览
- **增量缓存**：基于 mtime 的缓存机制，热启动速度提升约 48%。`--refresh` / `-r` 强制刷新
- **动态路径检测**：自动检测各 agent 数据目录（config > 环境变量 > 平台默认），跨平台兼容
- **配置管理**：`~/.config/asm/config.json`，通过 `asm config init/show/set/path` 管理
- **灵活过滤**：按 agent 类型（`-a`）、目录（`-d`）、时间范围（`-s`）、关键词搜索
- **ID 前缀匹配**：`asm open`、`asm history`、`asm delete` 支持部分 ID 及标题关键词搜索
- **中文排版优化**：CJK 字符宽度正确计算，list/search 与 TUI 列排版一致
