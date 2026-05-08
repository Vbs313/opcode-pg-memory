/**
 * observation-cleanup.test.ts
 *
 * Tests the cleanup configuration and stats parsing.
 * DB-dependent functions (cleanupLowValueObservations, getObservationStats) are
 * tested via their config structure and default values.
 */

import {
  DEFAULT_CLEANUP_CONFIG,
  type CleanupConfig,
} from "../src/injection/observation-cleanup";

describe("DEFAULT_CLEANUP_CONFIG", () => {
  test("has valid defaults", () => {
    expect(DEFAULT_CLEANUP_CONFIG).toBeDefined();
    expect(DEFAULT_CLEANUP_CONFIG.minQualityScore).toBe(0.2);
    expect(DEFAULT_CLEANUP_CONFIG.minAgeDays).toBe(7);
    expect(DEFAULT_CLEANUP_CONFIG.maxDeletePerRun).toBe(100);
    expect(DEFAULT_CLEANUP_CONFIG.enabled).toBe(true);
  });

  test("minAgeDays is reasonable", () => {
    expect(DEFAULT_CLEANUP_CONFIG.minAgeDays).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_CLEANUP_CONFIG.minAgeDays).toBeLessThanOrEqual(90);
  });

  test("maxDeletePerRun is bounded", () => {
    expect(DEFAULT_CLEANUP_CONFIG.maxDeletePerRun).toBeGreaterThan(0);
    expect(DEFAULT_CLEANUP_CONFIG.maxDeletePerRun).toBeLessThanOrEqual(1000);
  });

  test("minQualityScore is between 0 and 1", () => {
    expect(DEFAULT_CLEANUP_CONFIG.minQualityScore).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_CLEANUP_CONFIG.minQualityScore).toBeLessThanOrEqual(1);
  });
});
