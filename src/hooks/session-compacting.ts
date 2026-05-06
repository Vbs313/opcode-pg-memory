import { Pool } from 'pg';
import { SessionCompactingInput, SessionCompactingOutput } from '../types';
import { createLogger } from '../services/logger';

const logger = createLogger('session-compacting');

export interface SessionCompactingHandlerConfig {
  preserveHighImportanceObservations: boolean;
  minImportanceToPreserve: number;
  markPrunedInCache: boolean;
}

const DEFAULT_CONFIG: SessionCompactingHandlerConfig = {
  preserveHighImportanceObservations: true,
  minImportanceToPreserve: 4,
  markPrunedInCache: true
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
  output: SessionCompactingOutput,    // ✅ 添加 output 参数
  pool: Pool,
  config: Partial<SessionCompactingHandlerConfig> = {}
): Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const { session, messagesToCompact, compactionStrategy } = input;
  
  logger.info(`Session compacting: ${session.id}, strategy: ${compactionStrategy}, messages: ${messagesToCompact.length}`);
  
  try {
    // 获取 session 内部 ID
    const sessionResult = await pool.query(
      'SELECT id FROM session_map WHERE opencode_session_id = $1',
      [session.id]
    );
    
    if (sessionResult.rows.length === 0) {
      logger.warn(`Session not found: ${session.id}`);
      return;  // ✅ 返回 void
    }
    
    const sessionInternalId = sessionResult.rows[0].id;
    
    // 1. 标记语义缓存中的相关条目
    if (mergedConfig.markPrunedInCache && messagesToCompact.length > 0) {
      await markCacheEntriesAsPruned(sessionInternalId, messagesToCompact, pool);
    }
    
    // 2. 确定需要保留的高价值消息
    const preserveMessageIds = await determineMessagesToPreserve(
      sessionInternalId,
      messagesToCompact,
      pool,
      mergedConfig
    );
    
    // 3. 记录压缩事件
    await pool.query(`
      INSERT INTO token_usage_log (session_id, operation_type, tokens_used, metadata)
      VALUES ($1, $2, $3, $4)
    `, [
      sessionInternalId,
      'session_compaction',
      0,
      JSON.stringify({
        compactedMessageCount: messagesToCompact.length,
        preservedMessageCount: preserveMessageIds.length,
        strategy: compactionStrategy
      })
    ]);
    
    logger.info(`Session compacting complete. Preserved ${preserveMessageIds.length} high-value messages`);
    
    // ✅ 正确的钩子签名：mutate output (可选)
    if (preserveMessageIds.length > 0) {
      output.preserveMessageIds = preserveMessageIds;
    }
  } catch (error) {
    logger.error('Error handling session.compacting:', error);
    // 出错时不阻断主流程
  }
}

/**
 * 标记缓存条目为已压缩
 */
async function markCacheEntriesAsPruned(
  sessionId: string,
  messageIds: string[],
  pool: Pool
): Promise<void> {
  // 查找与这些消息相关的观察记录
  const observationResult = await pool.query(`
    SELECT id FROM observations 
    WHERE session_id = $1 AND message_id = ANY($2)
  `, [sessionId, messageIds]);
  
  if (observationResult.rows.length === 0) {
    return;
  }
  
  const observationIds = observationResult.rows.map(row => row.id);
  
  // 标记相关的语义缓存条目
  // 注意：这里假设缓存条目可能通过某种方式与观察记录关联
  // 实际实现可能需要根据具体业务逻辑调整
  const result = await pool.query(`
    UPDATE semantic_cache
    SET is_pruned = TRUE
    WHERE session_id = $1
      AND query_text IN (
        SELECT tool_output_summary FROM observations 
        WHERE id = ANY($2) AND tool_output_summary IS NOT NULL
      )
  `, [sessionId, observationIds]);
  
  logger.info(`Marked ${result.rowCount} cache entries as pruned`);
}

/**
 * 确定需要保留的高价值消息
 */
async function determineMessagesToPreserve(
  sessionId: string,
  messagesToCompact: string[],
  pool: Pool,
  config: SessionCompactingHandlerConfig
): Promise<string[]> {
  if (!config.preserveHighImportanceObservations) {
    return [];
  }
  
  // 查找高重要性的观察记录
  const result = await pool.query(`
    SELECT message_id 
    FROM observations 
    WHERE session_id = $1 
      AND message_id = ANY($2)
      AND importance >= $3
    GROUP BY message_id
  `, [sessionId, messagesToCompact, config.minImportanceToPreserve]);
  
  return result.rows.map(row => row.message_id);
}

/**
 * 获取缓存优先级配置
 * 
 * 说明：
 * - semantic_cache 检索优先级设为最高（在 DCP 处理之前执行缓存查找）
 * - 缓存命中后直接返回，无需进入 DCP 通道（零 token 消耗）
 */
export function getCachePriorityConfig(): {
  priority: number;
  bypassDCPOnHit: boolean;
} {
  return {
    // 最高优先级（数值越小优先级越高）
    priority: 1,
    // 缓存命中时绕过 DCP
    bypassDCPOnHit: true
  };
}

/**
 * 处理 session.compacted 事件（压缩完成后）
 * 
 * 签名规范：(input, output) => Promise<void>
 */
export async function handleSessionCompacted(
  input: SessionCompactingInput,
  output: SessionCompactingOutput,    // ✅ 添加 output 参数
  pool: Pool,
  config: Partial<SessionCompactingHandlerConfig> = {}
): Promise<void> {
  logger.info(`Session compacted: ${input.session.id}`);
  
  // 压缩完成后的清理工作
  // ✅ 正确的钩子签名：不返回任何值
}

/**
 * 检查消息是否已被压缩
 */
export async function isMessageCompacted(
  sessionId: string,
  messageId: string,
  pool: Pool
): Promise<boolean> {
  // 检查是否有相关的观察记录被标记
  const result = await pool.query(`
    SELECT COUNT(*) as count
    FROM observations o
    JOIN semantic_cache sc ON o.session_id = sc.session_id
    WHERE o.session_id = $1 
      AND o.message_id = $2
      AND sc.is_pruned = TRUE
  `, [sessionId, messageId]);
  
  return parseInt(result.rows[0].count, 10) > 0;
}

/**
 * 获取会话的压缩统计
 */
export async function getCompactionStats(
  sessionId: string,
  pool: Pool
): Promise<{
  totalObservations: number;
  prunedCacheEntries: number;
  highImportanceObservations: number;
}> {
  const sessionResult = await pool.query(
    'SELECT id FROM session_map WHERE opencode_session_id = $1',
    [sessionId]
  );
  
  if (sessionResult.rows.length === 0) {
    return {
      totalObservations: 0,
      prunedCacheEntries: 0,
      highImportanceObservations: 0
    };
  }
  
  const internalId = sessionResult.rows[0].id;
  
  const [obsResult, cacheResult, highImportanceResult] = await Promise.all([
    pool.query('SELECT COUNT(*) as count FROM observations WHERE session_id = $1', [internalId]),
    pool.query('SELECT COUNT(*) as count FROM semantic_cache WHERE session_id = $1 AND is_pruned = TRUE', [internalId]),
    pool.query('SELECT COUNT(*) as count FROM observations WHERE session_id = $1 AND importance >= 4', [internalId])
  ]);
  
  return {
    totalObservations: parseInt(obsResult.rows[0].count, 10),
    prunedCacheEntries: parseInt(cacheResult.rows[0].count, 10),
    highImportanceObservations: parseInt(highImportanceResult.rows[0].count, 10)
  };
}