#!/usr/bin/env node
/**
 * Batch backfill embeddings for observations with NULL embedding and importance >= 3.
 *
 * Uses Ollama directly (NOT the AsyncEmbedder queue) for historical data.
 * Formats vectors correctly: pgvector expects [0.1,0.2,...] style, not PG array format.
 *
 * Usage:
 *   node scripts/backfill-embeddings.js                          # full backfill
 *   node scripts/backfill-embeddings.js --limit 100               # quick test
 *   node scripts/backfill-embeddings.js --batch-size 100          # custom batch
 *   node scripts/backfill-embeddings.js --dry-run                 # count only
 *   node scripts/backfill-embeddings.js --limit 10 --json         # JSON summary
 *
 * Env: PG_PASSWORD (default: 123456), EMBEDDING_PROVIDER (default: ollama),
 *      EMBEDDING_MODEL (default: qwen3-embedding:0.6b), EMBEDDING_DIMENSIONS (default: 1024)
 */
const { Pool } = require('pg');
const pgvector = require('pgvector');

const { getEmbeddingService } = require('../dist/src/utils/embedding');

// ── Argument parsing ──
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    batchSize: 50,
    limit: null,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--batch-size': opts.batchSize = parseInt(args[++i], 10); break;
      case '--limit': opts.limit = parseInt(args[++i], 10); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
    }
  }
  return opts;
}

// ── Helpers ──
const sleep = ms => new Promise(r => setTimeout(r, ms));

function isOllamaDown(err) {
  const msg = (err.message || '').toLowerCase();
  return msg.includes('connect') || msg.includes('refused')
    || msg.includes('econnrefused') || msg.includes('timeout')
    || msg.includes('fetch');
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${m % 60}m${s % 60}s` : m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

/**
 * Format embedding array to pgvector literal string.
 * pgvector expects: [0.1,0.2,...] - JSON.stringify produces exactly this format.
 * Using pgvector.toSql for consistency with the codebase.
 */
function formatVector(embedding) {
  return pgvector.toSql(embedding);
}

// ── Main ──
async function main() {
  const args = parseArgs();
  const pool = new Pool({
    host: 'localhost', port: 5432, database: 'PGOMO',
    user: 'opencode', password: process.env.PG_PASSWORD || '123456',
  });

  // Count total pending
  const countResult = await pool.query(
    'SELECT count(*)::int AS cnt FROM observations WHERE importance >= 3 AND embedding IS NULL'
  );
  const total = countResult.rows[0].cnt;

  if (args.json && args.dryRun) {
    console.log(JSON.stringify({ pending: total, batchSize: args.batchSize, limit: args.limit }));
    await pool.end();
    return;
  }

  console.log(`Starting backfill: ${total} observations with NULL embedding\n`);

  if (args.dryRun) {
    console.log(`[DRY-RUN] Would backfill ${total} observations`);
    console.log(`  batch-size: ${args.batchSize}, limit: ${args.limit || 'unlimited'}`);
    await pool.end();
    return;
  }

  // Initialize embedding service
  const svc = getEmbeddingService();
  if (!svc) {
    console.error('ERROR: Embedding service not available. Is Ollama running?');
    await pool.end();
    process.exit(1);
  }

  const effectiveLimit = args.limit || total;
  let processed = 0;
  let failed = 0;
  let cooldownUntil = 0;
  let batchIndex = 0;
  const startTime = Date.now();
  const errors = [];

  while (processed < effectiveLimit) {
    // Cooldown check
    const now = Date.now();
    if (now < cooldownUntil) {
      const waitMs = cooldownUntil - now;
      console.log(`  [COOLDOWN] Waiting ${Math.ceil(waitMs / 1000)}s for Ollama...`);
      await sleep(waitMs);
    }

    // Fetch next batch (idempotent: WHERE embedding IS NULL ensures no double-processing)
    const batch = await pool.query(`
      SELECT id, tool_name, tool_input_summary, tool_output_summary, importance
      FROM observations
      WHERE importance >= 3 AND embedding IS NULL
      ORDER BY created_at ASC
      LIMIT $1
    `, [args.batchSize]);

    if (batch.rows.length === 0) break;

    batchIndex++;
    const batchStartTime = Date.now();
    let batchProcessed = 0;

    for (const row of batch.rows) {
      if (processed >= effectiveLimit) break;

      // Cooldown check inside batch too
      if (Date.now() < cooldownUntil) {
        const waitMs = cooldownUntil - Date.now();
        console.log(`\n  [COOLDOWN] Waiting ${Math.ceil(waitMs / 1000)}s for Ollama...`);
        await sleep(waitMs);
      }

      try {
        // Build text: prefer tool_output_summary, fallback to tool_input_summary
        const text = `[${row.tool_name || 'tool'}] ${row.tool_output_summary || row.tool_input_summary || ''}`;
        const truncated = text.substring(0, 2000);

        const embedding = await svc.generateEmbedding(truncated);
        const vecStr = formatVector(embedding);

        // Idempotent update: WHERE embedding IS NULL ensures we don't overwrite
        const result = await pool.query(
          'UPDATE observations SET embedding = $1::vector WHERE id = $2 AND embedding IS NULL',
          [vecStr, row.id]
        );

        if (result.rowCount > 0) {
          processed++;
          batchProcessed++;
        }
      } catch (err) {
        failed++;
        errors.push({ id: row.id, error: err.message.substring(0, 200) });
        if (isOllamaDown(err)) {
          cooldownUntil = Date.now() + 300000; // 5 min cooldown
          console.log(`\n  [OLLAMA DOWN] Cooling down 5min. Error: ${err.message.substring(0, 100)}`);
          break; // Break inner loop, re-fetch batch after cooldown
        }
      }
    }

    // Print progress
    const elapsed = Date.now() - startTime;
    const rate = elapsed > 0 ? (processed / (elapsed / 1000)).toFixed(1) : '?';
    const batchTime = formatDuration(Date.now() - batchStartTime);
    const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : '0.0';
    const totalBatches = Math.ceil(effectiveLimit / args.batchSize);

    if (!args.json) {
      console.log(
        `  Batch ${batchIndex}/${totalBatches}: ${processed}/${effectiveLimit} (${pct}%) | ${batchTime} | ${rate}/s`
      );
    }
  }

  // ── Final summary ──
  const elapsed = Date.now() - startTime;
  const rate = elapsed > 0 ? (processed / (elapsed / 1000)).toFixed(1) : '?';

  // Count remaining NULL embeddings
  const remainingResult = await pool.query(
    'SELECT count(*)::int AS cnt FROM observations WHERE importance >= 3 AND embedding IS NULL'
  );
  const remaining = remainingResult.rows[0].cnt;
  const nullPct = total > 0 ? ((remaining / total) * 100).toFixed(2) : '0.00';

  if (args.json) {
    console.log(JSON.stringify({
      total,
      attempted: processed + failed,
      processed,
      failed,
      remaining,
      remainingPct: nullPct + '%',
      durationMs: elapsed,
      duration: formatDuration(elapsed),
      rate: parseFloat(rate),
      errors: errors.length > 0 ? errors.slice(0, 10) : [],
    }));
  } else {
    console.log();
    console.log('─'.repeat(50));
    console.log('BACKFILL COMPLETE');
    console.log('─'.repeat(50));
    console.log(`  Total pending:      ${total}`);
    console.log(`  Processed:          ${processed}`);
    console.log(`  Failed:             ${failed}`);
    console.log(`  Duration:           ${formatDuration(elapsed)}`);
    console.log(`  Rate:               ${rate}/s`);
    console.log(`  Remaining NULL:     ${remaining} (${nullPct}% of original)`);
    if (errors.length > 0) {
      console.log();
      console.log(`  Errors (${errors.length} total, showing first 10):`);
      for (const e of errors.slice(0, 10)) {
        console.log(`    - [${e.id}] ${e.error}`);
      }
    }
    console.log();
    if (remaining === 0) {
      console.log('✓ All embeddings backfilled successfully.');
    } else {
      console.log(`⚠ ${remaining} observations still have NULL embedding.`);
    }
  }

  await pool.end();
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
