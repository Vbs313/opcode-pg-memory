/**
 * env-manager.test.ts
 *
 * Tests for the environment variable management module.
 * Tests functions that use process.env only (no DATA_DIR dependency).
 * loadDotEnv/saveDotEnv depend on module-level DATA_DIR and are tested
 * minimally here.
 */

// ============================================================
// buildIsolatedEnv
// ============================================================
describe("buildIsolatedEnv", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.PG_PASSWORD;
  });

  test("excludes BLOCKED_ENV_VARS", () => {
    process.env.OPENAI_API_KEY = "sk-leaked";
    process.env.PG_PASSWORD = "leaked";
    const {
      buildIsolatedEnv,
      BLOCKED_ENV_VARS,
    } = require("../src/shared/env-manager");
    const isolated = buildIsolatedEnv();
    expect(isolated.OPENAI_API_KEY).toBeUndefined();
    expect(isolated.PG_PASSWORD).toBeUndefined();
    expect(BLOCKED_ENV_VARS.length).toBeGreaterThanOrEqual(5);
    expect(BLOCKED_ENV_VARS).toContain("OPENAI_API_KEY");
    expect(BLOCKED_ENV_VARS).toContain("PG_PASSWORD");
  });

  test("merges extra vars", () => {
    const { buildIsolatedEnv } = require("../src/shared/env-manager");
    const isolated = buildIsolatedEnv({ CUSTOM_VAR: "custom-value" });
    expect(isolated.CUSTOM_VAR).toBe("custom-value");
  });
});

// ============================================================
// resolveConfig
// ============================================================
describe("resolveConfig", () => {
  afterEach(() => {
    delete process.env.TEST_KEY;
  });

  test("reads from process.env first", () => {
    process.env.TEST_KEY = "from-process";
    const { resolveConfig } = require("../src/shared/env-manager");
    expect(resolveConfig("TEST_KEY")).toBe("from-process");
  });

  test("returns fallback when nothing is set", () => {
    delete process.env.TEST_KEY;
    const { resolveConfig } = require("../src/shared/env-manager");
    expect(resolveConfig("TEST_KEY", "fallback")).toBe("fallback");
  });
});

// ============================================================
// resolveEmbeddingApiKey
// ============================================================
describe("resolveEmbeddingApiKey", () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
  });

  test("returns undefined for ollama (no key needed)", () => {
    const { resolveEmbeddingApiKey } = require("../src/shared/env-manager");
    expect(resolveEmbeddingApiKey("ollama")).toBeUndefined();
  });

  test("returns OPENAI_API_KEY for openai provider", () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const { resolveEmbeddingApiKey } = require("../src/shared/env-manager");
    expect(resolveEmbeddingApiKey("openai")).toBe("sk-openai-test");
  });

  test("returns DEEPSEEK_API_KEY for deepseek provider", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-test";
    const { resolveEmbeddingApiKey } = require("../src/shared/env-manager");
    expect(resolveEmbeddingApiKey("deepseek")).toBe("sk-deepseek-test");
  });
});

// ============================================================
// loadDotEnv (reads from actual data dir)
// ============================================================
describe("loadDotEnv", () => {
  test("returns object (empty or populated, depends on real .env)", () => {
    const { loadDotEnv } = require("../src/shared/env-manager");
    const env = loadDotEnv();
    expect(env).toBeDefined();
    expect(typeof env).toBe("object");
    for (const v of Object.values(env)) {
      expect(typeof v).toBe("string");
    }
  });
});
