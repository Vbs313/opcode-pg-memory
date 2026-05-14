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

// ============================================================
// Output compression rules (extracted from output-compressor.ts)
// ============================================================

export interface CompressionRule {
  match: RegExp;
  stripLines?: RegExp[];
  maxLines?: number;
  onEmpty?: string;
}

const DEFAULT_COMPRESSION_RULES: CompressionRule[] = [
  {
    match: /^npm\s+(install|ci|i)\b/,
    stripLines: [
      /^\s*$/,
      /^npm (notice|warn|info) /,
      /^up to date/i,
      /^added \d+/,
      /^removed \d+/,
      /^\d+ packages?( are| is)/i,
      /^found \d+/i,
      /^audited \d+/i,
    ],
    maxLines: 60,
    onEmpty: "npm install completed",
  },
  {
    match: /^pnpm\s+(install|i|add)\b/,
    stripLines: [
      /^\s*$/,
      /^\+[\w@]/,
      /^(Progress|Resolving|Fetching|Downloading|Extracting)/i,
    ],
    maxLines: 40,
    onEmpty: "pnpm install completed",
  },
  {
    match: /^(ls|list)\b/,
    stripLines: [/^total \d+$/, /^\s*$/],
    maxLines: 80,
    onEmpty: "(empty directory)",
  },
  { match: /^find\b/, maxLines: 100, onEmpty: "(no files found)" },
  { match: /^grep\b/, maxLines: 100, onEmpty: "(no matches)" },
  { match: /^(cat|read)\b/, stripLines: [/^\s*$/], maxLines: 150 },
  {
    match: /^git\s+diff\b/,
    stripLines: [
      /^diff --git /,
      /^index [0-9a-f]+\.\./,
      /^--- a\//,
      /^\+\+\+ b\//,
    ],
    maxLines: 150,
    onEmpty: "(no diff)",
  },
  { match: /^git\s+log\b/, maxLines: 60 },
  { match: /^git\s+status\b/, maxLines: 40 },
  {
    match: /^cargo\s+(build|check|test)\b/,
    stripLines: [/^\s*$/, /^(Compiling|Checking|Finished| Downloaded)/],
    maxLines: 80,
    onEmpty: "cargo completed",
  },
  {
    match: /^dotnet\s+build\b/,
    stripLines: [/^\s*$/, /^(MSBuild|Build |Determining)/, /^\s+\w+ -> /],
    maxLines: 60,
  },
  {
    match: /^psql\b/,
    stripLines: [/^\s*$/, /^sslmode/i, /^SSL connection/i],
    maxLines: 80,
  },
];

let _compressionRules: CompressionRule[] | null = null;

export function getCompressionRules(): CompressionRule[] {
  if (!_compressionRules) {
    _compressionRules = DEFAULT_COMPRESSION_RULES;
  }
  return _compressionRules;
}
