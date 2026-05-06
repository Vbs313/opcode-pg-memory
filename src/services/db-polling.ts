/**
 * OpenCode SQLite → PostgreSQL 轮询同步器
 *
 * 通过 OpenCodeSchemaAdapter 读取 SQLite 增量变化，构造 PluginEvent 并委托给 EventSynchronizer。
 * 基于真实 OpenCode 数据库结构编写：
 * - session: 扁平列 (id, title, time_created, agent, model)
 * - message: data TEXT (JSON) → role, agent, modelID, tokens, time
 * - part: data TEXT (JSON) → type(text/tool), tool, callID, state
 * - event: data TEXT (JSON), type, aggregate_id, seq
 */
import { Pool } from 'pg';
import { OpenCodeSchemaAdapter, ParsedPart, ParsedMessageMeta } from './opencode-schema-adapter';
import { EventSynchronizer } from './event-synchronizer';
import { createLogger } from './logger';
import type { PluginEvent, PluginEventType } from '../types';

const logger = createLogger('db-polling');

export interface DBPollingConfig {
  intervalMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

const DEFAULT_CONFIG: DBPollingConfig = {
  intervalMs: 5000,
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
  private knownSessions = new Set<string>();

  constructor(pool: Pool, synchronizer: EventSynchronizer, config?: Partial<DBPollingConfig>) {
    this.pool = pool;
    this.synchronizer = synchronizer;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.adapter = new OpenCodeSchemaAdapter();
    this.currentInterval = this.config.intervalMs;
  }

  async start(): Promise<void> {
    if (!this.adapter.connect()) {
      logger.warn('SQLite not available, polling disabled');
      return;
    }
    // Load known sessions from PG
    try {
      const result = await this.pool.query('SELECT opencode_session_id FROM session_map');
      for (const row of result.rows) this.knownSessions.add(row.opencode_session_id);
    } catch {}
    logger.info('DB polling started', { interval: this.config.intervalMs, knownSessions: this.knownSessions.size });
    this.timer = setInterval(() => this.sync(), this.currentInterval);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.adapter.close();
  }

  private async sync(): Promise<void> {
    if (!this.adapter.isConnected() && !this.adapter.connect()) return;

    try {
      // 1. Sync new sessions
      const sessions = this.adapter.getRecentSessions();
      for (const s of sessions) {
        if (!this.knownSessions.has(s.id)) {
          this.knownSessions.add(s.id);
          await this.synchronizer.handleEvent(this.event('session.created', s.id, { title: s.title, agent: s.agent }));
        }
      }

      // 2. Sync recent messages (parse from JSON)
      const messages = this.adapter.getRecentMessages(this.lastSyncTime || undefined);
      for (const m of messages) {
        if (!this.knownSessions.has(m.session_id)) continue;
        const role = m.meta?.role || 'unknown';
        const agent = m.meta?.agent || m.meta?.modelID || undefined;

        // Emit message.updated event
        await this.synchronizer.handleEvent(this.event('message.updated', m.session_id, {
          message: { id: m.id, role, agent },
          message_id: m.id,
        }));

        // 3. For each message, check its parts for tool calls
        const toolCalls = this.adapter.getToolCallsByMessage(m.id);
        for (const tc of toolCalls) {
          await this.synchronizer.handleEvent(this.event('tool.execute.after', m.session_id, {
            toolName: tc.tool || 'unknown',
            callID: tc.callID,
            result: {
              success: tc.state?.status === 'completed',
              data: tc.state?.output,
              error: tc.state?.status === 'failed' ? tc.state?.output : undefined,
            },
            executionTimeMs: 0,
            parameters: tc.state?.input || {},
          }));
        }
      }

      this.lastSyncTime = Date.now();
      this.currentInterval = this.config.intervalMs; // Reset on success

    } catch (err: any) {
      logger.warn('DB polling sync failed', { error: err.message });
      this.currentInterval = Math.min(this.currentInterval * 2, this.config.backoffMaxMs);
      logger.info('Backing off', { nextInterval: this.currentInterval });
    }
  }

  private event(type: PluginEventType, sessionId: string, data: any): PluginEvent {
    return { id: `${type}:${sessionId}:${Date.now()}`, type, sessionId, timestamp: Date.now(), version: 1, source: 'poll', data };
  }
}
