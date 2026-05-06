/**
 * hindsight_reflect MCP 工具 - OmO 适配版本
 *
 * 针对 Oh My OpenAgent 多 Agent 环境优化的反思工具
 * 与 OmO Wisdom Accumulation 机制集成
 */

import { Pool } from 'pg';
import { hindsightReflect, HindsightReflectInput, HindsightReflectOutput } from './hindsight-reflect';

export interface HindsightReflectOmOInput extends HindsightReflectInput {
  // OmO 特有字段
  agent_id: string;
  task_id?: string;
  parent_session_id?: string;

  // 与 OmO Wisdom 的集成选项
  sync_to_omo_wisdom?: boolean;
  omo_wisdom_tags?: string[];

  // 反思范围
  reflection_scope?: 'agent-only' | 'task-only' | 'session-wide' | 'hierarchical';

  // 与 OmO 后台生命周期的协调
  respect_omo_timeout?: boolean;
  omo_timeout_deadline?: string; // ISO timestamp
}

export interface HindsightReflectOmOOutput extends HindsightReflectOutput {
  // OmO 特有输出
  agent_id: string;
  task_id?: string;

  // Status fields (backward compat)
  success?: boolean;
  error?: string;

  // OmO Wisdom 同步状态
  omo_wisdom_synced: boolean;
  omo_wisdom_entries?: Array<{
    id: string;
    type: string;
    content: string;
  }>;

  // 跨 Agent 统计
  cross_agent_stats?: {
    total_observations: number;
    own_observations: number;
    inherited_observations: number;
    child_agent_observations: number;
  };

  // 与 OmO 生命周期的协调状态
  coordination_status: {
    completed_before_timeout: boolean;
    timeout_was_respected: boolean;
    omo_acknowledged: boolean;
  };
}

/**
 * OmO 版本的 hindsight_reflect 工具
 *
 * 主要差异：
 * 1. 支持按 Agent 范围反思
 * 2. 与 OmO Wisdom Accumulation 同步
 * 3. 尊重 OmO 后台超时控制
 * 4. 支持层级反思（父子 Agent）
 */
export async function hindsightReflectOmO(
  input: HindsightReflectOmOInput,
  pool: Pool
): Promise<HindsightReflectOmOOutput> {
  console.log(`[hindsight_reflect_omo] Agent: ${input.agent_id}, Scope: ${input.reflection_scope || 'agent-only'}`);

  const startTime = Date.now();

  // 检查 OmO 超时
  const timeoutCheck = checkOmOTimeout(input);
  if (timeoutCheck.wouldTimeout) {
    console.warn(`[hindsight_reflect_omo] Would exceed OmO timeout, queuing for later`);
    await queueReflectionForLater(input, pool);

    return {
      success: false,
      error: 'Queued for off-peak execution due to OmO timeout constraints',
      generated_reflections: [],
      token_usage: { input: 0, output: 0, total: 0 },
      duration_ms: 0,
      agent_id: input.agent_id,
      task_id: input.task_id,
      omo_wisdom_synced: false,
      coordination_status: {
        completed_before_timeout: false,
        timeout_was_respected: true,
        omo_acknowledged: false
      }
    };
  }

  try {
    // 1. 收集指定范围的观察
    const observations = await collectObservationsByScope(input, pool);

    // 2. 执行基础反思
    const baseInput: HindsightReflectInput = {
      session_id: input.session_id,
      trigger_type: input.trigger_type,
      observation_threshold: input.observation_threshold,
      model_size: input.model_size
    };

    const baseResult = await hindsightReflect(baseInput, pool);

    // 3. 同步到 OmO Wisdom
    let wisdomSynced = false;
    let wisdomEntries: any[] = [];

    if (input.sync_to_omo_wisdom && baseResult.generated_reflections.length > 0) {
      const syncResult = await syncToOmOWisdom(input, baseResult, pool);
      wisdomSynced = syncResult.success;
      wisdomEntries = syncResult.entries;
    }

    const processingTime = Date.now() - startTime;

    // 4. 检查是否在 OmO 超时前完成
    const completedBeforeTimeout = !timeoutCheck.deadline ||
      Date.now() < timeoutCheck.deadline.getTime();

    console.log(`[hindsight_reflect_omo] Completed in ${processingTime}ms, wisdom synced: ${wisdomSynced}`);

    return {
      ...baseResult,
      agent_id: input.agent_id,
      task_id: input.task_id,
      omo_wisdom_synced: wisdomSynced,
      omo_wisdom_entries: wisdomEntries,
      cross_agent_stats: observations.stats,
      coordination_status: {
        completed_before_timeout: completedBeforeTimeout,
        timeout_was_respected: input.respect_omo_timeout !== false,
        omo_acknowledged: wisdomSynced
      }
    };

  } catch (error) {
    console.error('[hindsight_reflect_omo] Error:', error);

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      generated_reflections: [],
      token_usage: { input: 0, output: 0, total: 0 },
      duration_ms: Date.now() - startTime,
      agent_id: input.agent_id,
      task_id: input.task_id,
      omo_wisdom_synced: false,
      coordination_status: {
        completed_before_timeout: false,
        timeout_was_respected: input.respect_omo_timeout !== false,
        omo_acknowledged: false
      }
    };
  }
}

/**
 * 检查 OmO 超时
 */
function checkOmOTimeout(input: HindsightReflectOmOInput): {
  wouldTimeout: boolean;
  deadline?: Date;
} {
  if (!input.respect_omo_timeout || !input.omo_timeout_deadline) {
    return { wouldTimeout: false };
  }

  const deadline = new Date(input.omo_timeout_deadline);
  const now = new Date();
  const timeRemaining = deadline.getTime() - now.getTime();

  // 预估反思需要的时间（毫秒）
  const estimatedTime = 30000; // 30秒

  return {
    wouldTimeout: timeRemaining < estimatedTime,
    deadline
  };
}

/**
 * 按范围收集观察
 */
async function collectObservationsByScope(
  input: HindsightReflectOmOInput,
  pool: Pool
): Promise<{
  observations: any[];
  stats: HindsightReflectOmOOutput['cross_agent_stats'];
}> {
  const scope = input.reflection_scope || 'agent-only';
  let query: string;
  let params: any[];

  switch (scope) {
    case 'agent-only':
      query = `
        SELECT * FROM observations
        WHERE session_id = (SELECT id FROM sessions WHERE external_id = $1)
          AND source_agent = $2
        ORDER BY created_at DESC
        LIMIT 100
      `;
      params = [input.session_id, input.agent_id];
      break;

    case 'task-only':
      query = `
        SELECT * FROM observations
        WHERE session_id = (SELECT id FROM sessions WHERE external_id = $1)
          AND agent_task_id = $2
        ORDER BY created_at DESC
        LIMIT 100
      `;
      params = [input.session_id, input.task_id];
      break;

    case 'session-wide':
      query = `
        SELECT * FROM observations
        WHERE session_id = (SELECT id FROM sessions WHERE external_id = $1)
        ORDER BY created_at DESC
        LIMIT 200
      `;
      params = [input.session_id];
      break;

    case 'hierarchical':
      // 包含当前 Agent、父 Agent 和子 Agent 的观察
      query = `
        SELECT o.*, 
          CASE 
            WHEN o.source_agent = $2 THEN 'own'
            WHEN oc.coordination_data->>'parentAgentId' = $2 THEN 'child'
            WHEN o.source_agent = oc.coordination_data->>'parentAgentId' THEN 'parent'
            ELSE 'other'
          END as agent_relation
        FROM observations o
        LEFT JOIN omo_coordination oc ON o.source_agent = oc.agent_id
        WHERE o.session_id = (SELECT id FROM sessions WHERE external_id = $1)
          AND (
            o.source_agent = $2
            OR oc.coordination_data->>'parentAgentId' = $2
            OR o.source_agent = (SELECT coordination_data->>'parentAgentId' FROM omo_coordination WHERE agent_id = $2 LIMIT 1)
          )
        ORDER BY o.created_at DESC
        LIMIT 200
      `;
      params = [input.session_id, input.agent_id];
      break;

    default:
      query = `
        SELECT * FROM observations
        WHERE session_id = (SELECT id FROM sessions WHERE external_id = $1)
          AND source_agent = $2
        ORDER BY created_at DESC
        LIMIT 100
      `;
      params = [input.session_id, input.agent_id];
  }

  const result = await pool.query(query, params);

  // 计算统计
  const stats: HindsightReflectOmOOutput['cross_agent_stats'] = {
    total_observations: result.rows.length,
    own_observations: 0,
    inherited_observations: 0,
    child_agent_observations: 0
  };

  for (const row of result.rows) {
    const relation = row.agent_relation;
    if (relation === 'own' || row.source_agent === input.agent_id) {
      stats.own_observations++;
    } else if (relation === 'parent') {
      stats.inherited_observations++;
    } else if (relation === 'child') {
      stats.child_agent_observations++;
    }
  }

  return { observations: result.rows, stats };
}

/**
 * 同步到 OmO Wisdom
 */
async function syncToOmOWisdom(
  input: HindsightReflectOmOInput,
  reflectResult: HindsightReflectOutput,
  pool: Pool
): Promise<{
  success: boolean;
  entries: any[];
}> {
  const entries: any[] = [];

  try {
    for (const reflection of reflectResult.generated_reflections || []) {
      const wisdomEntry = {
        id: `wisdom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: reflection.pattern_type || 'insight',
        content: reflection.summary,
        metadata: {
          source: 'pg-memory-hindsight',
          agent_id: input.agent_id,
          task_id: input.task_id,
          session_id: input.session_id,
          confidence: reflection.confidence,
          source_observation_ids: reflection.source_observation_ids,
          tags: input.omo_wisdom_tags || [],
          created_at: new Date().toISOString()
        }
      };

      // 存储到 OmO Wisdom 表（如果存在）
      await pool.query(`
        INSERT INTO omo_wisdom (id, type, content, metadata, agent_id, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (id) DO UPDATE SET
          content = EXCLUDED.content,
          metadata = EXCLUDED.metadata
      `, [
        wisdomEntry.id,
        wisdomEntry.type,
        wisdomEntry.content,
        JSON.stringify(wisdomEntry.metadata),
        input.agent_id
      ]);

      entries.push(wisdomEntry);
    }

    return { success: true, entries };
  } catch (error) {
    console.error('[hindsight_reflect_omo] Failed to sync to OmO Wisdom:', error);
    return { success: false, entries };
  }
}

/**
 * 将反思任务排队到稍后执行
 */
async function queueReflectionForLater(
  input: HindsightReflectOmOInput,
  pool: Pool
): Promise<void> {
  await pool.query(`
    INSERT INTO omo_coordination (session_id, agent_id, coordination_type, coordination_data)
    VALUES ($1, $2, $3, $4)
  `, [
    input.session_id,
    input.agent_id,
    'queued-reflection',
    JSON.stringify({
      task_id: input.task_id,
      queued_at: new Date().toISOString(),
      input: {
        trigger_type: input.trigger_type,
        observation_threshold: input.observation_threshold,
        model_size: input.model_size,
        reflection_scope: input.reflection_scope
      }
    })
  ]);
}

/**
 * 获取排队的反思任务
 */
export async function getQueuedReflections(
  pool: Pool
): Promise<Array<{
  session_id: string;
  agent_id: string;
  coordination_data: any;
}>> {
  const result = await pool.query(`
    SELECT session_id, agent_id, coordination_data
    FROM omo_coordination
    WHERE coordination_type = 'queued-reflection'
    ORDER BY created_at ASC
  `);

  return result.rows;
}

/**
 * 处理排队的反思任务
 */
export async function processQueuedReflections(pool: Pool): Promise<void> {
  const queued = await getQueuedReflections(pool);

  for (const item of queued) {
    const input: HindsightReflectOmOInput = {
      session_id: item.session_id,
      agent_id: item.agent_id,
      task_id: item.coordination_data.task_id,
      trigger_type: item.coordination_data.input.trigger_type,
      observation_threshold: item.coordination_data.input.observation_threshold,
      model_size: item.coordination_data.input.model_size,
      reflection_scope: item.coordination_data.input.reflection_scope,
      respect_omo_timeout: false // 队列任务不检查超时
    };

    await hindsightReflectOmO(input, pool);

    // 删除已处理的队列项
    await pool.query(`
      DELETE FROM omo_coordination
      WHERE session_id = $1 AND agent_id = $2 AND coordination_type = 'queued-reflection'
    `, [item.session_id, item.agent_id]);
  }
}