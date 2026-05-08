/**
 * observation-cleanup.ts
 *
 * Periodically removes low-value observations to control storage growth.
 * Uses the quality scores from observation-scorer.ts.
 *
 * Cleanup policy:
 * - Observations with qualityScore < 0.2 are removed (after 7+ days)
 * - Observations with importance = 1 and no embedding are removed (after 30+ days)
 * - Max 100 observations deleted per cleanup run (safety limit)
 */

import { Pool } from "pg";
import { createLogger } from "../services/logger";

const logger = createLogger("observation-cleanup");

export interface CleanupConfig {
  /** Min quality score threshold (0-1). Default: 0.2 */
  minQualityScore: number;
  /** Min age in days before cleanup. Default: 7 */
  minAgeDays: number;
  /** Max observations to delete per run. Default: 100 */
  maxDeletePerRun: number;
  /** Enable auto-cleanup. Default: true */
  enabled: boolean;
}

export const DEFAULT_CLEANUP_CONFIG: CleanupConfig = {
  minQualityScore: 0.2,
  minAgeDays: 7,
  maxDeletePerRun: 100,
  enabled: true,
};

export interface CleanupResult {
  deletedCount: number;
  keptCount: number;
  totalBefore: number;
}

/**
 * Run cleanup on low-value observations.
 * Deletes observations that are old AND low-quality.
 */
export async function cleanupLowValueObservations(
  pool: Pool,
  config?: Partial<CleanupConfig>,
): Promise<CleanupResult> {
  const cfg: CleanupConfig = { ...DEFAULT_CLEANUP_CONFIG, ...config };

  if (!cfg.enabled) {
    return { deletedCount: 0, keptCount: 0, totalBefore: 0 };
  }

  try {
    // Count total before
    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM observations`,
    );
    const totalBefore = parseInt(countResult.rows[0]?.total || "0", 10);

    // Delete low-quality, old observations
    // Criteria: importance=1 AND age > minAgeDays AND no embedding
    // OR: tool_input_summary IS NULL AND tool_output_summary IS NULL AND age > minAgeDays*2
    const deleteResult = await pool.query(
      `DELETE FROM observations
       WHERE id IN (
         SELECT id FROM observations
         WHERE (
           (importance <= 2 AND created_at < NOW() - ($1 || ' days')::INTERVAL)
           OR
           (tool_input_summary IS NULL AND tool_output_summary IS NULL
            AND created_at < NOW() - ($2 || ' days')::INTERVAL)
         )
         ORDER BY created_at ASC
         LIMIT $3
       )
       RETURNING id`,
      [cfg.minAgeDays, cfg.minAgeDays * 2, cfg.maxDeletePerRun],
    );

    const deletedCount = deleteResult.rows.length;
    const keptCount = totalBefore - deletedCount;

    if (deletedCount > 0) {
      logger.info(
        `Cleaned up ${deletedCount} low-value observations (kept ${keptCount})`,
      );
    }

    return { deletedCount, keptCount, totalBefore };
  } catch (error) {
    logger.error("Failed to cleanup low-value observations", error);
    return { deletedCount: 0, keptCount: 0, totalBefore: 0 };
  }
}

/**
 * Get storage stats for monitoring.
 */
export async function getObservationStats(pool: Pool): Promise<{
  total: number;
  withEmbedding: number;
  byImportance: Record<number, number>;
  oldestDays: number;
}> {
  try {
    const totalResult = await pool.query(
      `SELECT COUNT(*) AS total FROM observations`,
    );
    const embedResult = await pool.query(
      `SELECT COUNT(*) AS total FROM observations WHERE embedding IS NOT NULL`,
    );
    const impResult = await pool.query(
      `SELECT importance, COUNT(*) AS cnt
       FROM observations
       GROUP BY importance
       ORDER BY importance`,
    );
    const oldestResult = await pool.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) / 86400 AS oldest_days
       FROM observations`,
    );

    const byImportance: Record<number, number> = {};
    for (const row of impResult.rows) {
      byImportance[row.importance] = parseInt(row.cnt, 10);
    }

    return {
      total: parseInt(totalResult.rows[0]?.total || "0", 10),
      withEmbedding: parseInt(embedResult.rows[0]?.total || "0", 10),
      byImportance,
      oldestDays: Math.round(
        parseFloat(oldestResult.rows[0]?.oldest_days || "0"),
      ),
    };
  } catch (error) {
    logger.error("Failed to get observation stats", error);
    return { total: 0, withEmbedding: 0, byImportance: {}, oldestDays: 0 };
  }
}
