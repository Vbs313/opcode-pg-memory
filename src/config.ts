/**
 * Centralized configuration for pg-memory plugin.
 *
 * Priority: env vars > ~/.config/opencode/pg-memory.jsonc > defaults
 * Uses Zod for runtime validation + type inference (no manual `as` casts).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const CONFIG_FILES = [
  join(CONFIG_DIR, "pg-memory.jsonc"),
  join(CONFIG_DIR, "pg-memory.json"),
];

// ── Zod Schema ────────────────────────────────────────
// 单一来源：类型由 schema 自动推导，消除 interface + as 双重维护

const SyncModeSchema = z.enum(["hybrid", "polling", "event"]);

export const ConfigSchema = z.object({
  pgHost: z.string().default("localhost"),
  pgPort: z.coerce.number().int().min(1).max(65535).default(5432),
  pgDatabase: z.string().default("PGOMO"),
  pgUser: z.string().default("opencode"),
  pgPassword: z.string().default(""),

  embeddingProvider: z.enum(["ollama", "deepseek", "openai"]).default("ollama"),
  embeddingModel: z.string().default("qwen3-embedding:0.6b"),
  embeddingDimensions: z.coerce.number().int().positive().default(1024),
  embeddingBatchSize: z.coerce.number().int().positive().default(10),

  similarityThreshold: z.coerce.number().min(0).max(1).default(0.6),
  maxMemories: z.coerce.number().int().positive().default(10),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  compactionThreshold: z.coerce.number().min(0).max(1).default(0.8),
  syncMode: SyncModeSchema.default("hybrid"),
  pollingIntervalMs: z.coerce.number().int().positive().default(5000),
});

export type PgMemoryConfig = z.infer<typeof ConfigSchema>;

// ── Merged Config ─────────────────────────────────────

function stripJsoncComments(content: string): string {
  return content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function loadRawFileConfig(): Record<string, unknown> {
  for (const path of CONFIG_FILES) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        return JSON.parse(stripJsoncComments(content));
      } catch {
        // invalid config, fall through
      }
    }
  }
  return {};
}

/**
 * 构建运行时配置。
 * 优先级：env var > file config > schema default
 * 所有值在返回前经过 Zod 解析校验，类型安全。
 */
export function buildConfig(): PgMemoryConfig {
  const fileConfig = loadRawFileConfig();

  // 从 process.env 读取所有 PG/EMBEDDING 前缀的环境变量
  const envRaw: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (
      val &&
      (key.startsWith("PG_") ||
        key.startsWith("EMBEDDING_") ||
        key.startsWith("PG_MEMORY_"))
    ) {
      // 转小写下划线 → camelCase
      const parts = key.replace("PG_MEMORY_", "").toLowerCase().split("_");
      const camel =
        parts[0] +
        parts
          .slice(1)
          .map((s) => s[0].toUpperCase() + s.slice(1))
          .join("");
      envRaw[camel] = val;
    }
  }

  // env → file → defaults 三层合并后交由 Zod 解析
  // Zod schema 已定义每个字段的 default 值
  const defaults = ConfigSchema.parse({});
  const merged = { ...defaults, ...fileConfig, ...envRaw };
  const result = ConfigSchema.safeParse(merged);

  if (!result.success) {
    console.error("[pg-memory] Config validation errors:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    // 用 Zod 兜底（所有字段都有 default）
    return ConfigSchema.parse({});
  }

  return result.data;
}

// 模块级单例
let _config: PgMemoryConfig | null = null;

export function getConfig(): PgMemoryConfig {
  if (!_config) _config = buildConfig();
  return _config;
}

// 兼容旧导入（指向单例）
export const CONFIG = new Proxy({} as PgMemoryConfig, {
  get(_, key: string) {
    return (getConfig() as any)[key];
  },
});

export function isConfigured(): boolean {
  return !!getConfig().pgPassword;
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
