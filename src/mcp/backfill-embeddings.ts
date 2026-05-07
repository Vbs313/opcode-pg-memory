import { Pool } from 'pg';
import { getAsyncEmbedder } from '../services/async-embedder';
import { createLogger } from '../services/logger';

const logger = createLogger('backfill-embeddings');

const BATCH_SIZE = 100;

export interface BackfillEmbeddingsInput {
  /** Max observations to enqueue. 0 = unlimited (all pending). */
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
 * Uses cursor-based batching to process large backfills without loading everything at once.
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
  let totalEnqueued = 0;
  let totalSkipped = 0;
  let cursor: string | null = null;

  try {
    // Count pending
    const countResult = await pool.query(
      `SELECT count(*)::int AS cnt FROM observations WHERE importance >= 3 AND embedding IS NULL`,
    );
    const pending = countResult.rows[0]?.cnt || 0;

    if (pending === 0) {
      return { enqueued: 0, skipped: 0, pending: 0, note: 'All observations already have embeddings.' };
    }

    const maxToProcess = limit > 0 ? Math.min(limit, pending) : pending;

    // Cursor-based batch loop
    while (totalEnqueued < maxToProcess) {
      const remaining = maxToProcess - totalEnqueued;
      const batchSize = Math.min(BATCH_SIZE, remaining);

      let query: string;
      let params: any[];

      if (cursor) {
        query = `SELECT id, tool_name, tool_input_summary, tool_output_summary, importance
                 FROM observations
                 WHERE importance >= 3 AND embedding IS NULL AND id > $1
                 ORDER BY id ASC
                 LIMIT $2`;
        params = [cursor, batchSize];
      } else {
        query = `SELECT id, tool_name, tool_input_summary, tool_output_summary, importance
                 FROM observations
                 WHERE importance >= 3 AND embedding IS NULL
                 ORDER BY id ASC
                 LIMIT $1`;
        params = [batchSize];
      }

      const result = await pool.query(query, params);
      if (result.rows.length === 0) break;

      for (const row of result.rows) {
        if (totalEnqueued >= maxToProcess) break;

        const text = `[${row.tool_name || 'tool'}] ${row.tool_output_summary || row.tool_input_summary || ''}`;
        if (!text || text.length <= 3) {
          totalSkipped++;
          continue;
        }
        embedder.enqueue('observations', row.id, text, row.importance);
        totalEnqueued++;
        cursor = row.id;
      }
    }

    const remaining = pending - totalEnqueued;

    logger.info(`Backfill: enqueued ${totalEnqueued}, skipped ${totalSkipped}, ${remaining} remaining`);

    return {
      enqueued: totalEnqueued,
      skipped: totalSkipped,
      pending: remaining,
      note: `Enqueued ${totalEnqueued} observations (${remaining} remaining). Use sync_health() to monitor progress.`,
    };
  } catch (err: any) {
    logger.error('backfill_embeddings query failed', err);
    return { enqueued: totalEnqueued, skipped: totalSkipped, pending: 0, note: 'Error: ' + err.message };
  }
}
