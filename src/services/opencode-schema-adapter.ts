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
  msg_ids?: string;
}

export interface SQLiteMessage {
  id: string;
  session_id: string;
  role: string;
  content: string;
  time_created?: number;
  tokens_input?: number;
  tokens_output?: number;
  model_id?: string;
  agent?: string;
}

export class OpenCodeSchemaAdapter {
  private db: any = null;
  private path: string;
  private version: number = 0;

  constructor(customPath?: string) {
    this.path = customPath || join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  }

  connect(): boolean {
    if (this.db) return true;
    try {
      const { Database } = require('bun:sqlite') as any;
      this.db = new Database(this.path);
      this.detectSchemaVersion();
      return true;
    } catch (err: any) {
      logger.warn('Failed to connect to OpenCode SQLite', { path: this.path, error: err.message });
      return false;
    }
  }

  private detectSchemaVersion(): void {
    try {
      const row = this.db?.query('PRAGMA user_version').get();
      this.version = row?.user_version || 0;
    } catch { this.version = 0; }
  }

  isConnected(): boolean { return this.db !== null; }

  getVersion(): number { return this.version; }

  getRecentSessions(): SQLiteSession[] {
    if (!this.db) return [];
    try {
      return this.db.query(`
        SELECT id, title, time_created, agent, model
        FROM session WHERE type = 'chat' ORDER BY time_created ASC
      `).all() as SQLiteSession[];
    } catch (err: any) {
      logger.warn('Failed to query sessions', { error: err.message });
      return [];
    }
  }

  getRecentMessages(sinceTime?: number): SQLiteMessage[] {
    if (!this.db) return [];
    try {
      let sql = `SELECT m.id, m.session_id, m.role, m.content, m.time_created,
                        m.tokens_input, m.tokens_output, m.model_id, m.agent
                 FROM message m JOIN session s ON m.session_id = s.id
                 WHERE s.type = 'chat'`;
      const params: any[] = [];
      if (sinceTime) {
        sql += ` AND m.time_created > ?`;
        params.push(sinceTime);
      }
      sql += ` ORDER BY m.time_created ASC`;
      return this.db.query(sql).all(...params) as SQLiteMessage[];
    } catch (err: any) {
      logger.warn('Failed to query messages', { error: err.message });
      return [];
    }
  }

  getSessionById(id: string): SQLiteSession | null {
    if (!this.db) return null;
    try {
      return this.db.query('SELECT id, title, time_created FROM session WHERE id = ?').get(id) as SQLiteSession || null;
    } catch { return null; }
  }

  close(): void {
    if (this.db) {
      try { this.db.close(); } catch {}
      this.db = null;
    }
  }
}
