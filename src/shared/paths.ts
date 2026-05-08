/**
 * paths.ts — 统一路径管理
 *
 * 借鉴 claude-mem 的 paths.ts 设计，适配 OpenCode 生态。
 * 数据目录：~/.opencode-pg-memory/  (可被 PG_MEMORY_DATA_DIR 覆盖)
 *
 * 路径优先级:
 *   1. PG_MEMORY_DATA_DIR 环境变量
 *   2. ~/.config/opencode/pg-memory.json 中的 dataDir 字段
 *   3. ~/.opencode-pg-memory/ (默认)
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, mkdirSync } from "node:fs";

// ============================================================
// Data directory resolution
// ============================================================

function resolveDataDir(): string {
  // Priority 1: env var
  const envDir = process.env.PG_MEMORY_DATA_DIR;
  if (envDir) return envDir;

  // Priority 2: opencode config file
  const configDir = join(homedir(), ".config", "opencode");
  for (const name of ["pg-memory.jsonc", "pg-memory.json"]) {
    const path = join(configDir, name);
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8");
        const parsed = JSON.parse(
          raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""),
        );
        if (parsed.dataDir) return parsed.dataDir;
      } catch {
        // corrupt file, fall through
      }
    }
  }

  // Priority 3: default
  return join(homedir(), ".opencode-pg-memory");
}

export const DATA_DIR = resolveDataDir();

// ============================================================
// Path exports
// ============================================================

/** 凭证文件路径 (只存 API keys / DB passwords) */
export const ENV_FILE_PATH = () => join(DATA_DIR, ".env");

/** settings.json 路径 (存所有 PG_MEMORY_* 配置) */
export const SETTINGS_FILE_PATH = () => join(DATA_DIR, "settings.json");

/** SQLite fallback 数据库路径 (用于本地缓存) */
export const LOCAL_DB_PATH = () => join(DATA_DIR, "cache.db");

/** 日志目录 */
export const LOGS_DIR = () => {
  const dir = join(DATA_DIR, "logs");
  ensureDir(dir);
  return dir;
};

/** 归档目录 */
export const ARCHIVES_DIR = () => {
  const dir = join(DATA_DIR, "archives");
  ensureDir(dir);
  return dir;
};

// ============================================================
// Directory helpers
// ============================================================

export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

export function ensureAllDirs(): void {
  ensureDir(DATA_DIR);
  ensureDir(join(DATA_DIR, "logs"));
  ensureDir(join(DATA_DIR, "archives"));
}
