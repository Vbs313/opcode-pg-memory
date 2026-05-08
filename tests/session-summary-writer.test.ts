/**
 * session-summary-writer.test.ts
 *
 * Tests for SessionSummaryInput type and module structure.
 * DB-dependent writeSessionSummary/buildAndWriteSessionSummary require a PG pool.
 */

describe("session-summary-writer module exports", () => {
  test("exports writeSessionSummary function", () => {
    const mod = require("../src/injection/session-summary-writer");
    expect(typeof mod.writeSessionSummary).toBe("function");
  });

  test("exports buildAndWriteSessionSummary function", () => {
    const mod = require("../src/injection/session-summary-writer");
    expect(typeof mod.buildAndWriteSessionSummary).toBe("function");
  });
});
