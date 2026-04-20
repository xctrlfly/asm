/**
 * 共享路径解析工具
 *
 * 各 provider 和 cache 模块统一使用此模块来动态检测数据路径，
 * 不再在各处硬编码。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentType } from "../providers/types.js";

const HOME = os.homedir();

/** 按优先级检测第一个存在的路径 */
export function resolveFirst(candidates: string[]): string | null {
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 获取指定 agent 的候选数据路径列表（按优先级排列）。
 *
 * @param agent    Agent 类型
 * @param customPath  用户通过 config.paths 指定的自定义路径（最高优先级）
 */
export function getAgentCandidates(agent: AgentType, customPath?: string): string[] {
  const candidates: string[] = [];

  // 用户自定义路径拥有最高优先级
  if (customPath) candidates.push(customPath);

  switch (agent) {
    case "claude-code": {
      // 环境变量 CLAUDE_CONFIG_DIR
      const envDir = process.env["CLAUDE_CONFIG_DIR"];
      if (envDir) candidates.push(path.join(envDir, "projects"));
      // 默认路径
      candidates.push(path.join(HOME, ".claude", "projects"));
      break;
    }

    case "opencode": {
      // XDG_DATA_HOME 规范
      const xdg = process.env["XDG_DATA_HOME"] || path.join(HOME, ".local", "share");
      candidates.push(path.join(xdg, "opencode", "opencode.db"));
      break;
    }

    case "codex": {
      // 环境变量 CODEX_HOME
      const codexHome = process.env["CODEX_HOME"];
      if (codexHome) candidates.push(path.join(codexHome, "state_5.sqlite"));
      // 默认路径
      candidates.push(path.join(HOME, ".codex", "state_5.sqlite"));
      break;
    }

    case "cursor": {
      // macOS
      if (process.platform === "darwin") {
        candidates.push(
          path.join(HOME, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
        );
      }
      // Linux / XDG
      candidates.push(
        path.join(HOME, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
      );
      // Windows
      if (process.env["APPDATA"]) {
        candidates.push(
          path.join(process.env["APPDATA"], "Cursor", "User", "globalStorage", "state.vscdb"),
        );
      }
      break;
    }
  }

  return candidates;
}

/**
 * 解析 agent 的实际数据路径。
 *
 * 按候选列表依次检测，返回第一个存在的路径；全部不存在则返回 null。
 */
export function resolveAgentPath(agent: AgentType, customPath?: string): string | null {
  return resolveFirst(getAgentCandidates(agent, customPath));
}
