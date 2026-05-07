import { Pool } from 'pg';
import { getEmbeddingService } from '../utils/embedding';
import { createLogger } from './logger';

const logger = createLogger('async-embedder');

interface EmbeddingJob {
  table: string;
  rowId: string;
  text: string;
}

export class AsyncEmbedder {
  private pool: Pool;
  private queue: EmbeddingJob[] = [];
  private processing = false;
  private cooldownUntil = 0;
  private readonly cooldownMs: number;
  private readonly minImportance: number;

  constructor(pool: Pool, config?: { cooldownMs?: number; minImportance?: number }) {
    this.pool = pool;
    this.cooldownMs = config?.cooldownMs ?? 300000;
    this.minImportance = config?.minImportance ?? 3;
  }

  /**
   * Enqueue an embedding job. Only processes if importance >= minImportance
   * and text is non-empty. The actual embedding runs asynchronously via setImmediate.
   */
  enqueue(table: string, rowId: string, text: string, importance?: number): void {
    if (!text || text.length === 0) return;
    if (importance !== undefined && importance < this.minImportance) return;

    this.queue.push({ table, rowId, text });

    if (!this.processing) {
      this.processing = true;
      setImmediate(() => this.drain());
    }
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      // Cooldown check — if Ollama was recently unavailable, wait
      if (Date.now() < this.cooldownUntil) {
        const remaining = this.cooldownUntil - Date.now();
        await this.sleep(Math.min(remaining, 10000));
        continue;
      }

      const job = this.queue.shift()!;

      try {
        const service = getEmbeddingService();
        if (!service) continue;

        const embedding = await service.generateEmbedding(job.text);
        if (!embedding || embedding.length === 0) continue;

        // JSON.stringify converts [0.1,0.2,...] → '[0.1,0.2,...]' which is the vector literal format
        // (pg driver serializes raw arrays as {0.1,0.2,...} which ::vector rejects)
        await this.pool.query(
          `UPDATE ${job.table} SET embedding = $1::vector WHERE id = $2 AND embedding IS NULL`,
          [JSON.stringify(embedding), job.rowId]
        );
      } catch (err: any) {
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('connect') || msg.includes('refused') || msg.includes('econnrefused') || msg.includes('timeout') || msg.includes('fetch')) {
          this.cooldownUntil = Date.now() + this.cooldownMs;
          logger.warn(`Ollama unavailable, cooling down ${this.cooldownMs / 1000}s`);
        } else {
          logger.warn(`Embedding failed: ${err.message}`);
        }
      }
    }

    this.processing = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// ============================================================================
// Module-level singleton
// ============================================================================

let _instance: AsyncEmbedder | null = null;

export function initAsyncEmbedder(pool: Pool, config?: { cooldownMs?: number; minImportance?: number }): AsyncEmbedder {
  _instance = new AsyncEmbedder(pool, config);
  return _instance;
}

export function getAsyncEmbedder(): AsyncEmbedder | null {
  return _instance;
}
