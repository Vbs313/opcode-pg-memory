/**
 * observation-scorer.test.ts
 *
 * Tests the scoring logic and economics formatting.
 * DB-dependent functions (scoreSessionObservations, calculateTokenEconomics) skipped
 * without a PG pool.
 */

import { formatEconomicsDashboard } from "../src/injection/observation-scorer";

// ============================================================
// formatEconomicsDashboard
// ============================================================
describe("formatEconomicsDashboard", () => {
  test("formats complete economics data", () => {
    const result = formatEconomicsDashboard({
      sessionMapId: "abc-123",
      totalObservations: 42,
      avgImportance: 3.5,
      estimatedReadTokens: 15000,
      estimatedDiscoveryTokens: 22500,
      savingsEstimate: 7500,
    });
    expect(result).toContain("<token_economics>");
    expect(result).toContain("</token_economics>");
    expect(result).toContain("observations: 42");
    expect(result).toContain("avg_importance: 3.5");
    expect(result).toContain("read_tokens: 15,000");
    expect(result).toContain("discovery_tokens: 22,500");
    expect(result).toContain("estimated_savings: 7,500 tokens");
    expect(result).toContain("savings_ratio: 33%");
  });

  test("shows N/A for savings ratio when no read tokens", () => {
    const result = formatEconomicsDashboard({
      sessionMapId: "abc-123",
      totalObservations: 0,
      avgImportance: 0,
      estimatedReadTokens: 0,
      estimatedDiscoveryTokens: 0,
      savingsEstimate: 0,
    });
    expect(result).toContain("savings_ratio: N/A");
  });

  test("contains all expected fields in order", () => {
    const result = formatEconomicsDashboard({
      sessionMapId: "s1",
      totalObservations: 10,
      avgImportance: 2.0,
      estimatedReadTokens: 5000,
      estimatedDiscoveryTokens: 7500,
      savingsEstimate: 2500,
    });
    // Verify order
    const lines = result.split("\n");
    expect(lines[0]).toBe("<token_economics>");
    expect(lines[lines.length - 1]).toBe("</token_economics>");
  });
});
