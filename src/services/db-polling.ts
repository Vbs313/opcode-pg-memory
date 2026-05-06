/**
 * OpenCode SQLite → PostgreSQL 轮询同步器
 *
 * 通过 OpenCodeSchemaAdapter 读取 SQLite 增量变化，构造 PluginEvent 并委托给 EventSynchronizer。
 * 不依赖 OpenCode 事件总线，兼容 TUI/CLI/Desktop/WebView 所有模式。
 */
import { Pool } from 'pg';
import { OpenCodeSchemaAdapter } from './opencode-schema-adapter';
import { EventSynchronizer } from './event-synchronizer';
import { createLogger } from './logger';
import type { PluginEvent, SyncMode, PluginEventType } from '../types';

const logger = createLogger('db-polling');

export interface DBPollingConfig {
  intervalMs: number;
  maxBatchSize: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

const DEFAULT_CONFIG: DBPollingConfig = {
  intervalMs: 5000,
  maxBatchSize: 100,
  backoffBaseMs: 1000,
  backoffMaxMs: 60000,
};

export class OpenCodeDBPollingSource {
  private pool: Pool;
  private synchronizer: EventSynchronizer;
  private config: DBPollingConfig;
  private adapter: OpenCodeSchemaAdapter;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSyncTime: number = 0;
  private currentInterval: number;
  private sessionIds = new Set<string>();

  constructor(pool: Pool, synchronizer: EventSynchronizer, config?: Partial<DBPollingConfig>) {
    this.pool = pool;
    this.synchronizer = synchronizer;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.adapter = new OpenCodeSchemaAdapter();
    this.currentInterval = this.config.intervalMs;
  }

  async start(): Promise<void> {
    if (!this.adapter.connect()) {
      logger.warn('DB polling: SQLite not available, skipping');
      return;
    }

    // Load already-known session IDs from PG
    try {
      const result = await this.pool.query('SELECT opencode_session_id FROM session_map');
      for (const row of result.rows) this.sessionIds.add(row.opencode_session_id);
    } catch {}

    logger.info('DB polling started', { interval: this.config.intervalMs, knownSessions: this.sessionIds.size });
    this.timer = setInterval(() => this.sync(), this.currentInterval);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.adapter.close();
  }

  private async sync(): Promise<void> {
    // Reconnect if needed (SQLite might have been reopened)
    if (!this.adapter.isConnected()) {
      if (!this.adapter.connect()) return;
    }

    try {
      // 1. Sync new sessions
      const sessions = this.adapter.getRecentSessions();
      for (const s of sessions) {
        if (!this.sessionIds.has(s.id)) {
          this.sessionIds.add(s.id);
          await this.synchronizer.handleEvent(this.makeEvent('session.created', s.id, { projectId: null }));
        }
      }

      // 2. Sync new messages as observations
      const messages = this.adapter.getRecentMessages(this.lastSyncTime || undefined);
      for (const m of messages) {
        if (!this.sessionIds.has(m.session_id)) continue;
        await this.synchronizer.handleEvent(this.makeEvent('message.updated', m.session_id, { message: m }));
      }

      // Update tracking
      this.lastSyncTime = Date.now();
      this.currentInterval = this.config.intervalMs; // Reset on success

    } catch (err: any) {
      logger.warn('DB polling sync failed', { error: err.message });
      // Exponential backoff: double interval up to max
      this.currentInterval = Math.min(this.currentInterval * 2, this.config.backoffMaxMs);
      logger.info('DB polling backing off', { nextInterval: this.currentInterval });
    }
  }

  private makeEvent(type: PluginEventType, sessionId: string, data: any): PluginEvent {
    return {
      id: `${type}:${sessionId}:${Date.now()}`,
      type,
      sessionId,
      timestamp: Date.now(),
      version: 1,
      source: 'poll',
      data,
    };
  }
}
