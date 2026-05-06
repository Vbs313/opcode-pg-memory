/**
 * Centralized configuration for pg-memory plugin.
 * 
 * Priority: env vars > ~/.config/opencode/pg-memory.jsonc > defaults
 * Pattern: follows opencode-supermemory config.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const CONFIG_FILES = [
  join(CONFIG_DIR, "pg-memory.jsonc"),
  join(CONFIG_DIR, "pg-memory.json"),
];

// ── Types ──────────────────────────────────────────────

export interface PgMemoryConfig {
  pgHost?: string;
  pgPort?: number;
  pgDatabase?: string;
  pgUser?: string;
  pgPassword?: string;
  embeddingProvider?: "ollama" | "deepseek" | "openai";
  embeddingModel?: string;
  embeddingDimensions?: number;
  embeddingBatchSize?: number;
  similarityThreshold?: number;
  maxMemories?: number;
  logLevel?: "debug" | "info" | "warn" | "error";
  compactionThreshold?: number;
}

// ── Defaults ──────────────────────────────────────────

const DEFAULTS: Required<Omit<PgMemoryConfig, "pgPassword">> = {
  pgHost: "localhost",
  pgPort: 5432,
  pgDatabase: "PGOMO",
  pgUser: "opencode",
  embeddingProvider: "ollama",
  embeddingModel: "qwen3-embedding:0.6b",
  embeddingDimensions: 1024,
  embeddingBatchSize: 10,
  similarityThreshold: 0.6,
  maxMemories: 10,
  logLevel: "info",
  compactionThreshold: 0.80,
};

// ── Helpers ───────────────────────────────────────────

function stripJsoncComments(content: string): string {
  return content
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function loadFileConfig(): PgMemoryConfig {
  for (const path of CONFIG_FILES) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        const json = stripJsoncComments(content);
        return JSON.parse(json) as PgMemoryConfig;
      } catch {
        // invalid config, fall through to defaults
      }
    }
  }
  return {};
}

const fileConfig = loadFileConfig();

// ── Exported Config ───────────────────────────────────

export const CONFIG = {
  pgHost: process.env.PG_HOST || fileConfig.pgHost || DEFAULTS.pgHost,
  pgPort: parseInt(process.env.PG_PORT || String(fileConfig.pgPort || DEFAULTS.pgPort), 10),
  pgDatabase: process.env.PG_DATABASE || fileConfig.pgDatabase || DEFAULTS.pgDatabase,
  pgUser: process.env.PG_USER || fileConfig.pgUser || DEFAULTS.pgUser,
  pgPassword: process.env.PG_PASSWORD || fileConfig.pgPassword || "",
  embeddingProvider: (process.env.EMBEDDING_PROVIDER || fileConfig.embeddingProvider || DEFAULTS.embeddingProvider) as "ollama" | "deepseek" | "openai",
  embeddingModel: process.env.EMBEDDING_MODEL || fileConfig.embeddingModel || DEFAULTS.embeddingModel,
  embeddingDimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || String(fileConfig.embeddingDimensions || DEFAULTS.embeddingDimensions), 10),
  embeddingBatchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE || String(fileConfig.embeddingBatchSize || DEFAULTS.embeddingBatchSize), 10),
  similarityThreshold: fileConfig.similarityThreshold ?? DEFAULTS.similarityThreshold,
  maxMemories: fileConfig.maxMemories ?? DEFAULTS.maxMemories,
  logLevel: (process.env.PG_MEMORY_LOG_LEVEL || fileConfig.logLevel || DEFAULTS.logLevel) as "debug" | "info" | "warn" | "error",
  compactionThreshold: fileConfig.compactionThreshold ?? DEFAULTS.compactionThreshold,
};

export function isConfigured(): boolean {
  return !!CONFIG.pgPassword;
}

export function getDatabaseConfig() {
  return {
    host: CONFIG.pgHost,
    port: CONFIG.pgPort,
    database: CONFIG.pgDatabase,
    user: CONFIG.pgUser,
    password: CONFIG.pgPassword,
  };
}
