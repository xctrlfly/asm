# CLAUDE.md

This file provides context for AI coding agents working on this project.

## Project Overview

**Agent Sessions Manager (asm)** is a CLI tool that unifies session management across multiple coding agents (Claude Code, Codex, Cursor, OpenCode). It scans each agent's local session data, presents a unified view, and allows one-key resume.

## Tech Stack

- **Language**: TypeScript (strict mode, ESM)
- **Runtime**: Node.js 22+
- **Build**: tsup (esbuild-based bundler)
- **CLI Framework**: Commander.js
- **TUI**: Ink 5 (React for CLI) + ink-text-input
- **SQLite**: better-sqlite3 (sync API, readonly mode)
- **Search**: fuse.js (fuzzy search)
- **Date**: date-fns

## Architecture

```
src/
├── cli.tsx                 # CLI entry: commands (list/search/open/history/delete/config)
├── core/
│   ├── aggregator.ts       # Merges sessions from all providers, applies filters
│   ├── cache.ts            # ~/.config/asm/cache.json, mtime-based fingerprints
│   ├── config.ts           # ~/.config/asm/config.json, user preferences
│   ├── deleter.ts          # Safe session deletion/archival + trash directory
│   ├── history.ts          # Message history extraction per agent
│   ├── opener.ts           # `cd <dir> && <agent-command>` via shell spawn
│   └── paths.ts            # Dynamic data path detection (multi-candidate + platform)
├── providers/
│   ├── types.ts            # UnifiedSession, SessionProvider interface, AgentConfig
│   ├── claude-code.ts      # ~/.claude/projects/<path>/<uuid>.jsonl
│   ├── codex.ts            # ~/.codex/state_5.sqlite → threads table
│   ├── cursor.ts           # ~/Library/Application Support/Cursor/ → state.vscdb
│   ├── opencode.ts         # ~/.local/share/opencode/opencode.db → session table
│   └── registry.ts         # Provider registration + availability checking
└── ui/
    └── App.tsx             # Ink TUI: session list, search, help overlay, history, delete
```

## Key Design Decisions

1. **Providers are independent**: Each provider reads only its own agent's data. Adding a new agent means implementing `SessionProvider` interface - no changes to core needed.

2. **Read-only by default**: Scanning opens SQLite with `{ readonly: true }`. Deletion uses safe strategies: soft-delete (archive) for OpenCode/Codex, move-to-trash for Claude Code, backup-then-delete for Cursor. Trash stored at `~/.config/asm/trash/`.

3. **Cache strategy**: Per-provider fingerprinting based on data source mtime. Cache stored at `~/.config/asm/cache.json`. Stale providers re-scanned while fresh ones use cache.

4. **TUI lifecycle**: Ink TUI must fully unmount before spawning child process (agent resume). The `onSelect` callback stores the selected session, `exit()` is called, then after `waitUntilExit()` completes, `openSession()` spawns the child process with `stdio: 'inherit'`.

5. **Session resume**: Executed as `cd "<dir>" && <command>` via `spawn(cmd, { shell: true })` to ensure the agent process truly runs in the target working directory.

## Agent Data Locations (macOS)

| Agent | Data Path | Format |
|-------|-----------|--------|
| Claude Code | `~/.claude/projects/<encoded-path>/<uuid>.jsonl` | JSONL (one event per line) |
| Codex | `~/.codex/state_5.sqlite` → `threads` table | SQLite |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` → `cursorDiskKV` table | SQLite + JSON values |
| OpenCode | `~/.local/share/opencode/opencode.db` → `session` table | SQLite |

## Common Tasks

```bash
npm run build          # Build with tsup → dist/cli.js
npm run dev            # Watch mode build
npm link               # Install `asm` globally
asm list --id          # List sessions with ID prefixes
asm history <id>       # View message history
asm delete <id>        # Delete/archive a session
asm config show        # Check configuration
```

## Adding a New Agent

See CONTRIBUTING.md for the step-by-step guide. In short:
1. Create `src/providers/<name>.ts` implementing `SessionProvider`
2. Register in `src/cli.tsx` → `createRegistry()`
3. Add to `AgentType` union and `AGENT_CONFIGS` in `types.ts`
4. Add history support in `history.ts`
5. Add delete support in `deleter.ts`
6. Add path candidates in `paths.ts`
7. Add cache fingerprint in `cache.ts`
