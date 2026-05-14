import { Pool } from "pg";
import { SessionCompactingInput, SessionCompactingOutput } from "../types";
import { createLogger } from "../services/logger";

const logger = createLogger("session-compacting");

export interface SessionCompactingHandlerConfig {
  preserveHighImportanceObservations: boolean;
  minImportanceToPreserve: number;
  markPrunedInCache: boolean;
}

const DEFAULT_CONFIG: SessionCompactingHandlerConfig = {
  preserveHighImportanceObservations: true,
  minImportanceToPreserve: 4,
  markPrunedInCache: true,
};

/**
 * 处理 experimental.session.compacting / session.compacted 事件
 *
 * 功能：
 * 1. 标记将被压缩的低价值消息
 * 2. 避免对已压缩消息重复产生缓存
 * 3. 与 DCP 协同，semantic_cache 检索优先级设为最高
 *
 * 签名规范：(input, output) => Promise<void>
 */
export async function handleSessionCompacting(
  input: SessionCompactingInput,
  output: SessionCompactingOutput,
  pool: Pool,
  config: Partial<SessionCompactingHandlerConfig> = {},
): Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const { session, messagesToCompact, compactionStrategy } = input;

  logger.info(
    `Session compacting: ${session.id}, strategy: ${compactionStrategy}, messages: ${messagesToCompact.length}`,
  );

  try {
    const sessionResult = await pool.query(
      "SELECT id FROM session_map WHERE opencode_session_id = $1",
      [session.id],
    );

    if (sessionResult.rows.length === 0) {
      logger.warn(`Session not found: ${session.id}`);
      return;
    }

    const sessionInternalId = sessionResult.rows[0].id;

    // 1. 标记语义缓存中的相关条目
    if (mergedConfig.markPrunedInCache && messagesToCompact.length > 0) {
      await markCacheEntriesAsPruned(
        sessionInternalId,
        messagesToCompact,
        pool,
      );
    }

    // 2. 确定需要保留的高价值消息
    const preserveMessageIds = await determineMessagesToPreserve(
      sessionInternalId,
      messagesToCompact,
      pool,
      mergedConfig,
    );

    // 3. 记录压缩事件
    await pool.query(
      `
      INSERT INTO token_usage_log (session_map_id, operation_type, tokens_used, metadata)
      VALUES ($1, $2, $3, $4)
    `,
      [
        sessionInternalId,
        "session_compaction",
        0,
        JSON.stringify({
          compactedMessageCount: messagesToCompact.length,
          preservedMessageCount: preserveMessageIds.length,
          strategy: compactionStrategy,
        }),
      ],
    );

    logger.info(
      `Session compacting complete. Preserved ${preserveMessageIds.length} high-value messages`,
    );

    if (preserveMessageIds.length > 0) {
      output.preserveMessageIds = preserveMessageIds;
    }
  } catch (error) {
    logger.error("Error handling session.compacting:", error);
  }
}

/**
 * 标记缓存条目为已压缩
 */
async function markCacheEntriesAsPruned(
  sessionId: string,
  messageIds: string[],
  pool: Pool,
): Promise<void> {
  const observationResult = await pool.query(
    `
    SELECT id FROM observations
    WHERE session_map_id = $1 AND message_id = ANY($2)
  `,
    [sessionId, messageIds],
  );

  if (observationResult.rows.length === 0) return;

  const observationIds = observationResult.rows.map((row) => row.id);

  const result = await pool.query(
    `
    UPDATE semantic_cache
    SET is_pruned = TRUE
    WHERE session_map_id = $1
      AND query_text IN (
        SELECT tool_output_summary FROM observations
        WHERE id = ANY($2) AND tool_output_summary IS NOT NULL
      )
  `,
    [sessionId, observationIds],
  );

  logger.info(`Marked ${result.rowCount} cache entries as pruned`);
}

/**
 * 确定需要保留的高价值消息
 */
async function determineMessagesToPreserve(
  sessionId: string,
  messagesToCompact: string[],
  pool: Pool,
  config: SessionCompactingHandlerConfig,
): Promise<string[]> {
  if (!config.preserveHighImportanceObservations) return [];

  const result = await pool.query(
    `
    SELECT message_id
    FROM observations
    WHERE session_map_id = $1
      AND message_id = ANY($2)
      AND importance >= $3
    GROUP BY message_id
  `,
    [sessionId, messagesToCompact, config.minImportanceToPreserve],
  );

  return result.rows.map((row) => row.message_id);
}

/**
 * 处理 session.compacted 事件（压缩完成后）
 *
 * 签名规范：(input, output) => Promise<void>
 */
export async function handleSessionCompacted(
  input: SessionCompactingInput,
  output: SessionCompactingOutput,
  pool: Pool,
  config: Partial<SessionCompactingHandlerConfig> = {},
): Promise<void> {
  logger.info(`Session compacted: ${input.session.id}`);
  // 压缩完成后的清理工作
}
