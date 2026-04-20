import { spawn } from "node:child_process";
import fs from "node:fs";
import type { UnifiedSession } from "../providers/types.js";

/**
 * 构建 resume 命令。直接使用 provider 生成的 resumeCommand 字段，
 * 确保命令定义只有一个来源，避免 opener 和 provider 不一致。
 */
function buildResumeCommand(session: UnifiedSession): {
  command: string;
  cwd: string;
} {
  const cwd = session.workingDirectory || process.cwd();
  return { command: session.resumeCommand, cwd };
}

/**
 * 打开 / 恢复一个会话
 *
 * 关键: 通过 `cd <dir> && <agent-command>` 作为一条完整 shell 命令执行,
 * 确保 agent 进程真正运行在目标工作目录下。
 * Claude Code 的 `-r` 是按工作目录查找 session 的，必须先 cd。
 */
export function openSession(session: UnifiedSession): void {
  const { command, cwd } = buildResumeCommand(session);

  // 验证 cwd 是否存在
  const effectiveCwd = fs.existsSync(cwd) ? cwd : process.cwd();
  if (!fs.existsSync(cwd)) {
    console.error(`\x1b[33mWarning: directory does not exist: ${cwd}\x1b[0m`);
    console.error(`\x1b[33mFalling back to current directory.\x1b[0m`);
  }

  // 构造完整的 shell 命令: cd 到目录 + 执行 agent resume
  const shellCommand = `cd "${effectiveCwd}" && ${command}`;
  console.log(`\x1b[90m$ ${shellCommand}\x1b[0m`);

  const child = spawn(shellCommand, {
    stdio: "inherit",
    shell: true,
    env: process.env,
  });

  child.on("error", (err) => {
    console.error(`Error opening session: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

/**
 * 获取用于在终端手动执行的完整命令字符串（供展示 / 复制用）
 */
export function getResumeShellCommand(session: UnifiedSession): string {
  const { command, cwd } = buildResumeCommand(session);
  return `cd "${cwd}" && ${command}`;
}
