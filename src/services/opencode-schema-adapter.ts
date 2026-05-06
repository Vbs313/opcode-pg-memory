/**
 * OpenCode SQLite 数据模型适配器
 * 
 * 基于真实 OpenCode 数据库结构编写。
 * 关键结构（经现场确认，非假设）：
 * - session: 扁平列 (id, title, time_created, agent, model)
 * - message: data TEXT (JSON) → role, tokens, modelID, agent, time
 * - part: data TEXT (JSON) → type(text/tool), tool, callID, state, text
 * - event: data TEXT (JSON), type, aggregate_id, seq
 * - session_message: 桥接表
 */
import { createLogger } from './logger';
import { join } from 'path';
import { homedir } from 'os';

const logger = createLogger('schema-adapter');

export interface SQLiteSession {
  id: string;
  title?: string;
  time_created?: number;
  agent?: string;
  model?: string;
}

/** 从 message.data JSON 中解析出的消息元数据 */
export interface ParsedMessageMeta {
  role?: string;
  agent?: string;
  modelID?: string;
  providerID?: string;
  mode?: string;
  variant?: string;
  tokens?: { input: number; output: number; total: number; reasoning: number; cache: { read: number; write: number } };
  cost?: number;
  finish?: string;
  time?: { created: number; completed?: number };
  parentID?: string;
}

/** part.data JSON 中解析出的事件 */
export interface ParsedPart {
  type: 'text' | 'tool' | 'image' | 'audio' | 'reasoning';
  text?: string;
  tool?: string;          // 工具名 (bash, read, write, grep 等)
  callID?: string;
  state?: {
    status: string;       // pending / running / completed / failed
    input?: Record<string, any>;
    output?: any;
    filepath?: string;
  };
  synthetic?: boolean;
  time?: { start: number; end?: number };
}

export class OpenCodeSchemaAdapter {
  private db: any = null;
  private path: string;
  private drizzleVersion: number = 0;

  constructor(customPath?: string) {
    this.path = customPath || join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  }

  connect(): boolean {
    if (this.db) return true;
    try {
      const { Database } = require('bun:sqlite') as any;
      this.db = new Database(this.path);
      this.detectDrizzleVersion();
      return true;
    } catch (err: any) {
      logger.warn('Failed to connect to OpenCode SQLite', { path: this.path, error: err.message });
      return false;
    }
  }

  private detectDrizzleVersion(): void {
    try {
      const rows = this.db?.query('SELECT count(*) as cnt FROM __drizzle_migrations').all() || [];
      this.drizzleVersion = rows.length > 0 ? (rows[0] as any).cnt || 0 : 0;
    } catch { this.drizzleVersion = 0; }
  }

  isConnected(): boolean { return this.db !== null; }
  getDrizzleVersion(): number { return this.drizzleVersion; }

  // ── 会话 ─────────────────────────────────────────

  getRecentSessions(): SQLiteSession[] {
    if (!this.db) return [];
    try {
      return this.db.query(`
        SELECT id, title, time_created, agent, model
        FROM session ORDER BY time_created ASC
      `).all() as SQLiteSession[];
    } catch (err: any) {
      logger.warn('Failed to query sessions', { error: err.message });
      return [];
    }
  }

  getSessionById(id: string): SQLiteSession | null {
    if (!this.db) return null;
    try {
      return this.db.query('SELECT id, title, time_created, agent FROM session WHERE id = ?').get(id) as SQLiteSession || null;
    } catch { return null; }
  }

  // ── 消息 (message.data JSON) ─────────────────────

  /** 从 message.data JSON 中解析元数据 */
  parseMessageMeta(raw: string): ParsedMessageMeta | null {
    try { return JSON.parse(raw) as ParsedMessageMeta; } catch { return null; }
  }

  /** 获取指定会话的全部消息（含 JSON 解析） */
  getMessagesBySession(sessionId: string): Array<{ id: string; meta: ParsedMessageMeta | null }> {
    if (!this.db) return [];
    try {
      const rows = this.db.query(`
        SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC
      `).all(sessionId) as Array<{ id: string; data: string }>;
      return rows.map(r => ({ id: r.id, meta: this.parseMessageMeta(r.data) }));
    } catch (err: any) {
      logger.warn('Failed to query messages', { sessionId, error: err.message });
      return [];
    }
  }

  /** 获取增量消息（time_created > sinceTime） */
  getRecentMessages(sinceTime?: number): Array<{ id: string; session_id: string; meta: ParsedMessageMeta | null }> {
    if (!this.db) return [];
    try {
      let sql = 'SELECT id, session_id, data, time_created FROM message';
      const params: any[] = [];
      if (sinceTime) { sql += ' WHERE time_created > ?'; params.push(sinceTime); }
      sql += ' ORDER BY time_created ASC';
      const rows = this.db.query(sql).all(...params) as Array<{ id: string; session_id: string; data: string; time_created: number }>;
      return rows.map(r => ({ id: r.id, session_id: r.session_id, meta: this.parseMessageMeta(r.data) }));
    } catch (err: any) {
      logger.warn('Failed to query recent messages', { error: err.message });
      return [];
    }
  }

  // ── 消息部件 (part.data JSON) ────────────────────

  /** 从 part.data JSON 中解析出部件信息 */
  parsePart(raw: string): ParsedPart | null {
    try { return JSON.parse(raw) as ParsedPart; } catch { return null; }
  }

  /** 获取指定消息的全部部件 */
  getPartsByMessage(messageId: string): ParsedPart[] {
    if (!this.db) return [];
    try {
      const rows = this.db.query('SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC').all(messageId) as Array<{ data: string }>;
      return rows.map(r => this.parsePart(r.data)).filter(Boolean) as ParsedPart[];
    } catch (err: any) {
      logger.warn('Failed to query parts', { messageId, error: err.message });
      return [];
    }
  }

  /** 获取指定消息中的工具调用部件 */
  getToolCallsByMessage(messageId: string): ParsedPart[] {
    return this.getPartsByMessage(messageId).filter(p => p.type === 'tool' && p.tool);
  }

  // ── 高级查询 ────────────────────────────────────

  /** 获取指定会话的全部工具调用（两段式：message → part） */
  getToolCallsBySession(sessionId: string): Array<{ messageId: string; tool: string; callID?: string; input?: any; output?: any; status?: string }> {
    const results: Array<any> = [];
    const msgs = this.db?.query('SELECT id FROM message WHERE session_id = ? ORDER BY time_created ASC').all(sessionId) as Array<{ id: string }> || [];
    for (const msg of msgs) {
      const tools = this.getToolCallsByMessage(msg.id);
      for (const t of tools) {
        results.push({
          messageId: msg.id,
          tool: t.tool || 'unknown',
          callID: t.callID,
          input: t.state?.input,
          output: t.state?.output,
          status: t.state?.status,
        });
      }
    }
    return results;
  }

  /** 检查数据库是否可访问 */
  healthCheck(): { ok: boolean; drizzleVersion: number; sessionCount: number; messageCount: number } {
    try {
      if (!this.db) return { ok: false, drizzleVersion: 0, sessionCount: 0, messageCount: 0 };
      const sc = (this.db.query('SELECT count(*) as c FROM session').get() as any)?.c || 0;
      const mc = (this.db.query('SELECT count(*) as c FROM message').get() as any)?.c || 0;
      return { ok: true, drizzleVersion: this.drizzleVersion, sessionCount: sc, messageCount: mc };
    } catch {
      return { ok: false, drizzleVersion: 0, sessionCount: 0, messageCount: 0 };
    }
  }

  close(): void {
    if (this.db) {
      try { this.db.close(); } catch {}
      this.db = null;
    }
  }
}
