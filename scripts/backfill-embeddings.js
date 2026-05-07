#!/usr/bin/env node
/**
 * CLI wrapper for backfillEmbeddings MCP tool.
 *
 * All core logic (cursor-based batching, cooldown, queue) lives in the MCP tool
 * at src/mcp/backfill-embeddings.ts, which feeds the AsyncEmbedder queue.
 *
 * Usage:
 *   node scripts/backfill-embeddings.js                          # full backfill
 *   node scripts/backfill-embeddings.js --limit 100               # quick test
 *   node scripts/backfill-embeddings.js --dry-run                 # count only
 *   node scripts/backfill-embeddings.js --limit 10 --json         # JSON summary
 *
 * Env: PG_PASSWORD (default: 123456)
 *
 * Changed from v1:
 *   - --batch-size is no longer needed (cursor batch size is internal)
 *   - Ollama cooldown/retry handled by AsyncEmbedder automatically
 *   - Embedding model config via EMBEDDING_PROVIDER / EMBEDDING_MODEL / EMBEDDING_DIMENSIONS
 */
const { Pool } = require('pg');
const { backfillEmbeddings } = require('../dist/src/mcp/backfill-embeddings');
const { initAsyncEmbedder } = require('../dist/src/services/async-embedder');

// ── Argument parsing ──
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { limit: 0, dryRun: false, json: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--limit': opts.limit = parseInt(args[++i], 10) || 0; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
    }
  }
  return opts;
}

// ── Main ──
async function main() {
  const opts = parseArgs();

  const pool = new Pool({
    host: 'localhost', port: 5432, database: 'PGOMO',
    user: 'opencode', password: process.env.PG_PASSWORD || '123456',
  });

  try {
    // Check pending count
    const countResult = await pool.query(
      'SELECT count(*)::int AS cnt FROM observations WHERE importance >= 3 AND embedding IS NULL'
    );
    const pending = countResult.rows[0]?.cnt || 0;

    if (opts.dryRun) {
      if (opts.json) {
        console.log(JSON.stringify({ pending, limit: opts.limit || null }));
      } else {
        console.log(`Pending observations to backfill: ${pending}${opts.limit ? ` (limit: ${opts.limit})` : ''}`);
      }
      return;
    }

    if (pending === 0) {
      if (opts.json) {
        console.log(JSON.stringify({ enqueued: 0, pending: 0, note: 'All observations already have embeddings.' }));
      } else {
        console.log('All observations already have embeddings.');
      }
      return;
    }

    // Initialize AsyncEmbedder (needed for the queue and backfillEmbeddings)
    initAsyncEmbedder(pool);

    const limitArg = opts.limit || undefined;
    if (!opts.json) {
      console.log(`Backfilling ${limitArg || pending} observations...`);
    }

    const result = await backfillEmbeddings({ limit: limitArg }, pool);

    if (opts.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`  Enqueued: ${result.enqueued}`);
      console.log(`  Skipped:  ${result.skipped}`);
      console.log(`  Pending:  ${result.pending}`);
      console.log(`  Note:     ${result.note}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
