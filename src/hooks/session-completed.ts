import { Pool } from 'pg';
import { SessionCompletedInput, SessionCompletedOutput } from '../types';
import { createLogger } from '../services/logger';

const logger = createLogger('session-completed');

export interface SessionCompletedHandlerConfig {
  reflectionThreshold: number;
  minObservationThreshold: number;
  maxObservationThreshold: number;
  enableReflection: boolean;
  offPeakHours: number[];
}

const DEFAULT_CONFIG: SessionCompletedHandlerConfig = {
  reflectionThreshold: 30, // 基础阈值
  minObservationThreshold: 30,
  maxObservationThreshold: 50,
  enableReflection: true,
  offPeakHours: [1, 2, 3, 4, 5] // 凌晨 1-5 点
};

/**
 * 处理 session.completed 事件
 * 
 * 功能：
 * 1. 异步触发 hindsight_reflect 反思任务
 * 2. 检查 observations 数量是否达到阈值 (30-50条)
 * 3. 更新 sessions.reflection_last_at
 * 4. 使用 7B 蒸馏模型在低峰期执行
 * 
 * 签名规范：(input, output) => Promise<void>
 */
export async function handleSessionCompleted(
  input: SessionCompletedInput,
  output: SessionCompletedOutput,    // ✅ 添加 output 参数
  pool: Pool,
  config: Partial<SessionCompletedHandlerConfig> = {}
): Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const { session, summary } = input;
  
  logger.info(`Session completed: ${session.id}, messages: ${session.messageCount}, duration: ${session.durationMs}ms`);
  
  try {
    // 获取 session 内部 ID
    const sessionResult = await pool.query(
      'SELECT id, reflection_last_at FROM session_map WHERE opencode_session_id = $1',
      [session.id]
    );
    
    if (sessionResult.rows.length === 0) {
      logger.warn(`Session not found: ${session.id}`);
      return;  // ✅ 返回 void
    }
    
    const sessionInternalId = sessionResult.rows[0].id;
    const reflectionLastAt = sessionResult.rows[0].reflection_last_at;
    
    // 1. 统计本次会话的观察数量
    const observationStats = await getObservationStats(
      sessionInternalId,
      reflectionLastAt,
      pool
    );
    
    logger.info(`Observations since last reflection: ${observationStats.countSinceLastReflection}`);
    
    // 2. 检查是否应该触发反思
    const shouldReflect = await checkShouldTriggerReflection(
      sessionInternalId,
      observationStats.countSinceLastReflection,
      mergedConfig,
      pool
    );
    
    if (shouldReflect && mergedConfig.enableReflection) {
      // 3. 调度反思任务
      await scheduleReflectionTask(
        sessionInternalId,
        session.id,
        observationStats.countSinceLastReflection,
        mergedConfig,
        pool
      );
    }
    
    // 4. 记录会话完成
    await pool.query(`
      UPDATE session_map 
      SET updated_at = NOW(),
          metadata = metadata || $1
      WHERE id = $2
    `, [
      JSON.stringify({
        lastSessionSummary: summary,
        messageCount: session.messageCount,
        durationMs: session.durationMs,
        reflectionTriggered: shouldReflect
      }),
      sessionInternalId
    ]);
    
    // 5. 记录 token 使用
    await pool.query(`
      INSERT INTO token_usage_log (session_id, operation_type, tokens_used, metadata)
      VALUES ($1, $2, $3, $4)
    `, [
      sessionInternalId,
      'session_completion',
      0,
      JSON.stringify({
        messageCount: session.messageCount,
        durationMs: session.durationMs,
        observationCount: observationStats.totalCount
      })
    ]);
    
    logger.info(`Session completion processed: ${session.id}`);
    
    // ✅ 正确的钩子签名：不返回任何值
  } catch (error) {
    logger.error('Error handling session.completed:', error);
    // 出错时不阻断主流程
  }
}

/**
 * 获取观察统计
 */
async function getObservationStats(
  sessionId: string,
  reflectionLastAt: Date | null,
  pool: Pool
): Promise<{ totalCount: number; countSinceLastReflection: number }> {
  // 总观察数
  const totalResult = await pool.query(
    'SELECT COUNT(*) as count FROM observations WHERE session_id = $1',
    [sessionId]
  );
  
  const totalCount = parseInt(totalResult.rows[0].count, 10);
  
  // 上次反思后的观察数
  let countSinceLastReflection = totalCount;
  if (reflectionLastAt) {
    const sinceResult = await pool.query(`
      SELECT COUNT(*) as count 
      FROM observations 
      WHERE session_id = $1 AND created_at > $2
    `, [sessionId, reflectionLastAt]);
    countSinceLastReflection = parseInt(sinceResult.rows[0].count, 10);
  }
  
  return { totalCount, countSinceLastReflection };
}

/**
 * 检查是否应该触发反思
 */
async function checkShouldTriggerReflection(
  sessionId: string,
  observationCount: number,
  config: SessionCompletedHandlerConfig,
  pool: Pool
): Promise<boolean> {
  if (!config.enableReflection) {
    return false;
  }
  
  // 随机阈值：30-50 条经验
  const threshold = Math.floor(
    Math.random() * (config.maxObservationThreshold - config.minObservationThreshold + 1)
  ) + config.minObservationThreshold;
  
  logger.info(`Reflection threshold: ${threshold}, current: ${observationCount}`);
  
  if (observationCount < threshold) {
    return false;
  }
  
  // 检查是否有正在进行的反思任务
  const pendingResult = await pool.query(`
    SELECT COUNT(*) as count 
    FROM reflections 
    WHERE session_id = $1 AND created_at > NOW() - INTERVAL '1 hour'
  `, [sessionId]);
  
  const pendingCount = parseInt(pendingResult.rows[0].count, 10);
  
  if (pendingCount > 0) {
    logger.info(`Reflection already in progress for session: ${sessionId}`);
    return false;
  }
  
  return true;
}

/**
 * 调度反思任务
 */
async function scheduleReflectionTask(
  sessionInternalId: string,
  externalSessionId: string,
  observationCount: number,
  config: SessionCompletedHandlerConfig,
  pool: Pool
): Promise<void> {
  const currentHour = new Date().getHours();
  const isOffPeak = config.offPeakHours.includes(currentHour);
  
  logger.info(`Scheduling reflection task for session: ${externalSessionId}, off-peak: ${isOffPeak}`);
  
  if (isOffPeak) {
    // 低峰期：立即执行
    await executeReflection(sessionInternalId, externalSessionId, observationCount, pool);
  } else {
    // 非低峰期：延迟到下一个低峰期
    await queueReflectionForOffPeak(sessionInternalId, externalSessionId, observationCount, pool);
  }
}

/**
 * 执行反思任务
 */
async function executeReflection(
  sessionId: string,
  externalSessionId: string,
  observationCount: number,
  pool: Pool
): Promise<void> {
  logger.info(`Executing reflection for session: ${externalSessionId}`);
  
  try {
    // 1. 获取待反思的观察记录
    const observations = await pool.query(`
      SELECT id, tool_name, tool_input_summary, tool_output_summary, 
             importance, created_at, metadata
      FROM observations
      WHERE session_id = $1
      ORDER BY importance DESC, created_at DESC
      LIMIT 100
    `, [sessionId]);
    
    if (observations.rows.length === 0) {
      logger.info(`No observations to reflect on for session: ${externalSessionId}`);
      return;
    }
    
    // 2. 调用 LLM 进行反思（简化版）
    const reflectionResult = await performReflection(observations.rows);
    
    // 3. 存储反思结果
    for (const pattern of reflectionResult.patterns) {
      if (pattern.confidence >= 0.6) {
        await pool.query(`
          INSERT INTO reflections (
            session_id, summary, source_observation_ids,
            confidence, pattern_type, metadata
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          sessionId,
          pattern.description,
          pattern.sourceObservationIds,
          pattern.confidence,
          pattern.patternType,
          JSON.stringify({
            generatedAt: new Date().toISOString(),
            modelSize: '7b',
            observationCount: observations.rows.length
          })
        ]);
      }
    }
    
    // 4. 更新会话的 reflection_last_at
    await pool.query(`
      UPDATE session_map 
      SET reflection_last_at = NOW()
      WHERE id = $1
    `, [sessionId]);
    
    logger.info(`Reflection completed for session: ${externalSessionId}, patterns: ${reflectionResult.patterns.length}`);
    
  } catch (error) {
    logger.error(`Reflection failed for session: ${externalSessionId}`, error);
    
    // 记录反思错误
    await pool.query(`
      INSERT INTO reflection_errors (
        session_id, error_message, error_stack,
        observation_count, retry_count
      ) VALUES ($1, $2, $3, $4, $5)
    `, [
      sessionId,
      error instanceof Error ? error.message : 'Unknown error',
      error instanceof Error ? error.stack : '',
      observationCount,
      0
    ]);
  }
}

/**
 * 执行反思（简化版）
 * 
 * 注意：实际应调用 LLM API，使用 REFLECTION_SYSTEM_PROMPT
 */
async function performReflection(observations: any[]): Promise<{
  patterns: Array<{
    patternType: string;
    description: string;
    confidence: number;
    sourceObservationIds: string[];
  }>;
}> {
  // 简化版：基于规则的模式识别
  // 实际应调用 7B 蒸馏模型
  
  const patterns: Array<{
    patternType: string;
    description: string;
    confidence: number;
    sourceObservationIds: string[];
  }> = [];
  
  // 错误模式检测
  const errorObservations = observations.filter(obs => 
    obs.tool_output_summary?.toLowerCase().includes('error') ||
    obs.importance >= 4
  );
  
  if (errorObservations.length >= 3) {
    patterns.push({
      patternType: 'error_pattern',
      description: `Detected ${errorObservations.length} error-related observations. Common issues may need attention.`,
      confidence: 0.7,
      sourceObservationIds: errorObservations.map(obs => obs.id).slice(0, 10)
    });
  }
  
  // 高频工具使用模式
  const toolUsage: Record<string, number> = {};
  for (const obs of observations) {
    if (obs.tool_name) {
      toolUsage[obs.tool_name] = (toolUsage[obs.tool_name] || 0) + 1;
    }
  }
  
  const frequentTools = Object.entries(toolUsage)
    .filter(([_, count]) => count >= 5)
    .sort((a, b) => b[1] - a[1]);
  
  if (frequentTools.length > 0) {
    patterns.push({
      patternType: 'tool_preference',
      description: `Frequently used tools: ${frequentTools.map(([name, count]) => `${name}(${count})`).join(', ')}`,
      confidence: 0.8,
      sourceObservationIds: observations
        .filter(obs => obs.tool_name === frequentTools[0][0])
        .map(obs => obs.id)
        .slice(0, 10)
    });
  }
  
  // 成功模式检测
  const successObservations = observations.filter(obs =>
    obs.tool_output_summary?.toLowerCase().includes('success') ||
    obs.tool_output_summary?.toLowerCase().includes('completed')
  );
  
  if (successObservations.length >= 5) {
    patterns.push({
      patternType: 'success_pattern',
      description: `Session showed ${successObservations.length} successful operations.`,
      confidence: 0.75,
      sourceObservationIds: successObservations.map(obs => obs.id).slice(0, 10)
    });
  }
  
  return { patterns };
}

/**
 * 将反思任务排队到低峰期执行
 */
async function queueReflectionForOffPeak(
  sessionId: string,
  externalSessionId: string,
  observationCount: number,
  pool: Pool
): Promise<void> {
  logger.info(`Queued reflection for off-peak execution: ${externalSessionId}`);
  
  // 存储队列信息到 metadata
  await pool.query(`
    UPDATE session_map 
    SET metadata = metadata || $1
    WHERE id = $2
  `, [
    JSON.stringify({
      pendingReflection: {
        queuedAt: new Date().toISOString(),
        observationCount
      }
    }),
    sessionId
  ]);
}

/**
 * 获取反思队列（供定时任务调用）
 */
export async function getPendingReflections(
  pool: Pool
): Promise<Array<{
  sessionId: string;
  externalSessionId: string;
  observationCount: number;
  queuedAt: Date;
}>> {
  const result = await pool.query(`
    SELECT 
      s.id as session_id,
      s.opencode_session_id as external_session_id,
      (s.metadata->'pendingReflection'->>'observationCount')::int as observation_count,
      (s.metadata->'pendingReflection'->>'queuedAt')::timestamptz as queued_at
    FROM session_map s
    WHERE s.metadata->'pendingReflection' IS NOT NULL
      AND s.reflection_last_at < (s.metadata->'pendingReflection'->>'queuedAt')::timestamptz
       OR s.reflection_last_at IS NULL
  `);
  
  return result.rows.map(row => ({
    sessionId: row.session_id,
    externalSessionId: row.external_session_id,
    observationCount: row.observation_count,
    queuedAt: row.queued_at
  }));
}

/**
 * 处理反思错误重试
 */
export async function retryFailedReflections(
  pool: Pool,
  maxRetries: number = 3
): Promise<void> {
  const failedReflections = await pool.query(`
    SELECT * FROM reflection_errors
    WHERE retry_count < $1
      AND created_at > NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC
    LIMIT 10
  `, [maxRetries]);
  
  for (const error of failedReflections.rows) {
    logger.info(`Retrying reflection for session: ${error.session_id}`);
    
    // 增加重试计数
    await pool.query(`
      UPDATE reflection_errors
      SET retry_count = retry_count + 1
      WHERE id = $1
    `, [error.id]);
    
    // 重新执行反思
    const sessionResult = await pool.query(
      'SELECT opencode_session_id FROM session_map WHERE id = $1',
      [error.session_id]
    );
    
    if (sessionResult.rows.length > 0) {
      await executeReflection(
        error.session_id,
        sessionResult.rows[0].opencode_session_id,
        error.observation_count,
        pool
      );
    }
  }
}