/**
 * session-logger.ts
 *
 * Session logging and search — inspired by opencode-personal-knowledge's
 * session logging pattern (start_logging_session, log_message, end_session).
 *
 * Uses the existing session_map + session_summaries tables.
 */

import { Pool } from "pg";
import { createLogger } from "../services/logger";

const logger = createLogger("session-logger");

// ============================================================
// Types
// ============================================================

export interface StartSessionInput {
  /** Optional session name */
  name?: string;
  /** Project identifier */
  project?: string;
}

export interface LogMessageInput {
  /** OpenCode session ID */
  session_id: string;
  /** Message role */
  role: "user" | "agent";
  /** Message content */
  content: string;
}

export interface EndSessionInput {
  /** OpenCode session ID */
  session_id: string;
  /** Summary of what was accomplished */
  summary?: string;
  /** What was learned */
  learned?: string;
  /** Next steps */
  next_steps?: string;
}

export interface SearchSessionsInput {
  /** Search query */
  query: string;
  /** Max results. Default: 10 */
  limit?: number;
}

export interface SessionLogEntry {
  session_id: string;
  name?: string;
  summary?: string;
  message_count: number;
  created_at: string;
  relevance?: number;
}

// In-memory store for active sessions (maps opencode_session_id → metadata)
const activeSessions = new Map<string, { name?: string; startedAt: Date }>();

// ============================================================
// startSession — mark a session as active
// ============================================================

export async function startSession(
  input: StartSessionInput,
  pool: Pool,
): Promise<{ session_id: string }> {
  const { name, project } = input;

  try {
    // Find or create session_map entry
    const result = await pool.query(
      `INSERT INTO session_map (opencode_session_id, project_id, metadata)
       VALUES ($1, $2, $3)
       ON CONFLICT (opencode_session_id)
       DO UPDATE SET last_active_at = NOW()
       RETURNING id, opencode_session_id`,
      [
        `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        project ?? null,
        JSON.stringify({ name: name || null, source: "session-logger" }),
      ],
    );

    const sessionId = result.rows[0].opencode_session_id;
    activeSessions.set(sessionId, { name, startedAt: new Date() });

    logger.info(`Session started: ${sessionId}${name ? ` (${name})` : ""}`);
    return { session_id: sessionId };
  } catch (error) {
    logger.error("Failed to start session", error);
    throw error;
  }
}

// ============================================================
// logMessage — log a message to an active session
// Stores to observations table with importance=3
// ============================================================

export async function logMessage(
  input: LogMessageInput,
  pool: Pool,
): Promise<{ logged: boolean }> {
  const { session_id, role, content } = input;

  try {
    // Find the session_map entry
    const sessionResult = await pool.query(
      `SELECT id FROM session_map WHERE opencode_session_id = $1`,
      [session_id],
    );
    if (sessionResult.rows.length === 0) {
      logger.warn(`Session not found: ${session_id}`);
      return { logged: false };
    }

    const internalId = sessionResult.rows[0].id;

    // Store as an observation
    await pool.query(
      `INSERT INTO observations
       (session_map_id, tool_name, tool_input_summary, tool_output_summary,
        importance, metadata, platform_source, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        internalId,
        `session:${role}`,
        content.substring(0, 500),
        null,
        3,
        JSON.stringify({ event: "session_log", role }),
        "opencode",
        role === "agent" ? process.env.OMO_AGENT_ID || "agent" : "user",
      ],
    );

    return { logged: true };
  } catch (error) {
    logger.error("Failed to log message", error);
    return { logged: false };
  }
}

// ============================================================
// endSession — close a session with summary
// ============================================================

export async function endSession(
  input: EndSessionInput,
  pool: Pool,
): Promise<{ closed: boolean }> {
  const { session_id, summary, learned, next_steps } = input;

  try {
    // Write to session_summaries
    await pool.query(
      `INSERT INTO session_summaries
       (opencode_session_id, request, learned, next_steps, token_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [session_id, summary ?? null, learned ?? null, next_steps ?? null, 0],
    );

    activeSessions.delete(session_id);
    logger.info(`Session ended: ${session_id}`);
    return { closed: true };
  } catch (error) {
    logger.error("Failed to end session", error);
    return { closed: false };
  }
}

// ============================================================
// searchSessions — search across all logged sessions
// ============================================================

export async function searchSessions(
  input: SearchSessionsInput,
  pool: Pool,
): Promise<{ sessions: SessionLogEntry[] }> {
  const { query, limit = 10 } = input;
  const cappedLimit = Math.min(limit, 50);

  try {
    // Search across session_summaries + observations
    const { rows } = await pool.query(
      `SELECT ss.opencode_session_id,
              ss.request,
              ss.learned,
              ss.completed,
              ss.next_steps,
              ss.created_at,
              (SELECT COUNT(*) FROM observations o
               JOIN session_map sm ON o.session_map_id = sm.id
               WHERE sm.opencode_session_id = ss.opencode_session_id
              ) AS msg_count
       FROM session_summaries ss
       WHERE ss.request ILIKE $1
          OR ss.learned ILIKE $1
          OR ss.completed ILIKE $1
          OR ss.next_steps ILIKE $1
       ORDER BY ss.created_at DESC
       LIMIT $2`,
      [`%${query}%`, cappedLimit],
    );

    const sessions: SessionLogEntry[] = rows.map((r: any) => ({
      session_id: r.opencode_session_id,
      name: r.request?.substring(0, 100),
      summary: r.learned?.substring(0, 200),
      message_count: parseInt(r.msg_count || "0", 10),
      created_at: r.created_at,
    }));

    return { sessions };
  } catch (error) {
    logger.error("Failed to search sessions", error);
    return { sessions: [] };
  }
}
