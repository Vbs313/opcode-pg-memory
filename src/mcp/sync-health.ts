import { Pool } from 'pg';
import { getAsyncEmbedder } from '../services/async-embedder';
import { createLogger } from '../services/logger';

const logger = createLogger('sync-health');

// ============================================================
// Public input / output interfaces
// ============================================================

export interface SyncHealthInput {
  // No input parameters needed
}

export interface SyncHealthOutput {
  status: 'healthy' | 'degraded' | 'error';
  observations: {
    total: number;
    with_embedding: number;
    embedding_pct: number;
    sessions_with_obs: number;
  };
  embedder: {
    queue_length: number | null;
    cooldown_remaining_s: number | null;
  };
  warnings: string[];
}

// ============================================================
// MCP Tool: sync_health
// ============================================================

/**
 * Returns plugin sync health status: observation count, embedding coverage,
 * embedder queue state.
 */
export async function syncHealth(
  _input: SyncHealthInput,
  pool: Pool,
): Promise<SyncHealthOutput> {
  const warnings: string[] = [];

  // Query PG stats
  let total = 0;
  let withEmb = 0;
  let sessionsWithObs = 0;

  try {
    const obsResult = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS with_emb
      FROM observations
    `);
    total = obsResult.rows[0]?.total || 0;
    withEmb = obsResult.rows[0]?.with_emb || 0;

    const sessionResult = await pool.query(`
      SELECT COUNT(DISTINCT session_map_id)::int AS cnt FROM observations
    `);
    sessionsWithObs = sessionResult.rows[0]?.cnt || 0;
  } catch (err: any) {
    logger.error('sync_health PG query failed', err);
    return {
      status: 'error',
      observations: { total: 0, with_embedding: 0, embedding_pct: 0, sessions_with_obs: 0 },
      embedder: { queue_length: null, cooldown_remaining_s: null },
      warnings: ['PG query failed: ' + err.message],
    };
  }

  // Embedder stats
  const embedder = getAsyncEmbedder();
  const queueLength = embedder ? embedder.getQueueLength() : null;
  const cooldownUntil = embedder ? embedder.getCooldownUntil() : null;
  const cooldownRemaining = cooldownUntil
    ? Math.max(0, Math.round((cooldownUntil - Date.now()) / 1000))
    : null;

  // Warnings
  const embeddingPct = total > 0 ? Math.round((withEmb / total) * 10000) / 100 : 0;
  if (embeddingPct < 95) {
    warnings.push(
      `Embedding coverage below 95% (${total - withEmb} missing). Run: node scripts/backfill-embeddings.js`,
    );
  }
  if (queueLength > 50) {
    warnings.push(
      `Embedder queue growing (${queueLength} pending). Check Ollama connectivity.`,
    );
  }

  const status: 'healthy' | 'degraded' = warnings.length === 0 ? 'healthy' : 'degraded';

  return {
    status,
    observations: {
      total,
      with_embedding: withEmb,
      embedding_pct: embeddingPct,
      sessions_with_obs: sessionsWithObs,
    },
    embedder: {
      queue_length: queueLength,
      cooldown_remaining_s: cooldownRemaining,
    },
    warnings,
  };
}
