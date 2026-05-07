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
import { createLogger } from "./logger";
import { join } from "path";
import { homedir } from "os";

const logger = createLogger("schema-adapter");

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
  tokens?: {
    input: number;
    output: number;
    total: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  cost?: number;
  finish?: string;
  time?: { created: number; completed?: number };
  parentID?: string;
}

/** part.data JSON 中解析出的事件 */
export interface ParsedPart {
  type: "text" | "tool" | "image" | "audio" | "reasoning";
  text?: string;
  tool?: string; // 工具名 (bash, read, write, grep 等)
  callID?: string;
  state?: {
    status: string; // pending / running / completed / failed
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
    this.path =
      customPath ||
      join(homedir(), ".local", "share", "opencode", "opencode.db");
  }

  connect(): boolean {
    if (this.db) return true;
    try {
      // Try bun:sqlite first (faster, native)
      const { Database } = require("bun:sqlite");
      this.db = new Database(this.path);
      this.detectDrizzleVersion();
      return true;
    } catch {
      try {
        // Fall back to better-sqlite3 (Node.js compatible)
        const Database = require("better-sqlite3");
        this.db = new Database(this.path);
        this.detectDrizzleVersion();
        return true;
      } catch (err: any) {
        logger.warn("No SQLite driver available", {
          path: this.path,
          error: err.message,
        });
        return false;
      }
    }
  }

  private detectDrizzleVersion(): void {
    try {
      const rows = this.queryAll(
        "SELECT count(*) as cnt FROM __drizzle_migrations",
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      this.drizzleVersion = row ? Number(row.cnt) || 0 : 0;
    } catch {
      this.drizzleVersion = 0;
    }
  }

  /** Unified query helper — supports both bun:sqlite and better-sqlite3 APIs */
  private queryAll(sql: string, ...params: any[]): any[] {
    if (!this.db) return [];
    try {
      if (typeof this.db.query === "function") {
        return this.db.query(sql).all(...params);
      }
      return this.db.prepare(sql).all(...params);
    } catch {
      return [];
    }
  }

  /** Unified single-row query helper */
  private queryGet(sql: string, ...params: any[]): any {
    if (!this.db) return null;
    try {
      if (typeof this.db.query === "function") {
        return this.db.query(sql).get(...params);
      }
      return this.db.prepare(sql).get(...params);
    } catch {
      return null;
    }
  }

  isConnected(): boolean {
    return this.db !== null;
  }
  getDrizzleVersion(): number {
    return this.drizzleVersion;
  }

  // ── 会话 ─────────────────────────────────────────

  getRecentSessions(): SQLiteSession[] {
    try {
      return this.queryAll(`
        SELECT id, title, time_created, agent, model
        FROM session ORDER BY time_created ASC
      `) as SQLiteSession[];
    } catch (err: any) {
      logger.warn("Failed to query sessions", { error: err.message });
      return [];
    }
  }

  getSessionById(id: string): SQLiteSession | null {
    try {
      return (
        (this.queryGet(
          "SELECT id, title, time_created, agent FROM session WHERE id = ?",
          id,
        ) as SQLiteSession) || null
      );
    } catch {
      return null;
    }
  }

  // ── 消息 (message.data JSON) ─────────────────────

  /** 从 message.data JSON 中解析元数据 */
  parseMessageMeta(raw: string): ParsedMessageMeta | null {
    try {
      return JSON.parse(raw) as ParsedMessageMeta;
    } catch {
      return null;
    }
  }

  /** 获取指定会话的全部消息（含 JSON 解析） */
  getMessagesBySession(
    sessionId: string,
  ): Array<{ id: string; meta: ParsedMessageMeta | null }> {
    try {
      const rows = this.queryAll(
        `
        SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC
      `,
        sessionId,
      ) as Array<{ id: string; data: string }>;
      return rows.map((r) => ({
        id: r.id,
        meta: this.parseMessageMeta(r.data),
      }));
    } catch (err: any) {
      logger.warn("Failed to query messages", {
        sessionId,
        error: err.message,
      });
      return [];
    }
  }

  /** 获取增量消息（time_created > sinceTime） */
  getRecentMessages(
    sinceTime?: number,
  ): Array<{ id: string; session_id: string; meta: ParsedMessageMeta | null }> {
    try {
      let sql = "SELECT id, session_id, data, time_created FROM message";
      const params: any[] = [];
      if (sinceTime) {
        sql += " WHERE time_created > ?";
        params.push(sinceTime);
      }
      sql += " ORDER BY time_created ASC";
      const rows = this.queryAll(sql, ...params) as Array<{
        id: string;
        session_id: string;
        data: string;
        time_created: number;
      }>;
      return rows.map((r) => ({
        id: r.id,
        session_id: r.session_id,
        meta: this.parseMessageMeta(r.data),
      }));
    } catch (err: any) {
      logger.warn("Failed to query recent messages", { error: err.message });
      return [];
    }
  }

  // ── 消息部件 (part.data JSON) ────────────────────

  /** 从 part.data JSON 中解析出部件信息 */
  parsePart(raw: string): ParsedPart | null {
    try {
      return JSON.parse(raw) as ParsedPart;
    } catch {
      return null;
    }
  }

  /** 获取指定消息的全部部件 */
  getPartsByMessage(messageId: string): ParsedPart[] {
    try {
      const rows = this.queryAll(
        "SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC",
        messageId,
      ) as Array<{ data: string }>;
      return rows
        .map((r) => this.parsePart(r.data))
        .filter(Boolean) as ParsedPart[];
    } catch (err: any) {
      logger.warn("Failed to query parts", { messageId, error: err.message });
      return [];
    }
  }

  /** 获取指定消息中的工具调用部件 */
  getToolCallsByMessage(messageId: string): ParsedPart[] {
    return this.getPartsByMessage(messageId).filter(
      (p) => p.type === "tool" && p.tool,
    );
  }

  // ── 高级查询 ────────────────────────────────────

  /** 获取指定会话的全部工具调用（两段式：message → part） */
  getToolCallsBySession(sessionId: string): Array<{
    messageId: string;
    tool: string;
    callID?: string;
    input?: any;
    output?: any;
    status?: string;
  }> {
    const results: Array<any> = [];
    const msgs = this.queryAll(
      "SELECT id FROM message WHERE session_id = ? ORDER BY time_created ASC",
      sessionId,
    ) as Array<{ id: string }>;
    for (const msg of msgs) {
      const tools = this.getToolCallsByMessage(msg.id);
      for (const t of tools) {
        results.push({
          messageId: msg.id,
          tool: t.tool || "unknown",
          callID: t.callID,
          input: t.state?.input,
          output: t.state?.output,
          status: t.state?.status,
        });
      }
    }
    return results;
  }

  // ── 批量工具查询 ──────────────────────────────────

  /** 批量获取工具调用（JOIN 查询，避免 N+1），支持增量拉取和分页 */
  getToolCallsSince(
    sinceTime?: number,
    limit?: number,
    offset?: number,
  ): Array<{
    messageId: string;
    sessionId: string;
    tool: string;
    callID: string;
    input?: any;
    output?: any;
    status: string;
    partId: string;
    timeCreated: number;
  }> {
    try {
      let sql = `
        SELECT m.id as message_id, m.session_id, m.time_created, p.id as part_id, p.data as part_data
        FROM message m
        JOIN part p ON p.message_id = m.id
        WHERE 1=1
      `;
      const params: any[] = [];
      if (sinceTime) {
        sql += " AND m.time_created > ?";
        params.push(sinceTime);
      }
      sql += " ORDER BY m.time_created ASC, p.time_created ASC";
      if (limit !== undefined) {
        sql += " LIMIT ?";
        params.push(limit);
      }
      if (offset !== undefined) {
        sql += " OFFSET ?";
        params.push(offset);
      }
      const rows = this.queryAll(sql, ...params) as Array<{
        message_id: string;
        session_id: string;
        time_created: number;
        part_id: string;
        part_data: string;
      }>;
      const results: Array<any> = [];
      for (const row of rows) {
        const parsed = this.parsePart(row.part_data);
        if (!parsed || parsed.type !== "tool") continue;
        results.push({
          messageId: row.message_id,
          sessionId: row.session_id,
          tool: parsed.tool || "unknown",
          callID: parsed.callID || `gen_${row.part_id}`,
          input: parsed.state?.input,
          output: parsed.state?.output,
          status: parsed.state?.status || "unknown",
          partId: row.part_id,
          timeCreated: row.time_created,
        });
      }
      return results;
    } catch (err: any) {
      logger.warn("Failed to query tool calls since", { error: err.message });
      return [];
    }
  }

  /** 获取工具调用总数（用于进度追踪） */
  getToolCallsCount(sinceTime?: number): number {
    try {
      let sql = `
        SELECT count(*) as cnt
        FROM message m
        JOIN part p ON p.message_id = m.id
        WHERE 1=1
      `;
      const params: any[] = [];
      if (sinceTime) {
        sql += " AND m.time_created > ?";
        params.push(sinceTime);
      }
      const row = this.queryGet(sql, ...params) as
        | Record<string, number>
        | undefined;
      return row?.cnt || 0;
    } catch (err: any) {
      logger.warn("Failed to count tool calls", { error: err.message });
      return 0;
    }
  }

  /** 检查数据库是否可访问 */
  healthCheck(): {
    ok: boolean;
    drizzleVersion: number;
    sessionCount: number;
    messageCount: number;
  } {
    try {
      if (!this.db)
        return {
          ok: false,
          drizzleVersion: 0,
          sessionCount: 0,
          messageCount: 0,
        };
      const scResult = this.queryGet("SELECT count(*) as c FROM session") as
        | Record<string, number>
        | undefined;
      const mcResult = this.queryGet("SELECT count(*) as c FROM message") as
        | Record<string, number>
        | undefined;
      const sc = Number(scResult?.c) || 0;
      const mc = Number(mcResult?.c) || 0;
      return {
        ok: true,
        drizzleVersion: this.drizzleVersion,
        sessionCount: sc,
        messageCount: mc,
      };
    } catch {
      return { ok: false, drizzleVersion: 0, sessionCount: 0, messageCount: 0 };
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
  }
}
