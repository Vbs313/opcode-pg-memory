/**
 * short-term-memory.ts
 *
 * 基于内存的短时记忆层。存储当前会话内的工具调用观察，
 * 在 system.transform 时直接注入，避免每次 LLM 调用都查 PG。
 *
 * 设计参考:
 *   - Redis Session Cache (webaroo.us): 快速键值存储，session 生命周期
 *   - Cognee Session Cache: session 范围缓存 + 回退到长期存储
 *   - NOW.md 模式: 始终注入的短时上下文
 *
 * 生命周期: session 持续期间。session 结束后可丢弃或 consolidate 到 PG。
 */

import { createLogger } from "../services/logger";

const logger = createLogger("short-term-memory");

// ============================================================
// Types
// ============================================================

export interface ShortTermObservation {
  id: string;
  toolName: string;
  summary: string;
  importance: number;
  timestamp: Date;
}

export interface ShortTermSession {
  observations: ShortTermObservation[];
  lastAccess: Date;
}

// ============================================================
// Internal state
// ============================================================

const sessions = new Map<string, ShortTermSession>();
const MAX_OBS_PER_SESSION = 50; // 防止单会话内存泄漏
const MAX_SESSIONS = 100; // 总会话数上限
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 分钟无访问自动过期

// ============================================================
// Periodic cleanup
// ============================================================

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [sid, session] of sessions) {
      if (now - session.lastAccess.getTime() > SESSION_TTL_MS) {
        logger.debug(`Evicting stale session: ${sid}`);
        sessions.delete(sid);
      }
    }
    if (sessions.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, 60_000); // 每分钟检查一次
}

// ============================================================
// Public API
// ============================================================

/**
 * 为 session 添加一条观察。
 * 由 tool-execute 钩子在工具执行完成后调用。
 */
export function addObservation(
  sessionId: string,
  obs: ShortTermObservation,
): void {
  if (!sessions.has(sessionId)) {
    // Evict oldest session if at capacity
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.entries().next().value;
      if (oldest) sessions.delete(oldest[0]);
    }
    sessions.set(sessionId, { observations: [], lastAccess: new Date() });
  }

  const session = sessions.get(sessionId)!;
  session.observations.push(obs);
  session.lastAccess = new Date();

  // Trim to max
  if (session.observations.length > MAX_OBS_PER_SESSION) {
    session.observations = session.observations.slice(-MAX_OBS_PER_SESSION);
  }

  ensureCleanupTimer();
}

/**
 * 获取 session 的所有短时观察（按时间倒序）。
 * 由 system.transform 在注入前调用。
 * 如果没有短时记忆，返回空数组（会触发 PG 查询）。
 */
export function getObservations(sessionId: string): ShortTermObservation[] {
  const session = sessions.get(sessionId);
  if (!session) return [];
  session.lastAccess = new Date();
  return [...session.observations].reverse();
}

/**
 * session 结束时调用，清空短时内存。
 */
export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
  logger.debug(`Cleared short-term memory for session: ${sessionId}`);
}

/**
 * 获取当前活跃会话数（用于监控）
 */
export function getActiveSessionCount(): number {
  return sessions.size;
}
