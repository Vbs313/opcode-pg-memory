/**
 * OpenCode SQLite → PostgreSQL 轮询同步器
 *
 * 通过 OpenCodeSchemaAdapter 读取 SQLite 增量变化，构造 PluginEvent 并委托给 EventSynchronizer。
 * 基于真实 OpenCode 数据库结构编写：
 * - session: 扁平列 (id, title, time_created, agent, model)
 * - message: data TEXT (JSON) → role, agent, modelID, tokens, time
 * - part: data TEXT (JSON) → type(text/tool), tool, callID, state
 * - event: data TEXT (JSON), type, aggregate_id, seq
 *
 * 三阶段同步策略：
 *   1. 会话同步 — 检测新 session
 *   2. 批量工具调用同步 — 基于游标分页，消除 N+1
 *   3. 进度追踪 — lastSyncTime 游标
 */
import { Pool } from 'pg';
import { OpenCodeSchemaAdapter, ParsedPart, ParsedMessageMeta } from './opencode-schema-adapter';
import { EventSynchronizer } from './event-synchronizer';
import { createLogger } from './logger';
import type { PluginEvent, PluginEventType } from '../types';

const logger = createLogger('db-polling');
const BATCH_SIZE = 100;

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
      // ── Phase 1: Sync new sessions ──
      const sessions = this.adapter.getRecentSessions();
      for (const s of sessions) {
        if (!this.knownSessions.has(s.id)) {
          this.knownSessions.add(s.id);
          await this.synchronizer.handleEvent(this.event('session.created', s.id, { title: s.title, agent: s.agent }));
        }
      }

      // ── Phase 2: Batch sync tool calls ──
      // Use cursor-based pagination to avoid N+1 queries and ensure reliable progress
      const since = this.lastSyncTime || undefined;
      const totalToolCalls = this.adapter.getToolCallsCount(since);
      if (totalToolCalls > 0) {
        logger.info('Batch syncing tool calls', { total: totalToolCalls, batchSize: BATCH_SIZE, lastSyncTime: this.lastSyncTime });
        for (let offset = 0; offset < totalToolCalls; offset += BATCH_SIZE) {
          const toolCalls = this.adapter.getToolCallsSince(since, BATCH_SIZE, offset);
          if (toolCalls.length === 0) break;

          for (const tc of toolCalls) {
            await this.synchronizer.handleEvent({
              id: `tool.execute.after:${tc.sessionId}:${Date.now()}:${tc.callID}`,
              type: 'tool.execute.after',
              sessionId: tc.sessionId,
              timestamp: Date.now(),
              version: 1,
              source: 'poll',
              data: {
                toolName: tc.tool,
                callID: tc.callID,    // ← CRITICAL: ensures unique dedup key per tool call
                result: {
                  success: tc.status === 'completed',
                  data: tc.output,
                  error: tc.status === 'failed' ? tc.output : undefined,
                },
                executionTimeMs: 0,
                parameters: tc.input || {},
              },
            });
          }
          logger.info('Batch progress', { offset: offset + toolCalls.length, total: totalToolCalls });
        }
      }

      // ── Phase 3: Advance cursor so next cycle only picks up new tool calls ──
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
