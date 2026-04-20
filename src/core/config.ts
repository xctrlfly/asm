/**
 * 配置文件管理
 *
 * 配置文件位置: ~/.config/asm/config.json
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** ASM 全局配置模型 */
export interface AsmConfig {
  /** 默认过滤选项 */
  defaults?: {
    /** 默认只显示最近 N 天的会话 (如 30) */
    sinceDays?: number;
    /** 默认每页显示数量 */
    limit?: number;
  };
  /** 各 agent 自定义数据路径 (覆盖默认路径) */
  paths?: {
    "claude-code"?: string;
    codex?: string;
    cursor?: string;
    opencode?: string;
  };
  /** 禁用的 agent (不扫描) */
  disabledAgents?: string[];
}

export class ConfigManager {
  /** 获取配置文件路径 */
  static getConfigPath(): string {
    return path.join(os.homedir(), ".config", "asm", "config.json");
  }

  /** 加载配置。文件不存在或解析失败返回空配置 */
  static load(): AsmConfig {
    try {
      const configPath = ConfigManager.getConfigPath();
      const content = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(content) as AsmConfig;
    } catch {
      return {};
    }
  }

  /** 保存配置到文件 */
  static save(config: AsmConfig): void {
    const configPath = ConfigManager.getConfigPath();
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  }

  /** 初始化默认配置文件（如果不存在则创建） */
  static init(): AsmConfig {
    const configPath = ConfigManager.getConfigPath();
    if (fs.existsSync(configPath)) {
      return ConfigManager.load();
    }

    const defaultConfig: AsmConfig = {
      defaults: {
        sinceDays: 30,
        limit: 50,
      },
      paths: {},
      disabledAgents: [],
    };

    ConfigManager.save(defaultConfig);
    return defaultConfig;
  }
}
