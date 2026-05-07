/**
 * error-classifier.test.ts — 错误分类系统测试
 *
 * 验证 7 类错误 × 20+ 模式匹配的正确性。
 */

import { classifyError, guard, guardSync } from "../src/utils/error-classifier";

describe("classifyError", () => {
  // ── connection errors ──
  test("ECONNREFUSED → connection/fatal", () => {
    const r = classifyError(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
    expect(r.category).toBe("connection");
    expect(r.severity).toBe("fatal");
    expect(r.recoverable).toBe(false);
  });

  test("ETIMEDOUT → connection/error/recoverable", () => {
    const r = classifyError(new Error("connect ETIMEDOUT"));
    expect(r.category).toBe("connection");
    expect(r.severity).toBe("error");
    expect(r.recoverable).toBe(true);
  });

  test("password auth failed → connection/fatal/recoverable", () => {
    const r = classifyError(new Error("password authentication failed"));
    expect(r.severity).toBe("fatal");
    expect(r.recoverable).toBe(true);
    expect(r.suggestion).toContain("PG_PASSWORD");
  });

  test("database does not exist → connection/fatal", () => {
    const r = classifyError(new Error('database "PGOMO" does not exist'));
    expect(r.category).toBe("connection");
    expect(r.suggestion).toContain("创建");
  });

  test("getaddrinfo ENOTFOUND → connection/fatal/recoverable", () => {
    const r = classifyError(new Error("getaddrinfo ENOTFOUND myhost"));
    expect(r.category).toBe("connection");
    expect(r.recoverable).toBe(true);
  });

  // ── query errors ──
  test("relation does not exist → query/error", () => {
    const r = classifyError(
      new Error('relation "observations" does not exist'),
    );
    expect(r.category).toBe("query");
    expect(r.severity).toBe("error");
  });

  test("duplicate key → query/warn/recoverable", () => {
    const r = classifyError(
      new Error("duplicate key value violates unique constraint"),
    );
    expect(r.category).toBe("query");
    expect(r.severity).toBe("warn");
    expect(r.recoverable).toBe(true);
  });

  test("foreign key violation → query/error", () => {
    const r = classifyError(new Error("violates foreign key constraint"));
    expect(r.category).toBe("query");
  });

  // ── embedding errors ──
  test("ollama connection refused → embedding/warn/recoverable", () => {
    const r = classifyError(new Error("ollama connection refused"));
    expect(r.category).toBe("embedding");
    expect(r.severity).toBe("warn");
    expect(r.recoverable).toBe(true);
  });

  test("embedding timeout → embedding/warn/recoverable", () => {
    const r = classifyError(new Error("embedding timeout after 10s"));
    expect(r.category).toBe("embedding");
  });

  // ── external errors ──
  test("5xx → external/error/recoverable", () => {
    const r = classifyError(new Error("HTTP 502 Bad Gateway"));
    expect(r.category).toBe("external");
    expect(r.recoverable).toBe(true);
  });

  test("429 → external/warn/recoverable", () => {
    const r = classifyError(new Error("429 Too Many Requests"));
    expect(r.category).toBe("external");
    expect(r.severity).toBe("warn");
  });

  // ── internal / unknown ──
  test("unknown error defaults to internal", () => {
    const r = classifyError(new Error("something weird happened"));
    expect(r.category).toBe("internal");
    expect(r.recoverable).toBe(false);
  });

  test("null/undefined error handled gracefully", () => {
    const r = classifyError(null);
    expect(r.category).toBe("internal");
    expect(r.message).toContain("Unknown error");
  });

  test("string error handled", () => {
    const r = classifyError("plain string error");
    expect(r.message).toContain("plain string error");
  });

  test("custom default category works", () => {
    const r = classifyError(new Error("random"), "query");
    expect(r.category).toBe("query"); // falls through to default
  });
});

describe("guard", () => {
  test("returns result on success", async () => {
    const [result, err] = await guard(Promise.resolve(42), "query");
    expect(result).toBe(42);
    expect(err).toBeNull();
  });

  test("returns classified error on failure", async () => {
    const [result, err] = await guard(
      Promise.reject(new Error("connect ECONNREFUSED")),
      "connection",
    );
    expect(result).toBeNull();
    expect(err?.category).toBe("connection");
    expect(err?.severity).toBe("fatal");
  });

  test("handles null rejection gracefully", async () => {
    const [result, err] = await guard(Promise.reject(null), "internal");
    expect(result).toBeNull();
    expect(err).not.toBeNull();
  });

  test("non-error rejection string", async () => {
    const [result, err] = await guard(Promise.reject("fail"), "internal");
    expect(result).toBeNull();
    expect(err?.message).toContain("fail");
  });
});

describe("guardSync", () => {
  test("returns result on success", () => {
    const [result, err] = guardSync(() => 42, "query");
    expect(result).toBe(42);
    expect(err).toBeNull();
  });

  test("returns error on throw", () => {
    const [result, err] = guardSync(() => {
      throw new Error("ollama connection refused");
    }, "embedding");
    expect(result).toBeNull();
    expect(err?.category).toBe("embedding");
  });
});
