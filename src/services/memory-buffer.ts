/**
 * memory-buffer.ts
 *
 * 轻量级内存观察队列。当 PG 瞬时不可用时，将 observation 暂存于内存，
 * 以指数退避重试写入。适用于本地 PostgreSQL 的短暂断开场景。
 *
 * 相比 SQLite write-behind buffer：无文件 I/O、无 better-sqlite3 依赖、
 * 进程重启后丢失（本地 PG 断开通常不超过数分钟，丢失可接受）。
 */

import { Pool } from "pg";
import { createLogger } from "../services/logger";

const logger = createLogger("memory-buffer");

// ============================================================
// Types
// ============================================================

export interface BufferedObservation {
  sessionMapId: string;
  toolName: string;
  toolInputSummary: string | null;
  toolOutputSummary: string | null;
  importance: number;
  metadata: Record<string, unknown>;
  platformSource: string;
  agentId: string | null;
}

// ============================================================
// Internal state
// ============================================================

const queue: BufferedObservation[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let retryCount = 0;
let poolRef: Pool | null = null;

const MAX_RETRIES = 10; // 约 5 分钟后放弃 (10 × 30s)
const FLUSH_INTERVAL = 30_000; // 30 秒
const MAX_QUEUE_SIZE = 500; // 防止内存泄漏

// ============================================================
// Public API
// ============================================================

/** 设置 pool 引用（由 index.ts 在初始化时调用） */
export function setPool(pool: Pool): void {
  poolRef = pool;
}

/**
 * 将 observation 放入内存队列。不阻塞。
 * 如果队列超过最大长度，丢弃最旧的 observation。
 */
export function enqueueObservation(obs: BufferedObservation): void {
  if (queue.length >= MAX_QUEUE_SIZE) {
    const dropped = queue.shift();
    logger.warn("Queue full, dropped oldest observation", {
      dropped: dropped?.toolName,
    });
  }
  queue.push(obs);
  logger.info(`Observation buffered (queue: ${queue.length})`);
  startFlushTimer();
}

/** 当前队列长度（用于监控） */
export function getQueueLength(): number {
  return queue.length;
}

/** 清空队列（用于进程退出前的清理） */
export function clearQueue(): void {
  queue.length = 0;
  stopFlushTimer();
  retryCount = 0;
}

// ============================================================
// Internal: flush
// ============================================================

function startFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flush, FLUSH_INTERVAL);
}

function stopFlushTimer(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

async function flush(): Promise<void> {
  if (queue.length === 0) {
    stopFlushTimer();
    retryCount = 0;
    return;
  }
  if (!poolRef) return;

  try {
    const batch = queue.splice(0); // drain entire queue
    let successCount = 0;

    for (const obs of batch) {
      try {
        await poolRef.query(
          `INSERT INTO observations
           (session_map_id, tool_name, tool_input_summary, tool_output_summary,
            importance, metadata, platform_source, agent_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            obs.sessionMapId,
            obs.toolName,
            obs.toolInputSummary,
            obs.toolOutputSummary,
            obs.importance,
            JSON.stringify(obs.metadata),
            obs.platformSource,
            obs.agentId,
          ],
        );
        successCount++;
      } catch {
        // Individual insert failed — put it back
        queue.push(obs);
      }
    }

    if (successCount > 0) {
      logger.info(
        `Flushed ${successCount} observations to PG (queue: ${queue.length})`,
      );
      retryCount = 0;
    }

    // If nothing was flushed and queue still has items, count as retry
    if (successCount === 0 && queue.length > 0) {
      retryCount++;
      if (retryCount >= MAX_RETRIES) {
        logger.error(
          `Dropping ${queue.length} observations after ${MAX_RETRIES} failed retries`,
        );
        queue.length = 0;
        stopFlushTimer();
        retryCount = 0;
      }
    }
  } catch (error) {
    logger.error("Flush failed", error);
    retryCount++;
    if (retryCount >= MAX_RETRIES) {
      logger.error(
        `Dropping ${queue.length} observations after ${MAX_RETRIES} failed retries`,
      );
      queue.length = 0;
      stopFlushTimer();
      retryCount = 0;
    }
  }
}
