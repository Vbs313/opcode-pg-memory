import { Pool } from 'pg';
import { 
  SessionCreatedInput, 
  SessionCreatedOutput, 
  RetrievedFact,
  Entity,
  Reflection 
} from '../types';
import { 
  calculateTokenBudget, 
  formatEntity, 
  formatReflection,
  estimateTokens 
} from '../utils/token-budget';
import { createLogger } from '../services/logger';

const logger = createLogger('session-created');

export interface SessionCreatedHandlerConfig {
  contextLimitRatio: number;
  minTokens: number;
  maxTokens: number;
  minConfidence: number;
  minWeight: number;
}

const DEFAULT_CONFIG: SessionCreatedHandlerConfig = {
  contextLimitRatio: 0.05,
  minTokens: 500,
  maxTokens: 4000,
  minConfidence: 0.5,
  minWeight: 0.3
};

/**
 * 处理 session.created 事件
 * 
 * 功能：
 * 1. 创建或更新 session_map 表记录
 * 2. 基于 Token 预算检索 entities 和 reflections
 * 3. 优先注入 permanent 级别事实，其次 project，最后 session
 * 
 * 签名规范：(input, output) => Promise<void>
 * output 为可变对象，通过突变 output 影响行为
 */
export async function handleSessionCreated(
  input: SessionCreatedInput,
  output: SessionCreatedOutput,    // ✅ 添加 output 参数
  pool: Pool,
  config: Partial<SessionCreatedHandlerConfig> = {}
): Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const { session } = input;
  
  logger.info(`Session created: ${session.id}`);
  
  try {
    // 1. 创建或更新 session 记录
    await upsertSession(session, pool);
    
    // 2. 计算 token 预算
    const budget = calculateTokenBudget(
      session.model.contextLimit,
      {
        contextLimitRatio: mergedConfig.contextLimitRatio,
        minTokens: mergedConfig.minTokens,
        maxTokens: mergedConfig.maxTokens
      }
    );
    
    logger.info(`Token budget for injection: ${budget}`);
    
    // 3. 检索事实
    const facts = await retrieveFactsForInjection(
      session.id,
      budget,
      pool,
      mergedConfig
    );
    
    logger.info(`Retrieved ${facts.length} facts for injection`);
    
    // 4. 格式化输出 → 突变 output
    const memories = facts.map(f => f.content);
    
    // ✅ 正确的钩子签名：mutate output.context
    output.context = { memories };
  } catch (error) {
    logger.error('Error handling session.created:', error);
    // 出错时不阻断主流程，output 保持为空对象
  }
}

/**
 * 创建或更新 session 记录
 */
async function upsertSession(
  session: SessionCreatedInput['session'],
  pool: Pool
): Promise<void> {
  const query = `
    INSERT INTO session_map (opencode_session_id, project_id, model_context_limit, metadata)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (opencode_session_id) 
    DO UPDATE SET 
      project_id = EXCLUDED.project_id,
      model_context_limit = EXCLUDED.model_context_limit,
      last_active_at = NOW(),
      metadata = session_map.metadata || EXCLUDED.metadata
  `;
  
  await pool.query(query, [
    session.id,
    session.projectId || null,
    session.model.contextLimit,
    JSON.stringify({
      modelId: session.model.id,
      modelName: session.model.name
    })
  ]);
}

/**
 * 检索用于注入的事实
 * 优先顺序：permanent > project > session
 */
async function retrieveFactsForInjection(
  sessionId: string,
  budget: number,
  pool: Pool,
  config: SessionCreatedHandlerConfig
): Promise<RetrievedFact[]> {
  const facts: RetrievedFact[] = [];
  let usedTokens = 0;
  
  // 按 tier 优先级检索
  const tierOrder = ['permanent', 'project', 'session'] as const;
  const tierAllocation = {
    permanent: Math.floor(budget * 0.5),
    project: Math.floor(budget * 0.3),
    session: Math.floor(budget * 0.2)
  };
  
  for (const tier of tierOrder) {
    const tierBudget = tierAllocation[tier];
    let tierUsed = 0;
    
    // 检索 entities
    const entities = await retrieveEntitiesByTier(
      sessionId, 
      tier, 
      pool, 
      config
    );
    
    for (const entity of entities) {
      const formatted = formatEntity(entity);
      const tokens = estimateTokens(formatted);
      
      if (tierUsed + tokens <= tierBudget && usedTokens + tokens <= budget) {
        facts.push({
          id: entity.id,
          type: 'entity',
          content: formatted,
          tier,
          tokens,
          relevanceScore: entity.weight,
          metadata: { entityId: entity.id, entityType: entity.type }
        });
        tierUsed += tokens;
        usedTokens += tokens;
      } else {
        break;
      }
    }

    // 如果 tier 预算还有剩余，尝试检索 reflections
    if (tierUsed < tierBudget && usedTokens < budget) {
      const reflections = await retrieveReflectionsByTier(
        sessionId,
        tier,
        pool,
        config
      );

      for (const reflection of reflections) {
        const formatted = formatReflection(reflection);
        const tokens = estimateTokens(formatted);

        if (tierUsed + tokens <= tierBudget && usedTokens + tokens <= budget) {
          facts.push({
            id: reflection.id,
            type: 'reflection',
            content: formatted,
            tier,
            tokens,
            relevanceScore: reflection.confidence,
            metadata: { reflectionId: reflection.id, patternType: reflection.pattern_type }
          });
          tierUsed += tokens;
          usedTokens += tokens;
        } else {
          break;
        }
      }
    }
  }
  
  return facts;
}

/**
 * 按 tier 检索 entities
 */
async function retrieveEntitiesByTier(
  sessionId: string,
  tier: string,
  pool: Pool,
  config: SessionCreatedHandlerConfig
): Promise<Entity[]> {
  const query = `
    SELECT * FROM entities
    WHERE (session_id = $1 OR tier = 'permanent')
      AND tier = $2
      AND weight >= $3
      AND confidence >= $4
    ORDER BY weight DESC, last_seen_at DESC
    LIMIT 50
  `;
  
  const result = await pool.query(query, [
    sessionId,
    tier,
    config.minWeight,
    config.minConfidence
  ]);
  
  return result.rows.map(row => ({
    id: row.id,
    session_id: row.session_id,
    name: row.name,
    type: row.type,
    tier: row.tier,
    weight: row.weight,
    description: row.description,
    embedding: row.embedding,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    confidence: row.confidence,
    metadata: row.metadata
  }));
}

/**
 * 按 tier 检索 reflections
 */
async function retrieveReflectionsByTier(
  sessionId: string,
  tier: string,
  pool: Pool,
  config: SessionCreatedHandlerConfig
): Promise<Reflection[]> {
  // reflections 通过关联的 session 和 observation 推断 tier
  // 简化处理：检索与当前 session 相关的 reflections
  const query = `
    SELECT * FROM reflections
    WHERE session_id = $1
      AND confidence >= $2
    ORDER BY confidence DESC, created_at DESC
    LIMIT 20
  `;
  
  const result = await pool.query(query, [
    sessionId,
    config.minConfidence
  ]);
  
  return result.rows.map(row => ({
    id: row.id,
    session_id: row.session_id,
    summary: row.summary,
    source_observation_ids: row.source_observation_ids || [],
    confidence: row.confidence,
    pattern_type: row.pattern_type,
    created_at: row.created_at,
    embedding: row.embedding,
    metadata: row.metadata
  }));
}