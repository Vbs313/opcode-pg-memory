/**
 * session-summary-writer.ts
 *
 * Writes session summary records to the session_summaries table.
 * Triggered by session.compacted events from the event bus.
 *
 * Data structure (aligned with claude-mem session_summaries):
 *   request, investigated, learned, completed, next_steps
 */

import { Pool } from "pg";
import { createLogger } from "../services/logger";

const logger = createLogger("session-summary-writer");

// ============================================================
// Types
// ============================================================

export interface SessionSummaryInput {
  opencodeSessionId: string;
  projectId?: string;
  platformSource?: string;
  request?: string;
  investigated?: string;
  learned?: string;
  completed?: string;
  nextSteps?: string;
  /** Raw token count for the summary */
  tokenCount?: number;
}

// ============================================================
// Session Summary Writer
// ============================================================

/**
 * Write or update a session summary record.
 * Uses UPSERT (INSERT ... ON CONFLICT) to avoid duplicates.
 */
export async function writeSessionSummary(
  input: SessionSummaryInput,
  pool: Pool,
): Promise<void> {
  const {
    opencodeSessionId,
    projectId,
    platformSource = "opencode",
    request,
    investigated,
    learned,
    completed,
    nextSteps,
    tokenCount = 0,
  } = input;

  if (!opencodeSessionId) {
    logger.warn("Cannot write session summary: no session ID");
    return;
  }

  try {
    // Check if a summary already exists for this session
    const existing = await pool.query(
      "SELECT id FROM session_summaries WHERE opencode_session_id = $1",
      [opencodeSessionId],
    );

    if (existing.rows.length > 0) {
      // Update existing record
      await pool.query(
        `UPDATE session_summaries SET
          project_id = COALESCE($1, project_id),
          platform_source = COALESCE($2, platform_source),
          request = COALESCE($3, request),
          investigated = COALESCE($4, investigated),
          learned = COALESCE($5, learned),
          completed = COALESCE($6, completed),
          next_steps = COALESCE($7, next_steps),
          token_count = GREATEST(token_count, $8),
          updated_at = NOW()
        WHERE opencode_session_id = $9`,
        [
          projectId ?? null,
          platformSource,
          request ?? null,
          investigated ?? null,
          learned ?? null,
          completed ?? null,
          nextSteps ?? null,
          tokenCount,
          opencodeSessionId,
        ],
      );
      logger.info(`Updated session summary for ${opencodeSessionId}`);
    } else {
      // Insert new record
      await pool.query(
        `INSERT INTO session_summaries
          (opencode_session_id, project_id, platform_source,
           request, investigated, learned, completed, next_steps, token_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          opencodeSessionId,
          projectId ?? null,
          platformSource,
          request ?? null,
          investigated ?? null,
          learned ?? null,
          completed ?? null,
          nextSteps ?? null,
          tokenCount,
        ],
      );
      logger.info(`Created session summary for ${opencodeSessionId}`);
    }
  } catch (error) {
    logger.error("Failed to write session summary", error);
    // Non-blocking
  }
}

/**
 * Build a session summary from available data sources.
 * Called when session.compacted fires — gathers data from observations,
 * reflections, and the compaction event payload.
 */
export async function buildAndWriteSessionSummary(
  pool: Pool,
  opencodeSessionId: string,
  projectId?: string,
  /** Optional raw summary text from the compaction event */
  compactionSummary?: string,
): Promise<void> {
  try {
    // Get the session_map entry
    const sessionRow = await pool.query(
      "SELECT id, project_id FROM session_map WHERE opencode_session_id = $1",
      [opencodeSessionId],
    );
    if (sessionRow.rows.length === 0) {
      logger.warn(
        `No session_map entry for ${opencodeSessionId}, skipping summary`,
      );
      return;
    }

    const sessionInternalId = sessionRow.rows[0].id;
    const effectiveProjectId = projectId || sessionRow.rows[0].project_id;

    // Gather the most important observations from this session
    const obsResult = await pool.query(
      `SELECT tool_name, tool_input_summary, tool_output_summary, importance, created_at
       FROM observations
       WHERE session_map_id = $1
       ORDER BY importance DESC, created_at DESC
       LIMIT 10`,
      [sessionInternalId],
    );

    // Gather reflections for this session
    const refResult = await pool.query(
      `SELECT summary, pattern_type, confidence
       FROM reflections
       WHERE session_map_id = $1
       ORDER BY created_at DESC
       LIMIT 3`,
      [sessionInternalId],
    );

    // Build the summary fields
    const request = compactionSummary
      ? compactionSummary.substring(0, 500)
      : `Session ${opencodeSessionId}`;

    // Extract "learned" from reflections
    const learnedParts: string[] = [];
    for (const row of refResult.rows) {
      if (row.summary) {
        learnedParts.push(row.summary.substring(0, 300));
      }
    }

    // Extract "completed" from observations
    const highImpObs = obsResult.rows.filter(
      (r: any) => r.importance >= 3 && r.tool_name,
    );
    const completedParts: string[] = [];
    for (const row of highImpObs.slice(0, 5)) {
      if (row.tool_name) {
        const desc = row.tool_input_summary
          ? `${row.tool_name}: ${row.tool_input_summary.substring(0, 100)}`
          : row.tool_name;
        completedParts.push(desc);
      }
    }

    // Extract tool names as "investigated"
    const toolNames = [
      ...new Set(obsResult.rows.map((r: any) => r.tool_name).filter(Boolean)),
    ];
    const investigated =
      toolNames.length > 0 ? `Tools used: ${toolNames.join(", ")}` : undefined;

    await writeSessionSummary(
      {
        opencodeSessionId,
        projectId: effectiveProjectId,
        request,
        investigated,
        learned: learnedParts.length > 0 ? learnedParts.join("\n") : undefined,
        completed:
          completedParts.length > 0 ? completedParts.join("\n") : undefined,
        tokenCount: obsResult.rows.length,
      },
      pool,
    );
  } catch (error) {
    logger.error("Failed to build session summary", error);
  }
}
