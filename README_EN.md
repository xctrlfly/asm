# asm

**A unified session manager for your coding agents.**

`asm` scans the local session data of your coding agents — Claude Code, Codex, Cursor, OpenCode — and presents them in a single, searchable view. Find the session you need, hit Enter, and you're back in context.

[Features](#features) • [Installation](#installation) • [How to use](#how-to-use) • [Configuration](#configuration) • [Adding a new agent](#adding-a-new-agent)

## The problem

AI-powered coding agents have made parallel work incredibly productive. But that productivity creates a new problem: **sessions are everywhere**.

Different agents, different directories, different git branches. You remember *doing* something, but not *where*. So you start hunting — open a terminal, `cd` somewhere, launch an agent, scroll through sessions… wrong one. Try another directory. Try another agent.

`asm` ends that loop.

## Features

- **Unified view** of sessions across Claude Code, Codex, Cursor, and OpenCode.
- **Interactive TUI** with fzf-style fuzzy search — type to filter, arrow keys to navigate, Enter to resume.
- **One-key resume**: `cd` to the right directory and launch the agent with the right session, automatically.
- **Smart titles**: extracts meaningful titles from session names, first messages, custom titles, and git branches.
- **Flexible filtering**: by agent type, working directory, time range, or keyword.
- **Message history**: preview conversation history inline (`h` key) or via `asm history <id>`.
- **Safe deletion**: archive or trash sessions via `d` key or `asm delete <id>` (recoverable).
- **Session cache**: mtime-based incremental caching — only re-scans agents whose data has changed (`-r` to force refresh).
- **Dynamic path detection**: auto-detects agent data directories across platforms, with env var and custom path support.
- **Extensible**: adding a new agent is one file implementing a simple interface.

## Supported Agents

| Badge | Agent | Resume | How |
|-------|-------|--------|-----|
| **CC** | Claude Code | Full resume | `claude -r <session-id>` |
| **CX** | Codex | Full resume | `codex resume <thread-id>` |
| **CR** | Cursor | Open workspace | `cursor <directory>` |
| **OC** | OpenCode | Full resume | `opencode --session <session-id>` |

> **Full resume** = `cd` to directory + restore the exact conversation context.
> **Open workspace** = opens the project directory (Cursor manages sessions internally within IDE).

## Installation

Requires [Node.js](https://nodejs.org/) 22 or later.

### From GitHub (recommended)

```bash
npm install -g github:xctrlfly/asm
```

### From source

```bash
git clone https://github.com/xctrlfly/asm.git
cd asm
npm install
npm run build
npm link
```

### Verify

```bash
asm --version
# 0.1.0
```

## How to use

### Interactive TUI (default)

Simply run:

```bash
asm
```

This opens the interactive session browser:

```
 ┌──────────────────────────────────────────────────────────────────┐
 │ Press / to search                                   [All Agents] │
 └──────────────────────────────────────────────────────────────────┘
 ┌──────────────────────────────────────────────────────────────────┐
 │ >CC refactor-auth-module        ~/Projects/web…   10 minutes ago  │
 │  CC implement-search-feature   ~/Projects/app…   about 3 hrs ago │
 │  OC my-cool-project            ~/Projects/my-…   6 days ago      │
 │  CX fix-login-bug              ~/Projects/api…   7 days ago      │
 │  CR Debug pagination comp      ~/Projects/web…   7 days ago      │
 │  ...                                                    [1-15/85]│
 └──────────────────────────────────────────────────────────────────┘
  Enter resume  ↑↓ navigate  Tab filter  / search  h history  d delete  ? help
```

#### Keybindings

| Key | Action |
|-----|--------|
| `↑`/`↓` or `j`/`k` | Navigate up/down |
| `Enter` | Resume selected session (`cd` + agent command) |
| `/` | Enter search mode (fuzzy match) |
| `Tab` | Cycle agent filter (All → Claude Code → Codex → Cursor → OpenCode) |
| `h` | Preview message history of selected session |
| `d` | Delete/archive selected session (with confirmation) |
| `?` | Show help overlay |
| `q` or `Esc` | Quit |

### List sessions

```bash
# List all sessions
asm list

# Show session IDs (needed for open/history commands)
asm list --id

# Filter by agent
asm list --agent claude-code

# Filter by time
asm list --since 7d

# Filter by directory
asm list --dir ~/Projects

# Combine filters
asm list -a claude-code -s 30d --id

# Force refresh cache
asm list --refresh
```

### Search

```bash
# Fuzzy search across titles, directories, branches
asm search "vehicle"

# Search within specific agent
asm search "api" -a cursor
```

### Open a session directly

```bash
# By full or partial session ID
asm open ff9a1d0e

# What happens:
# $ cd /Users/you/Projects/myapp && claude -r ff9a1d0e-...
```

### View message history

```bash
# By session ID prefix
asm history ff9a --limit 10

# By title keyword (if ID doesn't match, falls back to title search)
asm history "login"

# Full history
asm history a4b0af81
```

### Delete a session

```bash
# Delete with confirmation prompt
asm delete ff9a1d0e

# Skip confirmation
asm delete ff9a1d0e --force
```

Deletion is safe and recoverable:
- **Claude Code**: moves `.jsonl` file to `~/.config/asm/trash/`
- **OpenCode / Codex**: soft-delete (marks as archived), recoverable via SQL
- **Cursor**: backs up to `~/.config/asm/trash/` before deleting

## Configuration

Configuration is stored at `~/.config/asm/config.json`.

```bash
# Create default config
asm config init

# Show current config
asm config show

# Set values
asm config set defaults.sinceDays 30
asm config set defaults.limit 50
asm config set disabledAgents cursor

# Show config file path
asm config path
```

### Config options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `defaults.sinceDays` | number | 30 | Only show sessions from the last N days |
| `defaults.limit` | number | 50 | Max sessions to display |
| `disabledAgents` | string[] | [] | Agents to exclude from scanning |
| `paths.claude-code` | string | auto | Custom path to Claude Code projects dir |
| `paths.codex` | string | auto | Custom path to Codex SQLite database |
| `paths.cursor` | string | auto | Custom path to Cursor state database |
| `paths.opencode` | string | auto | Custom path to OpenCode global data |

## How it works

`asm` is read-only by default — scanning and searching never modify agent data. Deletion uses safe strategies (archive/trash), see "Delete a session" above.

1. **Scan**: Each provider reads its agent's local session storage (JSONL files, SQLite databases, JSON state files).
2. **Cache**: Results are cached at `~/.config/asm/cache.json` with mtime-based fingerprints. On subsequent runs, only agents with changed data are re-scanned.
3. **Aggregate**: Sessions from all agents are merged, sorted by last activity time, and made searchable via fuse.js.
4. **Resume**: When you select a session, `asm` runs `cd "<directory>" && <agent-resume-command>` in a shell with inherited stdio, so the agent takes over your terminal.

### Agent data locations (macOS)

| Agent | Path | Format |
|-------|------|--------|
| Claude Code | `~/.claude/projects/<path>/<uuid>.jsonl` | JSONL |
| Codex | `~/.codex/state_5.sqlite` | SQLite |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | SQLite |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite |

> These are default paths. `asm` auto-detects multiple candidate locations (env vars, XDG spec, platform differences). Custom paths can be set via `config.paths`.

## Adding a new agent

`asm` is designed to be extended. Adding a new agent requires:

1. Create `src/providers/<name>.ts` implementing the `SessionProvider` interface
2. Register it in `src/cli.tsx`
3. Add type/config entries in `src/providers/types.ts`

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full step-by-step guide.

## Development

```bash
git clone https://github.com/xctrlfly/asm.git
cd asm
npm install
npm run dev       # watch mode
npm link          # global install for testing
```

## License

`asm` is distributed under the [MIT License](LICENSE).
