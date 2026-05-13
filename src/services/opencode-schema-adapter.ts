/**
 * opencode-schema-adapter.ts — SQLite → OpenCode schema 适配
 *
 * 用于 db-polling.ts 从 OpenCode 本地 SQLite 读取会话数据。
 * v3.0+ 使用 session_map 表后此适配器主要用于历史数据兼容。
 */
import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { createLogger } from "./logger";

const logger = createLogger("opencode-schema-adapter");
const SQLITE_DIR = join(homedir(), ".config", "opencode", ".opencode");

export interface ParsedPart {
  type: string;
  text?: string;
  tool?: { name: string; callID: string };
}

export interface ParsedMessageMeta {
  id: string;
  role: string;
  content: string;
  parts: ParsedPart[];
}

export class OpenCodeSchemaAdapter {
  private db: Database.Database | null = null;

  connect(): boolean {
    const dbPath = join(SQLITE_DIR, "opencode.db");
    if (!existsSync(dbPath)) {
      logger.warn(`SQLite DB not found: ${dbPath}`);
      return false;
    }
    try {
      this.db = new Database(dbPath, { readonly: true });
      logger.info(`Connected to SQLite: ${dbPath}`);
      return true;
    } catch (err) {
      logger.warn("Failed to connect to SQLite:", err);
      return false;
    }
  }

  isConnected(): boolean {
    return this.db !== null;
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* non-fatal */
      }
      this.db = null;
    }
  }

  /** 获取近期会话列表（用于增量同步） */
  getRecentSessions(): Array<{
    id: string;
    title?: string;
    agent?: string;
    createdAt?: string;
  }> {
    try {
      if (!this.db) return [];
      const rows = this.db
        .prepare(
          "SELECT id, title, agent, created_at FROM sessions ORDER BY created_at DESC LIMIT 50",
        )
        .all() as any[];
      return rows.map((r: any) => ({
        id: r.id,
        title: r.title,
        agent: r.agent,
        createdAt: r.created_at,
      }));
    } catch (err) {
      logger.warn("Failed to query recent sessions:", err);
      return [];
    }
  }

  /** 获取工具调用总数 */
  getToolCallsCount(since?: number): number {
    try {
      if (!this.db) return 0;
      if (since) {
        const row = this.db
          .prepare(
            "SELECT COUNT(*) as cnt FROM tool_calls WHERE created_at > ?",
          )
          .get(since) as any;
        return row?.cnt ?? 0;
      }
      const row = this.db
        .prepare("SELECT COUNT(*) as cnt FROM tool_calls")
        .get() as any;
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  /** 获取工具调用批次 */
  getToolCallsSince(
    since?: number,
    limit = 100,
    offset = 0,
  ): Array<{
    id: string;
    sessionId: string;
    tool: string;
    callID: string;
    input: string;
    output: string;
    status: string;
    createdAt: string;
  }> {
    try {
      if (!this.db) return [];
      let rows: any[];
      if (since) {
        rows = this.db
          .prepare(
            "SELECT id, session_id, tool_name, input, output, status, created_at FROM tool_calls WHERE created_at > ? ORDER BY created_at ASC LIMIT ? OFFSET ?",
          )
          .all(since, limit, offset) as any[];
      } else {
        rows = this.db
          .prepare(
            "SELECT id, session_id, tool_name, input, output, status, created_at FROM tool_calls ORDER BY created_at ASC LIMIT ? OFFSET ?",
          )
          .all(limit, offset) as any[];
      }
      return rows.map((r: any) => ({
        id: r.id,
        sessionId: r.session_id,
        tool: r.tool_name,
        callID: r.id,
        input: r.input,
        output: r.output,
        status: r.status,
        createdAt: r.created_at,
      }));
    } catch {
      return [];
    }
  }

  getDb(): Database.Database | null {
    return this.db;
  }
}
