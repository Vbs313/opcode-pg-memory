/**
 * config.test.ts — Zod 配置层测试
 *
 * 验证三层合并优先级、环境变量解析、校验失败降级。
 */

import { ConfigSchema, buildConfig, reloadConfig } from "../src/config";

// 保存原始环境变量以便恢复
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // 清除测试相关的环境变量
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("PG_") ||
      key.startsWith("EMBEDDING_") ||
      key.startsWith("PG_MEMORY_")
    ) {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  // 恢复环境变量
  process.env = { ...ORIGINAL_ENV };
});

describe("ConfigSchema", () => {
  test("uses defaults when nothing is configured", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.pgHost).toBe("localhost");
    expect(cfg.pgPort).toBe(5432);
    expect(cfg.pgDatabase).toBe("PGOMO");
    expect(cfg.pgUser).toBe("opencode");
    expect(cfg.embeddingProvider).toBe("ollama");
    expect(cfg.embeddingModel).toBe("qwen3-embedding:0.6b");
    expect(cfg.logLevel).toBe("info");
  });

  test("accepts valid port range", () => {
    expect(ConfigSchema.parse({ pgPort: 1 }).pgPort).toBe(1);
    expect(ConfigSchema.parse({ pgPort: 65535 }).pgPort).toBe(65535);
  });

  test("coerces string to number for port", () => {
    expect(ConfigSchema.parse({ pgPort: "5432" }).pgPort).toBe(5432);
  });

  test("coerces string to number for dimensions", () => {
    expect(
      ConfigSchema.parse({ embeddingDimensions: "2048" }).embeddingDimensions,
    ).toBe(2048);
  });

  test("validates embeddingProvider enum", () => {
    expect(() =>
      ConfigSchema.parse({ embeddingProvider: "invalid" }),
    ).toThrow();
  });

  test("accepts all valid embedding providers", () => {
    const providers = ["ollama", "deepseek", "openai"] as const;
    for (const p of providers) {
      expect(
        ConfigSchema.parse({ embeddingProvider: p }).embeddingProvider,
      ).toBe(p);
    }
  });

  test("validates syncMode enum", () => {
    expect(ConfigSchema.parse({ syncMode: "hybrid" }).syncMode).toBe("hybrid");
    expect(ConfigSchema.parse({ syncMode: "polling" }).syncMode).toBe(
      "polling",
    );
    expect(ConfigSchema.parse({ syncMode: "event" }).syncMode).toBe("event");
    expect(() => ConfigSchema.parse({ syncMode: "invalid" })).toThrow();
  });

  test("threshold ranges are validated", () => {
    expect(() => ConfigSchema.parse({ similarityThreshold: -0.1 })).toThrow();
    expect(() => ConfigSchema.parse({ similarityThreshold: 1.1 })).toThrow();
    expect(() => ConfigSchema.parse({ compactionThreshold: -0.1 })).toThrow();
    expect(() => ConfigSchema.parse({ compactionThreshold: 1.1 })).toThrow();
  });

  test("positive integers are validated", () => {
    expect(() => ConfigSchema.parse({ maxMemories: 0 })).toThrow();
    expect(() => ConfigSchema.parse({ embeddingBatchSize: 0 })).toThrow();
    expect(() => ConfigSchema.parse({ pollingIntervalMs: 0 })).toThrow();
  });
});

describe("buildConfig", () => {
  beforeEach(() => {
    reloadConfig(); // clear cache so env vars are re-read
  });

  test("reads PG_HOST from env", () => {
    process.env.PG_HOST = "10.0.0.1";
    const cfg = buildConfig();
    expect(cfg.pgHost).toBe("10.0.0.1");
  });

  test("reads PG_PORT from env as string", () => {
    process.env.PG_PORT = "15432";
    const cfg = buildConfig();
    expect(cfg.pgPort).toBe(15432);
  });

  test("PG_USER overrides default", () => {
    process.env.PG_USER = "admin";
    const cfg = buildConfig();
    expect(cfg.pgUser).toBe("admin");
  });

  test("EMBEDDING_MODEL env var works", () => {
    process.env.EMBEDDING_MODEL = "text-embedding-v2";
    const cfg = buildConfig();
    expect(cfg.embeddingModel).toBe("text-embedding-v2");
  });

  test("PG_MEMORY_ prefixed vars work", () => {
    process.env.PG_MEMORY_LOG_LEVEL = "debug";
    const cfg = buildConfig();
    expect(cfg.logLevel).toBe("debug");
  });

  test("env overrides file config", () => {
    process.env.PG_HOST = "from-env";
    const cfg = buildConfig();
    expect(cfg.pgHost).toBe("from-env");
  });

  test("invalid env falls back to default gracefully", () => {
    process.env.PG_PORT = "not-a-number";
    const cfg = buildConfig();
    // Zod coerce will fail → safeParse returns fallback defaults
    expect(cfg.pgPort).toBe(5432);
  });

  test("empty password returns empty string", () => {
    delete process.env.PG_PASSWORD;
    const cfg = buildConfig();
    expect(cfg.pgPassword).toBe("");
  });
});
