import { Pool } from 'pg';
import { createLogger } from './logger';
import type { PluginEvent, PluginEventType, EventSynchronizerConfig, SyncMode } from '../types';
import { handleSessionCreated } from '../hooks/session-created';
import { handleSessionCompleted } from '../hooks/session-completed';
import { handleSessionCompacting, handleSessionCompacted } from '../hooks/session-compacting';
import { handleMessageUpdated } from '../hooks/message-updated';
import { handleToolExecuteBefore, handleToolExecuteAfter } from '../hooks/tool-execute';

export class EventSynchronizer {
  private pool: Pool;
  private config: EventSynchronizerConfig;
  private dedupSet: Map<string, number> = new Map();  // eventId → timestamp
  private stopped = false;
  public processingCount = 0;
  private logger = createLogger('event-sync');

  constructor(pool: Pool, config: Partial<EventSynchronizerConfig> = {}) {
    this.pool = pool;
    this.config = {
      mode: 'hybrid',
      pollingIntervalMs: 5000,
      retryMaxAttempts: 3,
      retryBaseDelayMs: 50,
      eventDedupWindowMs: 5000,
      ...config,
    };
  }

  async handleEvent(event: PluginEvent): Promise<void> {
    if (this.stopped) return;

    this.processingCount++;

    try {
      // 1. Mode filtering
      if (this.config.mode === 'event-only' && event.source === 'poll') return;
      if (this.config.mode === 'poll-only' && event.source === 'hook') return;

      // 2. Dedup within sliding window
      const dedupKey = `${event.type}:${event.sessionId}:${event.version}:${event.data?.callID || event.data?.message_id || event.data?.message?.id || ''}`;
      const lastTime = this.dedupSet.get(dedupKey) || 0;
      if (Date.now() - lastTime < this.config.eventDedupWindowMs) {
        this.logger.debug('Duplicate event skipped', { key: dedupKey });
        return;
      }
      this.dedupSet.set(dedupKey, Date.now());

      // 3. Clean old dedup entries (keep last 1000)
      if (this.dedupSet.size > 1000) {
        const cutoff = Date.now() - 60000;
        for (const [k, t] of this.dedupSet) {
          if (t < cutoff) this.dedupSet.delete(k);
        }
      }

      // 4. Dispatch to handler (with retry for version conflicts)
      const handler = this.getHandler(event.type);
      if (!handler) {
        this.logger.warn('No handler for event', { type: event.type });
        return;
      }

      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= this.config.retryMaxAttempts; attempt++) {
        try {
          // Ensure session_map entry exists first
          await this.ensureSessionMap(event);

          // Call the handler
          await handler(event, this.pool);

          // Optimistic locking: update version on session_map
          if (event.version > 0) {
            const result = await this.pool.query(
              'UPDATE session_map SET version = version + 1 WHERE opencode_session_id = $1 AND (version = $2 OR version IS NULL)',
              [event.sessionId, event.version]
            );
            if (result.rowCount === 0 && attempt < this.config.retryMaxAttempts) {
              // Version conflict — retry
              lastError = new Error(`Version conflict for ${event.sessionId}`);
              await this.sleep(this.config.retryBaseDelayMs * Math.pow(2, attempt));
              continue;
            }
          }

          this.logger.debug('Event processed', { type: event.type, sessionId: event.sessionId, attempt });
          return;

        } catch (err: any) {
          lastError = err;
          if (attempt < this.config.retryMaxAttempts) {
            await this.sleep(this.config.retryBaseDelayMs * Math.pow(2, attempt));
          }
        }
      }

      this.logger.error('Event processing failed after retries', {
        type: event.type, sessionId: event.sessionId, error: lastError?.message,
      });
    } finally {
      this.processingCount--;
    }
  }

  private async ensureSessionMap(event: PluginEvent): Promise<void> {
    await this.pool.query(
      'INSERT INTO session_map (opencode_session_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [event.sessionId]
    );
  }

  private getHandler(type: PluginEventType): ((event: PluginEvent, pool: Pool) => Promise<void>) | null {
    const handlers: Record<string, (event: PluginEvent, pool: Pool) => Promise<void>> = {
      'session.created': async (e, p) => {
        await handleSessionCreated(
          { session: { id: e.sessionId, projectId: e.data?.projectId, model: { id: '', contextLimit: 128000, name: '' }, messages: [] } },
          { context: {} },
          p,
          { contextLimitRatio: 0.05, minTokens: 500, maxTokens: 4000 }
        );
      },
      'session.completed': async (e, p) => {
        await handleSessionCompleted(
          { session: { id: e.sessionId, messageCount: e.data?.messageCount || 0, durationMs: e.data?.durationMs || 0 }, summary: e.data?.summary },
          {},
          p,
          {}
        );
      },
      'session.compacted': async (e, p) => {
        await handleSessionCompacted(
          { session: { id: e.sessionId }, messagesToCompact: e.data?.messagesToCompact || [], compactionStrategy: 'prune' },
          {},
          p
        );
      },
      'message.updated': async (e, p) => {
        await handleMessageUpdated(
          { session: { id: e.sessionId }, message: e.data?.message || {} },
          {},
          p
        );
      },
      'tool.execute.before': async (e, p) => {
        await handleToolExecuteBefore(
          { session: { id: e.sessionId }, tool: { name: e.data?.toolName || '', parameters: e.data?.parameters || {} }, messageId: e.data?.callID || '' },
          { parameters: e.data?.parameters || {} },
          p
        );
      },
      'tool.execute.after': async (e, p) => {
        await handleToolExecuteAfter(
          { session: { id: e.sessionId }, tool: { name: e.data?.toolName || '', parameters: e.data?.parameters || {} }, result: e.data?.result || { success: true }, messageId: e.data?.callID || '', executionTimeMs: e.data?.executionTimeMs || 0 },
          {},
          p
        );
      },
    };
    return handlers[type] || null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async drain(timeoutMs?: number): Promise<void> {
    const start = Date.now();
    while (this.processingCount > 0) {
      if (timeoutMs !== undefined && Date.now() - start >= timeoutMs) {
        throw new Error(`Drain timeout after ${timeoutMs}ms`);
      }
      await this.sleep(50);
    }
  }

  isAvailable(): boolean {
    return !this.stopped && this.processingCount === 0;
  }
}
