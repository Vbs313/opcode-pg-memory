/**
 * system-transform-injector.test.ts
 *
 * Tests the pure functions of the two-path recall injection engine.
 * DB-dependent functions (keywordRecall, semanticRecall, retrieveMemoriesForInjection)
 * require a PG pool and are tested separately in integration tests.
 */

import {
  computeRecencyBoost,
  hybridScore,
  dedupKey,
  dedup,
  estimateTokens,
  trimToTokenBudget,
  formatInjectionBlock,
} from "../src/injection/system-transform-injector";

// ============================================================
// computeRecencyBoost
// ============================================================
describe("computeRecencyBoost", () => {
  test("returns 1 for now", () => {
    const score = computeRecencyBoost(new Date(), 2);
    expect(score).toBeCloseTo(1, 1);
  });

  test("returns ~0.5 after one half-life", () => {
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    const score = computeRecencyBoost(past, 2);
    expect(score).toBeCloseTo(0.5, 1);
  });

  test("returns ~0.25 after two half-lives", () => {
    const past = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000); // 4 days ago
    const score = computeRecencyBoost(past, 2);
    expect(score).toBeCloseTo(0.25, 1);
  });

  test("approaches 0 for very old dates", () => {
    const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // 1 year ago
    const score = computeRecencyBoost(old, 2);
    expect(score).toBeLessThan(0.01);
  });

  test("uses custom half-life", () => {
    const past = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
    const score = computeRecencyBoost(past, 7);
    expect(score).toBeCloseTo(0.5, 1);
  });
});

// ============================================================
// hybridScore
// ============================================================
describe("hybridScore", () => {
  const weights: [number, number, number] = [0.5, 0.3, 0.2];

  test("perfect match scores 1.0", () => {
    const score = hybridScore(1.0, 5, 1.0, weights);
    expect(score).toBeCloseTo(1.0, 2);
  });

  test("zero vector similarity still has importance + recency", () => {
    const score = hybridScore(0, 3, 0.5, weights);
    // sem=0, imp=3/5*0.3=0.18, rec=0.5*0.2=0.1 => 0.28
    expect(score).toBeCloseTo(0.28, 2);
  });

  test("null vector similarity uses 0.5 as default", () => {
    const score = hybridScore(null, 3, 0.5, weights);
    // sem=0.5*0.5=0.25, imp=0.18, rec=0.1 => 0.53
    expect(score).toBeCloseTo(0.53, 2);
  });

  test("minimum importance (1) gives lower score", () => {
    const score1 = hybridScore(0.5, 1, 0.5, weights);
    const score5 = hybridScore(0.5, 5, 0.5, weights);
    expect(score1).toBeLessThan(score5);
  });

  test("custom weights change result", () => {
    const impHeavy: [number, number, number] = [0.2, 0.7, 0.1];
    const score = hybridScore(0.5, 5, 0.5, impHeavy);
    // sem=0.5*0.2=0.1, imp=5/5*0.7=0.7, rec=0.5*0.1=0.05 => 0.85
    expect(score).toBeCloseTo(0.85, 2);
  });
});

// ============================================================
// estimateTokens
// ============================================================
describe("estimateTokens", () => {
  test("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("estimates ~1 token per 4 English characters", () => {
    const text = "hello world this is a test sentence with some words";
    const estimated = estimateTokens(text);
    expect(estimated).toBeGreaterThan(5);
    expect(estimated).toBeLessThan(text.length);
  });

  test("handles Chinese text (fewer tokens per char)", () => {
    const chinese = "这是一个中文测试句子用于测试分词效果";
    const estimated = estimateTokens(chinese);
    expect(estimated).toBeGreaterThan(0);
    // Chinese should have higher token density (more chars per token)
    expect(estimated).toBeLessThan(chinese.length * 2);
  });

  test("handles mixed Chinese and English", () => {
    const mixed = "hello 世界 this is a 测试";
    const estimated = estimateTokens(mixed);
    expect(estimated).toBeGreaterThan(0);
  });
});

// ============================================================
// dedupKey + dedup
// ============================================================
describe("dedupKey", () => {
  test("creates lowercase normalized key from prefix", () => {
    const key = dedupKey("Hello World Foo Bar", 10);
    expect(key).toBe("hello worl");
  });

  test("trims and normalizes whitespace", () => {
    const key = dedupKey("  Hello   World  ", 10);
    // After normalize: "hello world" → substring(0, 10)
    expect(key).toBe("hello worl");
  });

  test("normalize before substring fixes prefix with leading spaces", () => {
    const key = dedupKey("  Hello World", 10);
    // After normalize: "hello world" → substring(0, 10)
    expect(key).toBe("hello worl");
  });

  test("respects prefix length limit", () => {
    const key = dedupKey("abcdefghijklmnop", 5);
    expect(key).toBe("abcde");
    expect(key.length).toBeLessThanOrEqual(5);
  });
});

describe("dedup", () => {
  const makeResult = (id: string, content: string) => ({
    id,
    type: "observation" as const,
    content,
    score: 0.5,
    importance: 3,
    project: null,
    createdAt: new Date(),
  });

  test("removes duplicates with same prefix", () => {
    const results = [
      makeResult("1", "Hello World Alpha"),
      makeResult("2", "Hello World Beta"),
    ];
    const deduped = dedup(results, 10);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("1");
  });

  test("keeps unique results", () => {
    const results = [
      makeResult("1", "Hello World Alpha"),
      makeResult("2", "Something Completely Different"),
    ];
    const deduped = dedup(results, 10);
    expect(deduped).toHaveLength(2);
  });

  test("returns empty for empty input", () => {
    expect(dedup([], 10)).toHaveLength(0);
  });
});

// ============================================================
// trimToTokenBudget
// ============================================================
describe("trimToTokenBudget", () => {
  const makeResult = (id: string, content: string) => ({
    id,
    type: "observation" as const,
    content,
    score: 0.5,
    importance: 3,
    project: null,
    createdAt: new Date(),
  });

  test("keeps all results under budget", () => {
    const results = [makeResult("1", "short"), makeResult("2", "also short")];
    const trimmed = trimToTokenBudget(results, 1000);
    expect(trimmed).toHaveLength(2);
  });

  test("trims when over budget", () => {
    const results = [
      makeResult("1", "short first"), // ~3 tokens
      makeResult("2", "b".repeat(400)), // ~100 tokens
      makeResult("3", "c".repeat(400)), // ~100 tokens
    ];
    const trimmed = trimToTokenBudget(results, 50);
    // First result (~3 tokens) fits, second (~100) doesn't
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0].id).toBe("1");
  });

  test("returns empty for empty input", () => {
    expect(trimToTokenBudget([], 1000)).toHaveLength(0);
  });
});

// ============================================================
// formatInjectionBlock
// ============================================================
describe("formatInjectionBlock", () => {
  const makeMem = (
    type: "observation" | "reflection" | "entity",
    content: string,
    score = 0.8,
  ) => ({
    id: "1",
    type,
    content,
    score,
    importance: 3,
    project: null,
    createdAt: new Date(),
  });

  test("wraps content in pg_memory tags", () => {
    const block = formatInjectionBlock(
      [makeMem("observation", "test memory")],
      null,
      null,
    );
    expect(block).toContain("<pg_memory>");
    expect(block).toContain("</pg_memory>");
  });

  test("includes project when provided", () => {
    const block = formatInjectionBlock([], null, "my-project");
    expect(block).toContain("project: my-project");
  });

  test("includes session_summary when provided", () => {
    const block = formatInjectionBlock([], "Learned important things", null);
    expect(block).toContain("<session_context>");
    expect(block).toContain("Learned important things");
  });

  test("formats memories with type labels and scores", () => {
    const block = formatInjectionBlock(
      [makeMem("reflection", "key insight", 0.95)],
      null,
      null,
    );
    expect(block).toContain("[REFLECTION]");
    expect(block).toContain("(95%)");
    expect(block).toContain("key insight");
  });

  test("returns empty string for no memories and no summary", () => {
    expect(formatInjectionBlock([], null, null)).toBe("");
  });

  test("handles multiple memories with dedup scores", () => {
    const mems = [
      makeMem("observation", "first finding", 0.9),
      makeMem("entity", "important concept", 0.7),
    ];
    const block = formatInjectionBlock(mems, null, "test-proj");
    expect(block).toContain("[OBSERVATION]");
    expect(block).toContain("[ENTITY]");
    expect(block).toContain("test-proj");
  });
});
