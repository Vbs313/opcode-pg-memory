/**
 * timeline.ts
 *
 * Get chronological timeline around a specific memory.
 * Returns observations, reflections, and prompts interleaved
 * in chronological order around an anchor point.
 *
 * Inspired by claude-mem's timeline MCP tool.
 */

import { Pool } from "pg";
import { createLogger } from "../services/logger";

const logger = createLogger("timeline");

export interface TimelineInput {
  /** Anchor memory ID to center around */
  anchor_id: string;
  /** Items before anchor. Default: 3, Max: 10 */
  depth_before?: number;
  /** Items after anchor. Default: 3, Max: 10 */
  depth_after?: number;
  /** Filter by project */
  project?: string;
}

export interface TimelineItem {
  id: string;
  type: "observation" | "reflection";
  summary: string;
  created_at: string;
  is_anchor: boolean;
}

export async function getTimeline(
  input: TimelineInput,
  pool: Pool,
): Promise<TimelineItem[]> {
  const { anchor_id, depth_before = 3, depth_after = 3, project } = input;
  const cappedBefore = Math.min(depth_before, 10);
  const cappedAfter = Math.min(depth_after, 10);

  try {
    // Find the anchor observation's timestamp
    const anchorResult = await pool.query(
      `SELECT created_at FROM observations WHERE id = $1`,
      [anchor_id],
    );
    if (anchorResult.rows.length === 0) {
      // Try reflections
      const refAnchor = await pool.query(
        `SELECT created_at FROM reflections WHERE id = $1`,
        [anchor_id],
      );
      if (refAnchor.rows.length === 0) return [];
    }

    const anchorTime = anchorResult.rows[0]?.created_at;
    if (!anchorTime) return [];

    const items: TimelineItem[] = [];

    // Get observations BEFORE anchor
    const beforeQuery = project
      ? `SELECT o.id, o.tool_name, o.tool_input_summary, o.created_at
         FROM observations o
         LEFT JOIN session_map sm ON o.session_map_id = sm.id
         WHERE o.created_at < $1 AND sm.project_id = $2
         ORDER BY o.created_at DESC LIMIT $3`
      : `SELECT o.id, o.tool_name, o.tool_input_summary, o.created_at
         FROM observations o
         WHERE o.created_at < $1
         ORDER BY o.created_at DESC LIMIT $2`;

    const beforeParams = project
      ? [anchorTime, project, cappedBefore]
      : [anchorTime, cappedBefore];

    const before = await pool.query(beforeQuery, beforeParams);
    for (const row of before.rows) {
      items.push({
        id: row.id,
        type: "observation",
        summary: `[${row.tool_name}] ${(row.tool_input_summary || "").substring(0, 100)}`,
        created_at: row.created_at,
        is_anchor: false,
      });
    }

    // Anchor itself
    items.push({
      id: anchor_id,
      type: "observation",
      summary: "← anchor point",
      created_at: anchorTime,
      is_anchor: true,
    });

    // Get observations AFTER anchor
    const afterQuery = project
      ? `SELECT o.id, o.tool_name, o.tool_input_summary, o.created_at
         FROM observations o
         LEFT JOIN session_map sm ON o.session_map_id = sm.id
         WHERE o.created_at > $1 AND sm.project_id = $2
         ORDER BY o.created_at ASC LIMIT $3`
      : `SELECT o.id, o.tool_name, o.tool_input_summary, o.created_at
         FROM observations o
         WHERE o.created_at > $1
         ORDER BY o.created_at ASC LIMIT $2`;

    const afterParams = project
      ? [anchorTime, project, cappedAfter]
      : [anchorTime, cappedAfter];

    const after = await pool.query(afterQuery, afterParams);
    for (const row of after.rows) {
      items.push({
        id: row.id,
        type: "observation",
        summary: `[${row.tool_name}] ${(row.tool_input_summary || "").substring(0, 100)}`,
        created_at: row.created_at,
        is_anchor: false,
      });
    }

    // Sort chronologically
    items.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    return items;
  } catch (error) {
    logger.error("Failed to get timeline", error);
    return [];
  }
}
