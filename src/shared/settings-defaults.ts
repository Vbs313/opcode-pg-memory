/**
 * settings-defaults.ts — 类型化配置默认值管理
 *
 * 借鉴 claude-mem 的 SettingsDefaultsManager.ts 设计。
 * 读取 ~/.opencode-pg-memory/settings.json，为所有 PG_MEMORY_* 变量提供类型化默认值。
 *
 * 解析顺序:
 *   1. process.env (运行时最高优先级)
 *   2. ~/.config/opencode/pg-memory.json[c] (OpenCode 配置目录)
 *   3. ~/.opencode-pg-memory/settings.json (数据目录)
 *   4. 硬编码默认值 (本文件)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { createLogger } from "../services/logger";
import { SETTINGS_FILE_PATH } from "./paths";

const logger = createLogger("settings-defaults");

// ============================================================
// Zod schema — 单一事实来源
// ============================================================

export const SettingsSchema = z.object({
  // ── Database ──
  pgHost: z.string().default("localhost"),
  pgPort: z.coerce.number().int().min(1).max(65535).default(5432),
  pgDatabase: z.string().default("PGOMO"),
  pgUser: z.string().default("opencode"),
  pgPassword: z.string().default(""),

  // ── Embedding ──
  embeddingProvider: z.enum(["ollama", "openai", "deepseek"]).default("ollama"),
  embeddingModel: z.string().default("qwen3-embedding:0.6b"),
  embeddingDimensions: z.coerce.number().int().positive().default(1024),
  embeddingBatchSize: z.coerce.number().int().positive().default(10),

  // ── Memory retrieval ──
  similarityThreshold: z.coerce.number().min(0).max(1).default(0.6),
  maxMemories: z.coerce.number().int().positive().default(10),

  // ── Plugin behavior ──
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  compactionThreshold: z.coerce.number().min(0).max(1).default(0.8),
  syncMode: z.enum(["hybrid", "polling", "event"]).default("hybrid"),
  pollingIntervalMs: z.coerce.number().int().positive().default(5000),
  platform: z.string().default("opencode"),

  // ── Token budget ──
  contextLimitRatio: z.coerce.number().min(0).max(1).default(0.02),
  minInjectionTokens: z.coerce.number().int().positive().default(500),
  maxInjectionTokens: z.coerce.number().int().positive().default(3000),

  // ── Output compression (对标 rtk 思路，Plugin 层实现) ──
  maxOutputLength: z.coerce.number().int().positive().default(10000),
  maxOutputLines: z.coerce.number().int().positive().default(200),

  // ── OmO multi-agent integration ──
  omoEnabled: z.coerce.boolean().default(false),

  // ── Scoring ──
  minObservationQuality: z.coerce.number().min(0).max(1).default(0.2),
  cleanupAgeDays: z.coerce.number().int().positive().default(7),
  cleanupMaxPerRun: z.coerce.number().int().positive().default(100),
  cleanupEnabled: z.boolean().default(true),

  // ── Data directory (only from settings.json, not env) ──
  dataDir: z.string().optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;

// ============================================================
// Internal defaults (hardcoded last resort)
// ============================================================

const HARDCODED_DEFAULTS: Settings = SettingsSchema.parse({});

// ============================================================
// File readers
// ============================================================

function stripJsoncComments(content: string): string {
  return content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function loadJsonFile(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf-8");
    return JSON.parse(stripJsoncComments(content));
  } catch {
    return null;
  }
}

// ============================================================
// 4-layer merge
// ============================================================

/**
 * 加载全部设置，4 层合并。
 *
 * 返回值为 Settings（Zod 解析后，类型安全）。
 */
export function loadSettings(): Settings {
  // Layer 1: OpenCode config dir
  const configDir = join(homedir(), ".config", "opencode");
  const openCodeConfig =
    loadJsonFile(join(configDir, "pg-memory.jsonc")) ??
    loadJsonFile(join(configDir, "pg-memory.json")) ??
    {};

  // Layer 2: Data dir settings.json
  const dataDirConfig = loadJsonFile(SETTINGS_FILE_PATH()) ?? {};

  // Layer 3: process.env (PG_* / EMBEDDING_* / PG_MEMORY_* / OMO_*)
  const envRaw: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (!val) continue;
    if (
      key.startsWith("PG_") ||
      key.startsWith("EMBEDDING_") ||
      key.startsWith("PG_MEMORY_") ||
      key.startsWith("OMO_")
    ) {
      // PG_MEMORY_LOG_LEVEL → logLevel (strip full prefix)
      // PG_HOST → pgHost (keep pg)
      // EMBEDDING_PROVIDER → embeddingProvider (keep embedding)
      let effectiveKey = key;
      if (key.startsWith("PG_MEMORY_")) {
        effectiveKey = key.slice("PG_MEMORY_".length);
      }
      // For PG_* (non PG_MEMORY_*) and EMBEDDING_*, don't strip —
      // the prefix becomes part of the camelCase key (pgHost, embeddingProvider)
      // snake_case → camelCase
      const parts = effectiveKey.toLowerCase().split("_");
      const camel =
        parts[0] +
        parts
          .slice(1)
          .map((s) => s[0]!.toUpperCase() + s.slice(1))
          .join("");
      envRaw[camel] = val;
    }
  }

  // Merge: hardcoded ← opencodeConfig ← dataDirConfig ← env
  const merged = {
    ...HARDCODED_DEFAULTS,
    ...openCodeConfig,
    ...dataDirConfig,
    ...envRaw,
  };

  const result = SettingsSchema.safeParse(merged);
  if (!result.success) {
    logger.warn("Settings validation failed, using defaults", {
      errors: result.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
    });
    return HARDCODED_DEFAULTS;
  }

  return result.data;
}

// ============================================================
// Singleton
// ============================================================

let _cachedSettings: Settings | null = null;

export function getSettings(): Settings {
  if (!_cachedSettings) {
    _cachedSettings = loadSettings();
  }
  return _cachedSettings;
}

/** Clear cached settings. Next getSettings() call re-reads from scratch. */
export function clearSettingsCache(): void {
  _cachedSettings = null;
}

/** Clear cache and immediately reload. */
export function reloadSettings(): Settings {
  clearSettingsCache();
  return getSettings();
}
