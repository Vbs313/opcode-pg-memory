/**
 * write-behind-buffer.ts
 *
 * Local SQLite buffer for observations when PostgreSQL is unavailable.
 * Flushes to PG automatically when connection is restored.
 *
 * Uses better-sqlite3 (already a dependency) for zero-overhead local storage.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { createLogger } from "../services/logger";

const logger = createLogger("write-behind-buffer");

// ============================================================
// SQLite setup
// ============================================================

let db: any = null;

function getDb(): any {
  if (db) return db;
  try {
    const Database = require("better-sqlite3");
    const dataDir = join(homedir(), ".opencode-pg-memory");
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    db = new Database(join(dataDir, "write-behind.db"));
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_map_id TEXT,
        tool_name TEXT,
        tool_input_summary TEXT,
        tool_output_summary TEXT,
        importance INTEGER DEFAULT 3,
        metadata TEXT DEFAULT '{}',
        platform_source TEXT DEFAULT 'opencode',
        agent_id TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    logger.info("Write-behind buffer initialized");
    return db;
  } catch (err) {
    logger.warn(
      "Write-behind buffer unavailable (better-sqlite3 not loaded)",
      err,
    );
    return null;
  }
}

// ============================================================
// Write — buffer an observation when PG is down
// ============================================================

export interface BufferedObservation {
  sessionMapId: string;
  toolName: string;
  toolInputSummary: string | null;
  toolOutputSummary: string | null;
  importance: number;
  metadata: Record<string, unknown>;
  platformSource: string;
  agentId: string | null;
}

export function bufferObservation(obs: BufferedObservation): boolean {
  try {
    const d = getDb();
    if (!d) return false;
    d.prepare(
      `
      INSERT INTO pending_observations
        (session_map_id, tool_name, tool_input_summary, tool_output_summary,
         importance, metadata, platform_source, agent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      obs.sessionMapId,
      obs.toolName,
      obs.toolInputSummary,
      obs.toolOutputSummary,
      obs.importance,
      JSON.stringify(obs.metadata),
      obs.platformSource,
      obs.agentId,
    );
    return true;
  } catch (err) {
    logger.error("Failed to buffer observation", err);
    return false;
  }
}

// ============================================================
// Flush — push buffered observations to PG
// ============================================================

export async function flushBuffer(
  pool: any,
): Promise<{ flushed: number; failed: number }> {
  const d = getDb();
  if (!d) return { flushed: 0, failed: 0 };

  let flushed = 0;
  let failed = 0;

  try {
    const rows = d
      .prepare("SELECT * FROM pending_observations ORDER BY id ASC LIMIT 100")
      .all();
    if (rows.length === 0) return { flushed: 0, failed: 0 };

    for (const row of rows) {
      try {
        await pool.query(
          `INSERT INTO observations
           (session_map_id, tool_name, tool_input_summary, tool_output_summary,
            importance, metadata, platform_source, agent_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            row.session_map_id,
            row.tool_name,
            row.tool_input_summary,
            row.tool_output_summary,
            row.importance,
            row.metadata,
            row.platform_source,
            row.agent_id,
          ],
        );
        d.prepare("DELETE FROM pending_observations WHERE id = ?").run(row.id);
        flushed++;
      } catch {
        failed++;
      }
    }

    if (flushed > 0) {
      logger.info(
        `Flushed ${flushed} buffered observations to PG (${failed} failed)`,
      );
    }
    return { flushed, failed };
  } catch (err) {
    logger.error("Failed to flush buffer", err);
    return { flushed: 0, failed: 0 };
  }
}

// ============================================================
// Stats
// ============================================================

export function getBufferStats(): { pending: number } {
  try {
    const d = getDb();
    if (!d) return { pending: 0 };
    const row = d
      .prepare("SELECT COUNT(*) AS count FROM pending_observations")
      .get();
    return { pending: row.count };
  } catch {
    return { pending: 0 };
  }
}
