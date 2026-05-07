#!/usr/bin/env node
/**
 * Verify sync between OpenCode SQLite and PostgreSQL
 *
 * Usage: node script/verify-sync.js [--json]
 */
const { Pool } = require("pg");
const path = require("path");
const os = require("os");

// ── Config ──
const SQLITE_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "opencode",
  "opencode.db",
);
const PG_CONFIG = {
  host: "localhost",
  port: 5432,
  database: "PGOMO",
  user: "opencode",
  password: process.env.PG_PASSWORD || "123456",
};

// ── SQLite ──
function getSQLiteCounts() {
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch {
    try {
      Database = require("C:\\Users\\Grace\\.config\\opencode\\plugins\\opcode-pg-memory\\node_modules\\better-sqlite3");
    } catch (e) {
      return { error: "better-sqlite3 not available: " + e.message };
    }
  }

  let db;
  try {
    db = new Database(SQLITE_PATH, { readonly: true });
  } catch (e) {
    return { error: "Cannot open SQLite: " + e.message };
  }

  try {
    const sessions =
      db.prepare("SELECT count(*) as cnt FROM session").get()?.cnt || 0;
    const messages =
      db.prepare("SELECT count(*) as cnt FROM message").get()?.cnt || 0;
    const parts =
      db.prepare("SELECT count(*) as cnt FROM part").get()?.cnt || 0;

    // Count tool parts using LIKE on the JSON data
    const toolParts =
      db
        .prepare(
          `
      SELECT COUNT(*) as cnt FROM part p
      WHERE p.data LIKE '%"type":"tool"%'
    `,
        )
        .get()?.cnt || 0;

    // Per-session tool counts
    const sessionsData = db
      .prepare(
        `
      SELECT m.session_id, COUNT(*) as cnt
      FROM message m
      JOIN part p ON p.message_id = m.id
      WHERE p.data LIKE '%"type":"tool"%'
      GROUP BY m.session_id
      ORDER BY cnt DESC
    `,
      )
      .all();

    return { sessions, messages, parts, toolParts, sessionsData, error: null };
  } catch (e) {
    return {
      error: "SQLite query failed: " + e.message,
      sessions: 0,
      messages: 0,
      parts: 0,
      toolParts: 0,
      sessionsData: [],
    };
  } finally {
    db.close();
  }
}

// ── PostgreSQL ──
async function getPGCounts() {
  const pool = new Pool(PG_CONFIG);
  try {
    const obsResult = await pool.query(
      "SELECT count(*)::int as cnt FROM observations",
    );
    const observations = obsResult.rows[0]?.cnt || 0;

    const withToolCall = await pool.query(
      "SELECT count(*)::int as cnt FROM observations WHERE tool_call_id IS NOT NULL",
    );
    const obsWithToolCallId = withToolCall.rows[0]?.cnt || 0;

    const bySession = await pool.query(`
      SELECT sm.opencode_session_id, COUNT(o.id) as cnt
      FROM observations o
      JOIN session_map sm ON sm.id = o.session_map_id
      GROUP BY sm.opencode_session_id
      ORDER BY cnt DESC
    `);

    const byTool = await pool.query(`
      SELECT tool_name, COUNT(*) as cnt
      FROM observations
      GROUP BY tool_name
      ORDER BY cnt DESC
    `);

    const toolStatuses = await pool.query(`
      SELECT tool_status, COUNT(*) as cnt
      FROM observations WHERE tool_status IS NOT NULL
      GROUP BY tool_status ORDER BY cnt DESC
    `);

    // Embedding coverage
    const embResult = await pool.query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS with_emb,
        COUNT(*) FILTER (WHERE embedding IS NULL)::int AS null_emb,
        ROUND(COUNT(*) FILTER (WHERE embedding IS NULL) * 100.0 / GREATEST(COUNT(*), 1), 2) AS null_pct
      FROM observations
    `);
    const emb = embResult.rows[0] || {
      total: 0,
      with_emb: 0,
      null_emb: 0,
      null_pct: 0,
    };

    return {
      observations,
      obsWithToolCallId,
      bySession: bySession.rows,
      byTool: byTool.rows,
      toolStatuses: toolStatuses.rows,
      embedding: emb,
      error: null,
    };
  } catch (e) {
    return {
      error: "PG query failed: " + e.message,
      observations: 0,
      obsWithToolCallId: 0,
      bySession: [],
      byTool: [],
      toolStatuses: [],
    };
  } finally {
    await pool.end();
  }
}

// ── Main ──
async function main() {
  const sqlite = getSQLiteCounts();
  const pg = await getPGCounts();

  const isJson = process.argv.includes("--json");

  // Calculate sync ratio
  const ratio = sqlite.toolParts > 0 ? pg.observations / sqlite.toolParts : 0;
  const missingSessions = sqlite.sessionsData
    ? sqlite.sessionsData.filter((s) => {
        // Check if this session has observations
        const hasObs = pg.bySession
          ? pg.bySession.some((o) => o.opencode_session_id === s.session_id)
          : false;
        return !hasObs;
      }).length
    : 0;

  if (isJson) {
    console.log(
      JSON.stringify(
        {
          sqlite: {
            sessions: sqlite.sessions,
            messages: sqlite.messages,
            parts: sqlite.parts,
            toolParts: sqlite.toolParts,
          },
          pg: {
            observations: pg.observations,
            withToolCallId: pg.obsWithToolCallId,
            sessionsWithObservations: pg.bySession?.length || 0,
          },
          embedding: pg.embedding || {
            total: 0,
            with_emb: 0,
            null_emb: 0,
            null_pct: 0,
          },
          sync: { ratio: ratio, ratioPercent: (ratio * 100).toFixed(2) + "%" },
          perSession: (pg.bySession || []).slice(0, 20),
          perToolName: (pg.byTool || []).slice(0, 20),
          toolStatuses: pg.toolStatuses || [],
          missingSessions,
          sqliteError: sqlite.error,
          pgError: pg.error,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Formatted output
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║            PG Memory Sync Verification             ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log();
  if (sqlite.error) console.log("⚠  SQLite Error:", sqlite.error);
  if (pg.error) console.log("⚠  PG Error:", pg.error);
  console.log("SQLite (OpenCode):");
  console.log(`  Sessions:    ${sqlite.sessions}`);
  console.log(`  Messages:    ${sqlite.messages}`);
  console.log(`  Parts:       ${sqlite.parts}`);
  console.log(`  Tool Parts:  ${sqlite.toolParts}`);
  console.log();
  console.log("PostgreSQL (PGOMO):");
  console.log(`  Observations:          ${pg.observations}`);
  console.log(`  With tool_call_id:     ${pg.obsWithToolCallId}`);
  console.log(`  Sessions w/ Obs:       ${pg.bySession?.length || 0}`);
  console.log();
  console.log("Sync Ratio:");
  console.log(`  Observations / Tool Parts:  ${(ratio * 100).toFixed(2)}%`);
  console.log(
    `  Missing tool_call_id:       ${pg.observations - pg.obsWithToolCallId}`,
  );
  console.log(`  Sessions missing entirely:  ${missingSessions}`);
  console.log();
  if (pg.embedding) {
    const warn = pg.embedding.null_pct > 5;
    console.log(`Embedding Coverage:${warn ? " ⚠️" : ""}`);
    console.log(
      `  With embedding:  ${pg.embedding.with_emb} / ${pg.embedding.total} (${(100 - pg.embedding.null_pct).toFixed(2)}%)`,
    );
    if (warn)
      console.log(
        `  ⚠️  ${pg.embedding.null_emb} observations missing embedding (>5% threshold)`,
      );
    console.log();
  }
  if (pg.toolStatuses && pg.toolStatuses.length > 0) {
    console.log("Observations by Tool Status:");
    for (const s of pg.toolStatuses) {
      console.log(`  ${s.tool_status || "(null)"}: ${s.cnt}`);
    }
    console.log();
  }
  if (pg.byTool && pg.byTool.length > 0) {
    console.log("PG Observations by Tool Name (top 20):");
    for (const t of pg.byTool.slice(0, 20)) {
      console.log(`  ${t.tool_name}: ${t.cnt}`);
    }
    console.log();
  }
  if (pg.bySession && pg.bySession.length > 0) {
    console.log("Sessions with Observations (top 20):");
    for (const s of pg.bySession.slice(0, 20)) {
      // Find SQLite count for this session
      const sqliteSession = sqlite.sessionsData?.find(
        (ss) => ss.session_id === s.opencode_session_id,
      );
      const toolCalls = sqliteSession?.cnt || "?";
      const pct =
        toolCalls !== "?" && toolCalls > 0
          ? ((s.cnt / toolCalls) * 100).toFixed(1) + "%"
          : "?%";
      console.log(
        `  ${s.opencode_session_id.substring(0, 30)}...  tools:${toolCalls}  obs:${s.cnt}  (${pct})`,
      );
    }
    console.log();
  }
}

main().catch((e) => {
  console.error("Fatal error:", e.message);
  process.exit(1);
});
