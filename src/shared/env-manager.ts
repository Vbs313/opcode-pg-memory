/**
 * env-manager.ts — 环境变量管理
 *
 * 职责：
 *   1. 从 ~/.opencode-pg-memory/.env 加载/保存凭证
 *   2. 阻止父进程危险变量泄露到子进程 (BLOCKED_ENV_VARS)
 *   3. 为子进程构建隔离环境 (buildIsolatedEnv)
 *   4. 提供统一的 API key 解析链
 *
 * 借鉴 claude-mem 的 EnvManager.ts 设计。
 *
 * 凭证解析优先级（由高到低）:
 *   1. process.env (运行时注入)
 *   2. .env 文件 (~/.opencode-pg-memory/.env)
 *   3. settings.json (~/.opencode-pg-memory/settings.json)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { ENV_FILE_PATH, DATA_DIR } from "./paths";
import { createLogger } from "../services/logger";

const logger = createLogger("env-manager");

// ============================================================
// Blocked env vars — 防止父进程危险变量泄露
// ============================================================

/**
 * 这些变量在构建子进程环境时被显式删除。
 * 它们会从 .env 文件或 settings.json 重新注入（如果配置了）。
 */
export const BLOCKED_ENV_VARS: readonly string[] = [
  // API Keys — 防止从父进程 shell 泄露
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "PG_PASSWORD",

  // 防止递归 / 冲突
  "PG_MEMORY_DATA_DIR", // 子进程应由父进程的 data dir 决定
];

// ============================================================
// Types
// ============================================================

export interface PgMemoryEnv {
  /** Database */
  PG_HOST?: string;
  PG_PORT?: string;
  PG_DATABASE?: string;
  PG_USER?: string;
  PG_PASSWORD?: string;

  /** Embedding API keys */
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;

  /** Platform identity */
  PG_MEMORY_PLATFORM?: string;
  PG_MEMORY_LOG_LEVEL?: string;
  PG_MEMORY_DATA_DIR?: string;

  /** Embedding config */
  PG_MEMORY_EMBED_PROVIDER?: string;
  PG_MEMORY_EMBED_MODEL?: string;

  /** Any other key */
  [key: string]: string | undefined;
}

// ============================================================
// .env file parsing (轻量，无外部依赖)
// ============================================================

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

function serializeEnvFile(env: Record<string, string>): string {
  const lines: string[] = [
    "# opcode-pg-memory credentials",
    "# Auto-managed by env-manager.ts",
    "# Edit this file or use settings.json for configuration",
    "",
  ];
  for (const [key, value] of Object.entries(env)) {
    if (value) {
      const needsQuotes = /[\s#=]/.test(value);
      lines.push(`${key}=${needsQuotes ? `"${value}"` : value}`);
    }
  }
  return lines.join("\n") + "\n";
}

// ============================================================
// Load / Save / Merge
// ============================================================

/**
 * 从 .env 文件加载凭证。
 * 不抛异常 — 文件不存在时返回空对象。
 */
export function loadDotEnv(): Record<string, string> {
  const envPath = ENV_FILE_PATH();
  if (!existsSync(envPath)) {
    logger.debug("No .env file found", { path: envPath });
    return {};
  }
  try {
    const content = readFileSync(envPath, "utf-8");
    return parseEnvFile(content);
  } catch (error) {
    logger.warn("Failed to read .env file", { path: envPath, error });
    return {};
  }
}

/**
 * 保存凭证到 .env 文件。
 * 只保存白名单字段（API keys + DB 凭证），不存无关变量。
 */
export function saveDotEnv(env: Partial<PgMemoryEnv>): void {
  // 只持久化安全敏感字段
  const ALLOWLIST = new Set([
    "PG_PASSWORD",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "PG_HOST",
    "PG_PORT",
    "PG_DATABASE",
    "PG_USER",
  ]);

  // 合并现有文件
  const existing = loadDotEnv();
  for (const [key, value] of Object.entries(env)) {
    if (ALLOWLIST.has(key) && value !== undefined) {
      existing[key] = value;
    }
  }

  // 写入
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(ENV_FILE_PATH(), serializeEnvFile(existing), "utf-8");
  logger.info("Saved .env file", { path: ENV_FILE_PATH() });
}

/**
 * 构建隔离的子进程环境。
 * 1. 从 process.env 复制允许的变量
 * 2. 删除 BLOCKED_ENV_VARS
 * 3. 从 .env 文件重新注入凭证
 */
export function buildIsolatedEnv(
  extra?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};

  // 1. 从当前进程环境复制（排除 blocked）
  for (const [key, value] of Object.entries(process.env)) {
    if (value && !BLOCKED_ENV_VARS.includes(key)) {
      env[key] = value;
    }
  }

  // 2. 从 .env 文件注入凭证（覆盖允许的值）
  const dotEnv = loadDotEnv();
  for (const [key, value] of Object.entries(dotEnv)) {
    if (value && !BLOCKED_ENV_VARS.includes(key)) {
      env[key] = value;
    }
  }

  // 3. 合并额外变量
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value) env[key] = value;
    }
  }

  return env;
}

// ============================================================
// API Key resolution chain
// ============================================================

/**
 * 按优先级查找配置值: process.env → .env 文件 → fallback
 */
export function resolveConfig(
  key: string,
  fallback?: string,
): string | undefined {
  return process.env[key] ?? loadDotEnv()[key] ?? fallback;
}

/**
 * 获取嵌入模型使用的 API key。
 * 按 provider 自动选择对应 key。
 */
export function resolveEmbeddingApiKey(provider: string): string | undefined {
  switch (provider) {
    case "openai":
      return resolveConfig("OPENAI_API_KEY");
    case "deepseek":
      return resolveConfig("DEEPSEEK_API_KEY");
    default:
      return undefined; // ollama 不需要 API key
  }
}
