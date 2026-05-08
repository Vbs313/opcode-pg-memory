/**
 * config.ts — 统一配置入口（薄封装层）
 *
 * 底层实现迁移至 src/shared/：
 *   - settings-defaults.ts: 4 层配置合并 + Zod 校验
 *   - env-manager.ts: .env 文件 + BLOCKED_ENV_VARS + 隔离环境
 *   - paths.ts: 数据目录 + 文件路径
 *
 * 保持此文件的导出签名不变，确保现有 import 不中断。
 *
 * 配置优先级（由高到低）:
 *   1. process.env (运行时注入)
 *   2. ~/.opencode-pg-memory/settings.json (数据目录)
 *   3. ~/.config/opencode/pg-memory.json[c] (OpenCode 配置目录)
 *   4. 硬编码默认值
 */

import {
  getSettings,
  SettingsSchema,
  type Settings,
} from "./shared/settings-defaults";
import {
  loadDotEnv,
  saveDotEnv,
  resolveConfig,
  resolveEmbeddingApiKey,
  buildIsolatedEnv,
  BLOCKED_ENV_VARS,
  type PgMemoryEnv,
} from "./shared/env-manager";
import { clearSettingsCache } from "./shared/settings-defaults";
import {
  DATA_DIR,
  ENV_FILE_PATH,
  SETTINGS_FILE_PATH,
  LOCAL_DB_PATH,
  LOGS_DIR,
  ensureAllDirs,
} from "./shared/paths";

// ── Re-export for backward compatibility ──

export { SettingsSchema as ConfigSchema, type Settings as PgMemoryConfig };

export type { PgMemoryEnv };

export {
  loadDotEnv,
  saveDotEnv,
  resolveConfig,
  resolveEmbeddingApiKey,
  buildIsolatedEnv,
  BLOCKED_ENV_VARS,
  DATA_DIR,
  ENV_FILE_PATH,
  SETTINGS_FILE_PATH,
  LOCAL_DB_PATH,
  LOGS_DIR,
  ensureAllDirs,
};

// ── Singleton config accessors ──

let _config: Settings | null = null;

/**
 * 获取缓存的配置。首次调用后缓存，后续返回单例。
 */
export function getConfig(): Settings {
  if (!_config) {
    _config = getSettings();
    ensureAllDirs();
  }
  return _config;
}

/**
 * 构建运行时配置（等价于 getConfig，向后兼容）
 */
export function buildConfig(): Settings {
  return getConfig();
}

/**
 * 清除配置缓存，下次 getConfig/buildConfig 会重新加载。
 */
export function reloadConfig(): void {
  // Clear BOTH caches. Next getConfig() call re-reads everything fresh.
  _config = null;
  clearSettingsCache();
}

/**
 * 检查数据库是否已配置（有密码或 .env 文件存在）
 */
export function isConfigured(): boolean {
  return !!(getConfig().pgPassword || loadDotEnv().PG_PASSWORD);
}

/**
 * 构建数据库配置对象（用于 Pool 初始化）
 */
export function getDatabaseConfig() {
  const cfg = getConfig();
  return {
    host: cfg.pgHost,
    port: cfg.pgPort,
    database: cfg.pgDatabase,
    user: cfg.pgUser,
    password: cfg.pgPassword || loadDotEnv().PG_PASSWORD || "",
  };
}

/**
 * 获取嵌入配置
 */
export function getEmbeddingConfig() {
  const cfg = getConfig();
  return {
    provider: cfg.embeddingProvider,
    model: cfg.embeddingModel,
    dimensions: cfg.embeddingDimensions,
    batchSize: cfg.embeddingBatchSize,
    apiKey: resolveEmbeddingApiKey(cfg.embeddingProvider),
    baseURL: resolveConfig("DEEPSEEK_BASE_URL"),
  };
}
