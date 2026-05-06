/**
 * recall_memory MCP 工具 - OmO 适配版本
 *
 * 针对 Oh My OpenAgent 多 Agent 环境优化的记忆检索工具
 * 支持 Agent 隔离、父子 Agent 继承、OmO Wisdom 集成
 */

import { Pool } from 'pg';
import { recallMemory, RecallMemoryInput, RecallMemoryOutput } from './recall-memory';

export interface RecallMemoryOmOInput extends RecallMemoryInput {
  // OmO 特有字段
  agent_id: string;
  task_id?: string;
  parent_agent_id?: string;

  // Agent 范围过滤
  agent_scope?: 'self' | 'siblings' | 'parent' | 'children' | 'all';

  // 是否包含 OmO Wisdom
  include_omo_wisdom?: boolean;

  // 与 OmO 的 Token 预算协调
  omo_context_budget?: number;
  coordination_mode?: 'omo-first' | 'equal' | 'memory-first';
}

export interface RecallMemoryOmOOutput extends RecallMemoryOutput {
  // OmO 特有输出
  agent_id: string;
  task_id?: string;

  // 记忆来源分布
  source_distribution: {
    own_agent: number;
    sibling_agents: number;
    parent_agent: number;
    child_agents: number;
    shared_knowledge: number;
    omo_wisdom?: number;
  };

  // Token 预算使用情况
  token_budget_usage: {
    allocated: number;
    used: number;
    omo_reserved: number;
    remaining: number;
  };

  // 协调状态
  coordination_applied: boolean;
}

/**
 * OmO 版本的 recall_memory 工具
 *
 * 主要差异：
 * 1. 支持 Agent 隔离和范围过滤
 * 2. 与 OmO Token 预算协调
 * 3. 可选集成 OmO Wisdom
 * 4. 详细的来源分布统计
 */
export async function recallMemoryOmO(
  input: RecallMemoryOmOInput,
  pool: Pool
): Promise<RecallMemoryOmOOutput> {
  console.log(`[recall_memory_omo] Agent: ${input.agent_id}, Task: ${input.task_id || 'none'}`);

  const startTime = Date.now();

  try {
    // 1. 计算协调后的 Token 预算
    const tokenBudget = calculateCoordinatedBudget(input);

    // 2. 构建基础查询
    const baseInput: RecallMemoryInput = {
      query: input.query,
      session_id: input.session_id,
      retrieval_strategies: input.retrieval_strategies,
      max_results: input.max_results,
      filters: input.filters,
      rerank: input.rerank
    };

    // 3. 执行基础检索
    const baseResult = await recallMemory(baseInput, pool);

    // 4. 应用 Agent 范围过滤
    const filteredResults = await applyAgentScopeFilter(
      baseResult.results,
      input,
      pool
    );

    // 5. 应用 Token 预算限制
    const budgetedResults = applyTokenBudget(filteredResults, tokenBudget.allocated);

    // 6. 可选：集成 OmO Wisdom
    let omoWisdomResults: any[] = [];
    if (input.include_omo_wisdom) {
      omoWisdomResults = await fetchOmOWisdom(input, pool);
    }

    // 7. 合并结果
    const finalResults = [...budgetedResults, ...omoWisdomResults];

    // 8. 计算来源分布
    const sourceDistribution = calculateSourceDistribution(
      finalResults,
      input.agent_id
    );

    // 9. 计算实际使用的 Token
    const usedTokens = finalResults.reduce(
      (sum, r) => sum + estimateTokens(r.content),
      0
    );

    const retrievalTime = Date.now() - startTime;

    console.log(`[recall_memory_omo] Retrieved ${finalResults.length} results in ${retrievalTime}ms`);

    return {
      query: input.query,
      success: true,
      results: finalResults,
      total_found: baseResult.total_found,
      retrieval_time_ms: retrievalTime,
      strategies_used: baseResult.strategies_used,
      session_id: input.session_id || '',

      // OmO 特有字段
      agent_id: input.agent_id,
      task_id: input.task_id,
      source_distribution: sourceDistribution,
      token_budget_usage: {
        allocated: tokenBudget.allocated,
        used: usedTokens,
        omo_reserved: tokenBudget.omoReserved,
        remaining: tokenBudget.allocated - usedTokens
      },
      coordination_applied: !!input.omo_context_budget
    };

  } catch (error) {
    console.error('[recall_memory_omo] Error:', error);
    throw error;
  }
}

/**
 * 计算与 OmO 协调的 Token 预算
 */
function calculateCoordinatedBudget(input: RecallMemoryOmOInput): {
  allocated: number;
  omoReserved: number;
  total: number;
} {
  const defaultBudget = 2000;
  const omoBudget = input.omo_context_budget || defaultBudget;
  const mode = input.coordination_mode || 'equal';

  switch (mode) {
    case 'omo-first':
      const omoReserved = Math.floor(omoBudget * 0.6);
      return {
        allocated: omoBudget - omoReserved,
        omoReserved,
        total: omoBudget
      };

    case 'equal':
      return {
        allocated: Math.floor(omoBudget * 0.5),
        omoReserved: Math.floor(omoBudget * 0.5),
        total: omoBudget
      };

    case 'memory-first':
      return {
        allocated: Math.floor(omoBudget * 0.7),
        omoReserved: Math.floor(omoBudget * 0.3),
        total: omoBudget
      };

    default:
      return {
        allocated: defaultBudget,
        omoReserved: 0,
        total: defaultBudget
      };
  }
}

/**
 * 应用 Agent 范围过滤
 */
async function applyAgentScopeFilter(
  results: any[],
  input: RecallMemoryOmOInput,
  pool: Pool
): Promise<any[]> {
  const scope = input.agent_scope || 'all';

  if (scope === 'all') {
    return results;
  }

  // 获取相关 Agent ID 列表
  let allowedAgents: string[] = [input.agent_id];

  switch (scope) {
    case 'self':
      // 只允许当前 Agent 和共享知识
      break;

    case 'siblings':
      // 获取同级 Agent
      if (input.parent_agent_id) {
        const siblingResult = await pool.query(`
          SELECT DISTINCT source_agent
          FROM observations
          WHERE agent_task_id IN (
            SELECT agent_task_id FROM observations
            WHERE source_agent = $1
          )
          AND source_agent != $1
        `, [input.agent_id]);
        allowedAgents.push(...siblingResult.rows.map(r => r.source_agent));
      }
      break;

    case 'parent':
      // 包含父 Agent
      if (input.parent_agent_id) {
        allowedAgents.push(input.parent_agent_id);
      }
      break;

    case 'children':
      // 获取子 Agent
      const childResult = await pool.query(`
        SELECT DISTINCT source_agent
        FROM omo_coordination
        WHERE coordination_data->>'parentAgentId' = $1
      `, [input.agent_id]);
      allowedAgents.push(...childResult.rows.map(r => r.source_agent));
      break;
  }

  // 过滤结果
  return results.filter(r => {
    // 共享层级总是允许
    if (r.metadata.tier === 'permanent' || r.metadata.tier === 'project') {
      return true;
    }

    // 检查 Agent 归属
    const resultAgent = r.metadata.source_agent;
    return !resultAgent || allowedAgents.includes(resultAgent);
  });
}

/**
 * 应用 Token 预算限制
 */
function applyTokenBudget(results: any[], budget: number): any[] {
  let usedTokens = 0;
  const selected: any[] = [];

  for (const result of results) {
    const tokens = estimateTokens(result.content);

    if (usedTokens + tokens <= budget) {
      selected.push(result);
      usedTokens += tokens;
    } else {
      break;
    }
  }

  return selected;
}

/**
 * 获取 OmO Wisdom
 */
async function fetchOmOWisdom(
  input: RecallMemoryOmOInput,
  pool: Pool
): Promise<any[]> {
  // 这里应该查询 OmO 的 Wisdom 表
  // 简化实现：查询 reflections 中标记为 wisdom 的记录
  const result = await pool.query(`
    SELECT id, summary as content, pattern_type, confidence, metadata
    FROM reflections
    WHERE metadata->>'type' = 'omo-wisdom'
      OR metadata->>'source' = 'pg-memory-hindsight'
    ORDER BY confidence DESC, created_at DESC
    LIMIT 5
  `);

  return result.rows.map(row => ({
    id: row.id,
    type: 'omo_wisdom',
    content: `[OmO Wisdom] ${row.content}`,
    relevance_score: row.confidence,
    metadata: {
      pattern_type: row.pattern_type,
      source: 'omo_wisdom',
      ...row.metadata
    }
  }));
}

/**
 * 计算来源分布
 */
function calculateSourceDistribution(
  results: any[],
  agentId: string
): RecallMemoryOmOOutput['source_distribution'] {
  const distribution = {
    own_agent: 0,
    sibling_agents: 0,
    parent_agent: 0,
    child_agents: 0,
    shared_knowledge: 0,
    omo_wisdom: 0
  };

  for (const result of results) {
    const sourceAgent = result.metadata?.source_agent;
    const tier = result.metadata?.tier;
    const type = result.type;

    if (type === 'omo_wisdom') {
      distribution.omo_wisdom++;
    } else if (tier === 'permanent' || tier === 'project') {
      distribution.shared_knowledge++;
    } else if (sourceAgent === agentId) {
      distribution.own_agent++;
    } else if (result.metadata?.agent_relation === 'sibling') {
      distribution.sibling_agents++;
    } else if (result.metadata?.agent_relation === 'parent') {
      distribution.parent_agent++;
    } else if (result.metadata?.agent_relation === 'child') {
      distribution.child_agents++;
    } else {
      distribution.shared_knowledge++;
    }
  }

  return distribution;
}

/**
 * 估算 Token 数
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}