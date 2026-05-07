import { Pool } from 'pg';
import { getAsyncEmbedder } from '../services/async-embedder';
import { createLogger } from '../services/logger';

const logger = createLogger('backfill-embeddings');

export interface BackfillEmbeddingsInput {
  /** Max observations to enqueue. 0 = unlimited. */
  limit?: number;
}

export interface BackfillEmbeddingsOutput {
  enqueued: number;
  skipped: number;
  pending: number;
  note: string;
}

/**
 * Enqueue observations with NULL embedding into the AsyncEmbedder queue.
 * The embedder processes them sequentially (with Ollama cooldown/retry).
 * Already-embedded observations are never touched (WHERE embedding IS NULL).
 */
export async function backfillEmbeddings(
  input: BackfillEmbeddingsInput,
  pool: Pool,
): Promise<BackfillEmbeddingsOutput> {
  const embedder = getAsyncEmbedder();
  if (!embedder) {
    return { enqueued: 0, skipped: 0, pending: 0, note: 'Embedder not initialized. Check plugin startup.' };
  }

  const limit = input.limit || 0;

  try {
    // Count pending
    const countResult = await pool.query(
      `SELECT count(*)::int AS cnt FROM observations WHERE importance >= 3 AND embedding IS NULL`,
    );
    const pending = countResult.rows[0]?.cnt || 0;

    if (pending === 0) {
      return { enqueued: 0, skipped: 0, pending: 0, note: 'All observations already have embeddings.' };
    }

    const fetchLimit = limit > 0 ? Math.min(limit, pending) : pending;

    const result = await pool.query(
      `SELECT id, tool_name, tool_input_summary, tool_output_summary, importance
       FROM observations
       WHERE importance >= 3 AND embedding IS NULL
       ORDER BY created_at ASC
       LIMIT $1`,
      [fetchLimit],
    );

    let enqueuedCount = 0;
    for (const row of result.rows) {
      const text = `[${row.tool_name || 'tool'}] ${row.tool_output_summary || row.tool_input_summary || ''}`;
      if (!text || text.length <= 3) continue;
      embedder.enqueue('observations', row.id, text, row.importance);
      enqueuedCount++;
    }

    const skipped = fetchLimit - enqueuedCount;
    const remaining = pending - enqueuedCount;

    logger.info(`Backfill: enqueued ${enqueuedCount}, ${remaining} remaining`);

    return {
      enqueued: enqueuedCount,
      skipped,
      pending: remaining,
      note: `Enqueued ${enqueuedCount} observations. Use sync_health() to monitor progress. Approx ${Math.ceil(remaining * 1.2)}s remaining at current rate.`,
    };
  } catch (err: any) {
    logger.error('backfill_embeddings query failed', err);
    return { enqueued: 0, skipped: 0, pending: 0, note: 'Query failed: ' + err.message };
  }
}
