/**
 * settings-defaults.test.ts
 *
 * Tests the 4-layer configuration merge with Zod validation.
 */

import {
  SettingsSchema,
  loadSettings,
  reloadSettings,
} from "../src/shared/settings-defaults";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Clean env vars that might interfere
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("PG_") ||
      key.startsWith("EMBEDDING_") ||
      key.startsWith("PG_MEMORY_") ||
      key.startsWith("OMO_")
    ) {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ============================================================
// SettingsSchema (Zod validation)
// ============================================================
describe("SettingsSchema", () => {
  test("uses defaults when nothing is configured", () => {
    const cfg = SettingsSchema.parse({});
    expect(cfg.pgHost).toBe("localhost");
    expect(cfg.pgPort).toBe(5432);
    expect(cfg.pgDatabase).toBe("PGOMO");
    expect(cfg.pgUser).toBe("opencode");
    expect(cfg.embeddingProvider).toBe("ollama");
    expect(cfg.embeddingModel).toBe("qwen3-embedding:0.6b");
    expect(cfg.logLevel).toBe("info");
    expect(cfg.syncMode).toBe("hybrid");
    expect(cfg.platform).toBe("opencode");
    expect(cfg.cleanupEnabled).toBe(true);
  });

  test("accepts valid port range", () => {
    expect(SettingsSchema.parse({ pgPort: 1 }).pgPort).toBe(1);
    expect(SettingsSchema.parse({ pgPort: 65535 }).pgPort).toBe(65535);
  });

  test("rejects invalid port", () => {
    expect(() => SettingsSchema.parse({ pgPort: 0 })).toThrow();
    expect(() => SettingsSchema.parse({ pgPort: 65536 })).toThrow();
  });

  test("coerces string values to numbers", () => {
    const cfg = SettingsSchema.parse({
      pgPort: "5432",
      embeddingDimensions: "2048",
    });
    expect(cfg.pgPort).toBe(5432);
    expect(cfg.embeddingDimensions).toBe(2048);
  });

  test("validates embeddingProvider enum", () => {
    expect(() =>
      SettingsSchema.parse({ embeddingProvider: "invalid" }),
    ).toThrow();
  });

  test("accepts all valid embedding providers", () => {
    for (const p of ["ollama", "deepseek", "openai"]) {
      expect(
        SettingsSchema.parse({ embeddingProvider: p }).embeddingProvider,
      ).toBe(p);
    }
  });

  test("validates syncMode enum", () => {
    for (const m of ["hybrid", "polling", "event"]) {
      expect(SettingsSchema.parse({ syncMode: m }).syncMode).toBe(m);
    }
    expect(() => SettingsSchema.parse({ syncMode: "invalid" })).toThrow();
  });

  test("validates logLevel enum", () => {
    for (const l of ["debug", "info", "warn", "error"]) {
      expect(SettingsSchema.parse({ logLevel: l }).logLevel).toBe(l);
    }
    expect(() => SettingsSchema.parse({ logLevel: "trace" })).toThrow();
  });

  test("validates numerical ranges", () => {
    expect(() => SettingsSchema.parse({ similarityThreshold: -0.1 })).toThrow();
    expect(() => SettingsSchema.parse({ similarityThreshold: 1.1 })).toThrow();
    expect(() => SettingsSchema.parse({ compactionThreshold: -0.1 })).toThrow();
    expect(() => SettingsSchema.parse({ compactionThreshold: 1.1 })).toThrow();
  });

  test("coerces omoEnabled=true from string", () => {
    const cfg = SettingsSchema.parse({ omoEnabled: "true" });
    expect(cfg.omoEnabled).toBe(true);
  });

  test("coerces omoEnabled=false from boolean false", () => {
    const cfg = SettingsSchema.parse({ omoEnabled: false });
    expect(cfg.omoEnabled).toBe(false);
  });

  test("dataDir is optional", () => {
    const cfg = SettingsSchema.parse({});
    expect(cfg.dataDir).toBeUndefined();
  });
});

// ============================================================
// env var → camelCase mapping (loadSettings behavior)
// ============================================================
describe("loadSettings env var mapping", () => {
  beforeEach(() => {
    reloadSettings(); // clear cache before each test
  });

  test("PG_HOST maps to pgHost", () => {
    process.env.PG_HOST = "pg-test.example.com";
    const cfg = loadSettings();
    expect(cfg.pgHost).toBe("pg-test.example.com");
  });

  test("PG_MEMORY_LOG_LEVEL maps to logLevel", () => {
    process.env.PG_MEMORY_LOG_LEVEL = "debug";
    const cfg = loadSettings();
    expect(cfg.logLevel).toBe("debug");
  });

  test("EMBEDDING_PROVIDER maps to embeddingProvider", () => {
    process.env.EMBEDDING_PROVIDER = "deepseek";
    const cfg = loadSettings();
    expect(cfg.embeddingProvider).toBe("deepseek");
  });

  test("env vars override defaults", () => {
    process.env.PG_DATABASE = "env_test_db";
    const cfg = loadSettings();
    expect(cfg.pgDatabase).toBe("env_test_db");
  });
});
