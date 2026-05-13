import { Pool } from "pg";
import { SessionCompletedInput, SessionCompletedOutput } from "../types";
import { createLogger } from "../services/logger";
import { hindsightReflect } from "../mcp/hindsight-reflect";
import { applyReflection } from "../mcp/apply-reflection";

const logger = createLogger("session-completed");

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
  offPeakHours: [1, 2, 3, 4, 5], // 凌晨 1-5 点
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
  output: SessionCompletedOutput, // ✅ 添加 output 参数
  pool: Pool,
  config: Partial<SessionCompletedHandlerConfig> = {},
): Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const { session, summary } = input;

  logger.info(
    `Session completed: ${session.id}, messages: ${session.messageCount}, duration: ${session.durationMs}ms`,
  );

  try {
    // 获取 session 内部 ID
    const sessionResult = await pool.query(
      "SELECT id, reflection_last_at FROM session_map WHERE opencode_session_id = $1",
      [session.id],
    );

    if (sessionResult.rows.length === 0) {
      logger.warn(`Session not found: ${session.id}`);
      return; // ✅ 返回 void
    }

    const sessionInternalId = sessionResult.rows[0].id;
    const reflectionLastAt = sessionResult.rows[0].reflection_last_at;

    // 1. 统计本次会话的观察数量
    const observationStats = await getObservationStats(
      sessionInternalId,
      reflectionLastAt,
      pool,
    );

    logger.info(
      `Observations since last reflection: ${observationStats.countSinceLastReflection}`,
    );

    // 2. 检查是否应该触发反思
    const shouldReflect = await checkShouldTriggerReflection(
      sessionInternalId,
      observationStats.countSinceLastReflection,
      mergedConfig,
      pool,
    );

    if (shouldReflect && mergedConfig.enableReflection) {
      // 3. 调度反思任务
      await scheduleReflectionTask(
        sessionInternalId,
        session.id,
        observationStats.countSinceLastReflection,
        mergedConfig,
        pool,
      );
    }

    // 4. 记录会话完成
    await pool.query(
      `
      UPDATE session_map 
      SET last_active_at = NOW(),
          metadata = metadata || $1
      WHERE id = $2
    `,
      [
        JSON.stringify({
          lastSessionSummary: summary,
          messageCount: session.messageCount,
          durationMs: session.durationMs,
          reflectionTriggered: shouldReflect,
        }),
        sessionInternalId,
      ],
    );

    // 5. 记录 token 使用
    await pool.query(
      `
      INSERT INTO token_usage_log (session_map_id, operation_type, tokens_used, metadata)
      VALUES ($1, $2, $3, $4)
    `,
      [
        sessionInternalId,
        "session_completion",
        0,
        JSON.stringify({
          messageCount: session.messageCount,
          durationMs: session.durationMs,
          observationCount: observationStats.totalCount,
        }),
      ],
    );

    logger.info(`Session completion processed: ${session.id}`);

    // ✅ 正确的钩子签名：不返回任何值
  } catch (error) {
    logger.error("Error handling session.completed:", error);
    // 出错时不阻断主流程
  }
}

/**
 * 获取观察统计
 */
async function getObservationStats(
  sessionId: string,
  reflectionLastAt: Date | null,
  pool: Pool,
): Promise<{ totalCount: number; countSinceLastReflection: number }> {
  // 总观察数
  const totalResult = await pool.query(
    "SELECT COUNT(*) as count FROM observations WHERE session_map_id = $1",
    [sessionId],
  );

  const totalCount = parseInt(totalResult.rows[0].count, 10);

  // 上次反思后的观察数
  let countSinceLastReflection = totalCount;
  if (reflectionLastAt) {
    const sinceResult = await pool.query(
      `
      SELECT COUNT(*) as count 
      FROM observations 
      WHERE session_map_id = $1 AND created_at > $2
    `,
      [sessionId, reflectionLastAt],
    );
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
  pool: Pool,
): Promise<boolean> {
  if (!config.enableReflection) {
    return false;
  }

  // 随机阈值：30-50 条经验
  const threshold =
    Math.floor(
      Math.random() *
        (config.maxObservationThreshold - config.minObservationThreshold + 1),
    ) + config.minObservationThreshold;

  logger.info(
    `Reflection threshold: ${threshold}, current: ${observationCount}`,
  );

  if (observationCount < threshold) {
    return false;
  }

  // 检查是否有正在进行的反思任务
  const pendingResult = await pool.query(
    `
    SELECT COUNT(*) as count 
    FROM reflections 
    WHERE session_map_id = $1 AND created_at > NOW() - INTERVAL '1 hour'
  `,
    [sessionId],
  );

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
  pool: Pool,
): Promise<void> {
  const currentHour = new Date().getHours();
  const isOffPeak = config.offPeakHours.includes(currentHour);

  logger.info(
    `Scheduling reflection task for session: ${externalSessionId}, off-peak: ${isOffPeak}`,
  );

  if (isOffPeak) {
    // 低峰期：立即执行
    await executeReflection(
      sessionInternalId,
      externalSessionId,
      observationCount,
      pool,
    );
  } else {
    // 非低峰期：延迟到下一个低峰期
    await queueReflectionForOffPeak(
      sessionInternalId,
      externalSessionId,
      observationCount,
      pool,
    );
  }
}

/**
 * 执行反思任务
 */
async function executeReflection(
  sessionMapId: string,
  externalSessionId: string,
  _observationCount: number,
  pool: Pool,
): Promise<void> {
  logger.info(`Executing auto-reflection for session: ${externalSessionId}`);
  try {
    const result = await hindsightReflect(
      { session_id: externalSessionId, trigger_type: "auto" },
      pool,
    );
    const { generated_reflections } = result;
    let appliedCount = 0;
    for (const ref of generated_reflections) {
      if (ref.confidence >= 0.8 && (ref as any).action_plan) {
        const appResult = await applyReflection({ pattern_id: ref.id }, pool);
        if (appResult.applied) {
          appliedCount++;
          logger.info(`Auto-applied ${ref.id} (${ref.pattern_type})`);
        }
      }
    }
    await pool.query(
      `UPDATE session_map SET metadata = metadata || $1 WHERE id = $2`,
      [
        JSON.stringify({
          autoReflected: true,
          reflectionCount: generated_reflections.length,
          autoApplied: appliedCount,
        }),
        sessionMapId,
      ],
    );
  } catch (error) {
    logger.error(`Auto-reflection failed for ${externalSessionId}:`, error);
  }
}

/**
 * 将反思任务排队到低峰期执行。异步非阻塞。
 */
async function queueReflectionForOffPeak(
  sessionId: string,
  externalSessionId: string,
  observationCount: number,
  pool: Pool,
): Promise<void> {
  logger.info(`Queued reflection for off-peak execution: ${externalSessionId}`);

  // 存储队列信息到 metadata
  await pool.query(
    `
    UPDATE session_map 
    SET metadata = metadata || $1
    WHERE id = $2
  `,
    [
      JSON.stringify({
        pendingReflection: {
          queuedAt: new Date().toISOString(),
          observationCount,
        },
      }),
      sessionId,
    ],
  );
}

/**
 * 获取反思队列（供定时任务调用）
 */
export async function getPendingReflections(pool: Pool): Promise<
  Array<{
    sessionId: string;
    externalSessionId: string;
    observationCount: number;
    queuedAt: Date;
  }>
> {
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

  return result.rows.map((row) => ({
    sessionId: row.session_id,
    externalSessionId: row.external_session_id,
    observationCount: row.observation_count,
    queuedAt: row.queued_at,
  }));
}

/**
 * 处理反思错误重试
 */
export async function retryFailedReflections(
  pool: Pool,
  maxRetries: number = 3,
): Promise<void> {
  const failedReflections = await pool.query(
    `
    SELECT * FROM reflection_errors
    WHERE retry_count < $1
      AND created_at > NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC
    LIMIT 10
  `,
    [maxRetries],
  );

  for (const error of failedReflections.rows) {
    logger.info(`Retrying reflection for session: ${error.session_id}`);

    // 增加重试计数
    await pool.query(
      `
      UPDATE reflection_errors
      SET retry_count = retry_count + 1
      WHERE id = $1
    `,
      [error.id],
    );

    // 重新执行反思
    const sessionResult = await pool.query(
      "SELECT opencode_session_id FROM session_map WHERE id = $1",
      [error.session_id],
    );

    if (sessionResult.rows.length > 0) {
      await executeReflection(
        error.session_id,
        sessionResult.rows[0].opencode_session_id,
        error.observation_count,
        pool,
      );
    }
  }
}
