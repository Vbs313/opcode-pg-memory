/**
 * skeleton-injector.ts
 *
 * Project skeleton builder — walks project file entities from PG with token budget control.
 * Falls back to module/function entities when no file entities are found.
 */
import { Pool } from "pg";
import { createLogger } from "../services/logger";
import { estimateTokens } from "./ranking";

const logger = createLogger("skeleton-injector");

/**
 * Query project skeleton: append files one by one, token-budget aware, never truncate filenames.
 * Target token budget: 150 (≈600 English chars), to avoid displacing core memories.
 */
export async function getProjectSkeleton(
  projectId: string,
  pool: Pool,
  maxTokens = 150,
): Promise<string | null> {
  try {
    const { rows } = await pool.query(
      `SELECT e.name, e.weight FROM entities e
       JOIN session_map sm ON e.session_map_id = sm.id
       WHERE sm.project_id = $1 AND e.type = 'file'
         AND e.last_seen_at > NOW() - INTERVAL '14 days'
       ORDER BY e.weight DESC, e.last_seen_at DESC`,
      [projectId],
    );
    if (rows.length === 0) {
      // Fallback: no file entities → query module/function entities
      const { rows: fallbackRows } = await pool.query(
        `SELECT e.name, e.weight FROM entities e
         JOIN session_map sm ON e.session_map_id = sm.id
         WHERE sm.project_id = $1 AND e.type IN ('module', 'function')
           AND e.last_seen_at > NOW() - INTERVAL '14 days'
         ORDER BY e.weight DESC LIMIT 10`,
        [projectId],
      );
      if (fallbackRows.length === 0) return null;
      let skeleton = "top modules: ";
      let budget = estimateTokens(skeleton);
      for (const row of fallbackRows) {
        const entry = `${row.name} (${Math.round(row.weight)}×)`;
        const cost = estimateTokens(entry + ", ");
        if (budget + cost > maxTokens) break;
        skeleton +=
          (budget === estimateTokens("top modules: ") ? "" : ", ") + entry;
        budget += cost;
      }
      return skeleton === "top modules: " ? null : skeleton;
    }

    let skeleton = "top files: ";
    let budget = estimateTokens(skeleton);
    for (const row of rows) {
      const entry = `${row.name} (${Math.round(row.weight)}×)`;
      const cost = estimateTokens(entry + ", ");
      if (budget + cost > maxTokens) break;
      skeleton +=
        (budget === estimateTokens("top files: ") ? "" : ", ") + entry;
      budget += cost;
    }
    return skeleton === "top files: " ? null : skeleton;
  } catch (err) {
    logger.warn("Failed to fetch project skeleton:", err);
    return null;
  }
}
