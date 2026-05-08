/**
 * get-memory.ts
 *
 * Fetch a single memory by ID with full details.
 * Supports observations, reflections, and entities.
 *
 * Inspired by claude-mem's get_observations tool.
 */

import { Pool } from "pg";
import { createLogger } from "../services/logger";

const logger = createLogger("get-memory");

export interface GetMemoryInput {
  /** Memory ID (UUID from observations, reflections, or entities table) */
  id: string;
}

export interface MemoryDetail {
  id: string;
  type: "observation" | "reflection" | "entity";
  content: Record<string, unknown>;
  created_at: string;
}

export async function getMemory(
  input: GetMemoryInput,
  pool: Pool,
): Promise<MemoryDetail | null> {
  const { id } = input;

  // Try observations first
  try {
    const obs = await pool.query(
      `SELECT o.id, o.tool_name, o.tool_input_summary, o.tool_output_summary,
              o.importance, o.created_at, o.platform_source, o.agent_id,
              sm.project_id
       FROM observations o
       LEFT JOIN session_map sm ON o.session_map_id = sm.id
       WHERE o.id = $1`,
      [id],
    );
    if (obs.rows.length > 0) {
      const r = obs.rows[0];
      return {
        id: r.id,
        type: "observation",
        content: {
          tool_name: r.tool_name,
          input_summary: r.tool_input_summary,
          output_summary: r.tool_output_summary,
          importance: r.importance,
          project: r.project_id,
          platform: r.platform_source,
          agent: r.agent_id,
        },
        created_at: r.created_at,
      };
    }

    // Try reflections
    const ref = await pool.query(
      `SELECT r.id, r.summary, r.pattern_type, r.confidence, r.created_at,
              sm.project_id
       FROM reflections r
       LEFT JOIN session_map sm ON r.session_map_id = sm.id
       WHERE r.id = $1`,
      [id],
    );
    if (ref.rows.length > 0) {
      const r = ref.rows[0];
      return {
        id: r.id,
        type: "reflection",
        content: {
          summary: r.summary,
          pattern_type: r.pattern_type,
          confidence: r.confidence,
          project: r.project_id,
        },
        created_at: r.created_at,
      };
    }

    // Try entities
    const ent = await pool.query(
      `SELECT e.id, e.name, e.type, e.description, e.weight, e.tier, e.created_at,
              sm.project_id
       FROM entities e
       LEFT JOIN session_map sm ON e.session_map_id = sm.id
       WHERE e.id = $1`,
      [id],
    );
    if (ent.rows.length > 0) {
      const r = ent.rows[0];
      return {
        id: r.id,
        type: "entity",
        content: {
          name: r.name,
          type: r.entity_type || r.type,
          description: r.description,
          weight: r.weight,
          tier: r.tier,
          project: r.project_id,
        },
        created_at: r.created_at,
      };
    }

    return null;
  } catch (error) {
    logger.error("Failed to get memory", error);
    return null;
  }
}
