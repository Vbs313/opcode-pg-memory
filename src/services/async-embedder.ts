import { Pool } from 'pg';
import { getEmbeddingService } from '../utils/embedding';
import { createLogger } from './logger';

const logger = createLogger('async-embedder');

const MAX_QUEUE = 5000;

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
  private droppedJobs = 0;

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

    if (this.queue.length >= MAX_QUEUE) {
      this.droppedJobs++;
      logger.warn(`Embedder queue full (${MAX_QUEUE}), dropping observation ${rowId.substring(0, 8)}`);
      return;
    }

    this.queue.push({ table, rowId, text });

    if (!this.processing) {
      this.processing = true;
      setImmediate(() => this.drain());
    }
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getDroppedCount(): number {
    return this.droppedJobs;
  }

  /**
   * Returns timestamp (ms) when cooldown expires, or null if not cooling.
   */
  getCooldownUntil(): number | null {
    return this.cooldownUntil > Date.now() ? this.cooldownUntil : null;
  }

  private async drain(): Promise<void> {
    if (this.queue.length > 50) {
      logger.warn(`Embedder queue growing (${this.queue.length} pending). Check Ollama connectivity.`);
    }

    while (this.queue.length > 0) {
      // Cooldown check — if Ollama was recently unavailable, wait
      if (Date.now() < this.cooldownUntil) {
        const remaining = this.cooldownUntil - Date.now();
        await this.sleep(Math.min(remaining, 10000));
        continue;
      }

      // Peek at first item without removing — only shift() on success
      const job = this.queue[0];

      try {
        const service = getEmbeddingService();
        if (!service) {
          // No embedding backend available, skip remaining queue
          this.queue = [];
          break;
        }

        const embedding = await service.generateEmbedding(job.text);
        if (!embedding || embedding.length === 0) {
          this.queue.shift(); // Skip unembeddable item
          continue;
        }

        // JSON.stringify converts [0.1,0.2,...] → '[0.1,0.2,...]' which is the vector literal format
        // (pg driver serializes raw arrays as {0.1,0.2,...} which ::vector rejects)
        await this.pool.query(
          `UPDATE ${job.table} SET embedding = $1::vector WHERE id = $2 AND embedding IS NULL`,
          [JSON.stringify(embedding), job.rowId]
        );
        this.queue.shift(); // Success: remove from queue
      } catch (err: any) {
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('connect') || msg.includes('refused') || msg.includes('econnrefused') || msg.includes('timeout') || msg.includes('fetch')) {
          this.cooldownUntil = Date.now() + this.cooldownMs;
          logger.warn(`Ollama unavailable, cooling down ${this.cooldownMs / 1000}s`);
          // Item stays in queue — retry after cooldown
        } else {
          logger.warn(`Embedding failed: ${err.message}`);
          this.queue.shift(); // Non-recoverable: skip this item
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
