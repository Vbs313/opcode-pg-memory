/**
 * config.ts — 统一配置入口
 *
 * 从 process.env 读取配置，提供 getConfig() 单例。
 * 配置优先级: process.env > 默认值
 */

interface PgMemoryConfig {
  pgHost: string;
  pgPort: number;
  pgDatabase: string;
  pgUser: string;
  pgPassword: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingBatchSize: number;
  logLevel: string;
  platform: string;
  omoEnabled: boolean;
}

const DEFAULTS: PgMemoryConfig = {
  pgHost: "localhost",
  pgPort: 5432,
  pgDatabase: "opencode_memory",
  pgUser: "opencode",
  pgPassword: "",
  embeddingProvider: "ollama",
  embeddingModel: "qwen3-embedding:0.6b",
  embeddingDimensions: 1024,
  embeddingBatchSize: 10,
  logLevel: "info",
  platform: "opencode",
  omoEnabled: false,
};

let _config: PgMemoryConfig | null = null;

function loadFromEnv(): PgMemoryConfig {
  return {
    pgHost: process.env.PG_HOST || DEFAULTS.pgHost,
    pgPort: parseInt(process.env.PG_PORT || String(DEFAULTS.pgPort), 10),
    pgDatabase: process.env.PG_DATABASE || DEFAULTS.pgDatabase,
    pgUser: process.env.PG_USER || DEFAULTS.pgUser,
    pgPassword: process.env.PG_PASSWORD || DEFAULTS.pgPassword,
    embeddingProvider:
      process.env.EMBEDDING_PROVIDER || DEFAULTS.embeddingProvider,
    embeddingModel: process.env.EMBEDDING_MODEL || DEFAULTS.embeddingModel,
    embeddingDimensions: parseInt(
      process.env.EMBEDDING_DIMENSIONS || String(DEFAULTS.embeddingDimensions),
      10,
    ),
    embeddingBatchSize: parseInt(
      process.env.EMBEDDING_BATCH_SIZE || String(DEFAULTS.embeddingBatchSize),
      10,
    ),
    logLevel: process.env.LOG_LEVEL || DEFAULTS.logLevel,
    platform: process.env.PLATFORM || "opencode",
    omoEnabled: process.env.OMO_ENABLED === "true",
  };
}

export function getConfig(): PgMemoryConfig {
  if (!_config) {
    _config = loadFromEnv();
  }
  return _config;
}

export function buildConfig(): PgMemoryConfig {
  return getConfig();
}

export function reloadConfig(): void {
  _config = null;
}

export function getDatabaseConfig() {
  const cfg = getConfig();
  return {
    host: cfg.pgHost,
    port: cfg.pgPort,
    database: cfg.pgDatabase,
    user: cfg.pgUser,
    password: cfg.pgPassword,
  };
}

export function getEmbeddingConfig() {
  const cfg = getConfig();
  return {
    provider: cfg.embeddingProvider,
    model: cfg.embeddingModel,
    dimensions: cfg.embeddingDimensions,
    batchSize: cfg.embeddingBatchSize,
  };
}

/**
 * Resolve embedding API key for a given provider.
 * Checks process.env.{PROVIDER}_API_KEY and common env var names.
 */
export function resolveEmbeddingApiKey(provider: string): string | undefined {
  const key = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  return process.env[key] || process.env.EMBEDDING_API_KEY || undefined;
}

/**
 * Resolve a config value from environment variable.
 */
export function resolveConfig(varName: string): string | undefined {
  return process.env[varName] || undefined;
}

export type { PgMemoryConfig };
