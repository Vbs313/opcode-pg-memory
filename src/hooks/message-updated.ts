import { Pool } from 'pg';
import { 
  MessageUpdatedInput, 
  MessageUpdatedOutput,
  EntityTier,
  OpenCodeMessage
} from '../types';
import { estimateTokens } from '../utils/token-budget';
import { stripPrivateContent } from '../services/privacy';
import { createLogger } from '../services/logger';

const logger = createLogger('message-updated');

export interface MessageUpdatedHandlerConfig {
  minConfidence: number;
  minEntityNameLength: number;
  maxEntitiesPerMessage: number;
  maxRelationsPerEntity: number;
}

const DEFAULT_CONFIG: MessageUpdatedHandlerConfig = {
  minConfidence: 0.5,
  minEntityNameLength: 2,
  maxEntitiesPerMessage: 10,
  maxRelationsPerEntity: 5
};

/**
 * 处理 message.updated 事件
 * 
 * 功能：
 * 1. 存储原始消息到 messages 表
 * 2. 异步调用 LLM 提取命名实体
 * 3. 识别实体间关系
 * 4. 写入 entities 表（置信度 < 0.5 的不写入）
 * 5. 写入 relations 表（置信度 < 0.5 的不写入）
 * 6. 更新实体 weight 和 last_seen_at
 * 
 * 签名规范：(input, output) => Promise<void>
 */
export async function handleMessageUpdated(
  input: MessageUpdatedInput,
  output: MessageUpdatedOutput,    // ✅ 添加 output 参数
  pool: Pool,
  config: Partial<MessageUpdatedHandlerConfig> = {}
): Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const { session, message } = input;
  
  logger.info(`Message updated: ${message.id}, role: ${message.role}`);
  
  try {
    // storeMessage disabled: messages table removed in v2.3.2
    // Raw messages stored only in OpenCode SQLite
    
    // 2. 获取 session 内部 ID
    const sessionResult = await pool.query(
      'SELECT id FROM session_map WHERE opencode_session_id = $1',
      [session.id]
    );
    
    if (sessionResult.rows.length === 0) {
      logger.warn(`Session not found: ${session.id}`);
      return;  // ✅ 返回 void
    }
    
    const sessionInternalId = sessionResult.rows[0].id;
    
    // 3. 提取实体（异步，不阻塞主流程）
    extractEntitiesAndRelations(
      sessionInternalId,
      message.content,
      session.id,
      pool,
      mergedConfig
    ).catch(err => 
      logger.warn('Failed to extract entities:', err.message)
    );
    
    // ✅ 正确的钩子签名：不返回任何值
  } catch (error) {
    logger.error('Error handling message.updated:', error);
    // 出错时不阻断主流程
  }
}

/**
 * storeMessage disabled: messages table removed in v2.3.2
 * Raw messages stored only in OpenCode SQLite
 *//*
async function storeMessage(
  sessionId: string,
  message: OpenCodeMessage,
  pool: Pool
): Promise<void> {
  try {
    // 提取 reasoning 内容
    const reasoningPart = message.parts?.find(p => p.type === 'reasoning');
    const reasoning = reasoningPart?.text || null;
    
    // 提取主要文本内容
    const textPart = message.parts?.find(p => p.type === 'text');
    const content = textPart?.text || message.content || '';
    
    // 提取工具调用信息
    const toolParts = message.parts?.filter(p => p.type === 'tool') || [];
    const toolCalls: any[] = toolParts.map(p => ({
      type: p.type,
      tool: p.tool?.name || '',
      callID: p.tool?.callID || '',
      input: p.tool?.state?.input || {},
      output: p.tool?.state?.output || null,
      status: p.tool?.state?.status || 'pending'
    }));
    
    // 计算总 token
    const tokenTotal = message.tokens?.total || 0;
    
    await pool.query(`
      INSERT INTO messages (
        session_id,
        message_id,
        role,
        raw_message,
        reasoning,
        content,
        tool_calls,
        token_input,
        token_output,
        token_reasoning,
        token_total,
        cost,
        model_id,
        agent,
        mode,
        finish_reason,
        created_at,
        completed_at,
        embedding
      ) VALUES (
        (SELECT id FROM session_map WHERE opencode_session_id = $1),
        $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14, $15, $16,
        TO_TIMESTAMP($17/1000), 
        CASE WHEN $18 IS NOT NULL THEN TO_TIMESTAMP($18/1000) ELSE NULL END,
        NULL
      )
      ON CONFLICT (message_id) DO UPDATE SET
        raw_message = EXCLUDED.raw_message,
        reasoning = EXCLUDED.reasoning,
        content = EXCLUDED.content,
        tool_calls = EXCLUDED.tool_calls,
        token_input = EXCLUDED.token_input,
        token_output = EXCLUDED.token_output,
        token_reasoning = EXCLUDED.token_reasoning,
        token_total = EXCLUDED.token_total,
        cost = EXCLUDED.cost,
        completed_at = EXCLUDED.completed_at,
        finish_reason = EXCLUDED.finish_reason
    `, [
      sessionId,
      message.id,
      message.role,
      JSON.stringify(message),
      reasoning,
      content,
      toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
      message.tokens?.input || 0,
      message.tokens?.output || 0,
      message.tokens?.reasoning || 0,
      tokenTotal,
      message.cost || 0,
      message.modelID || null,
      message.agent || null,
      message.mode || null,
      message.finish || null,
      message.time?.created || Date.now(),
      message.time?.completed
    ]);
    
    logger.info(`Stored message: ${message.id} (${message.role}, ${tokenTotal} tokens)`);
  } catch (error) {
    logger.error('Failed to store message:', error);
    throw error;
  }
}
*/

/**
 * 从消息内容中提取实体和关系（统一入口）
 */
async function extractEntitiesAndRelations(
  sessionId: string,
  content: string,
  externalSessionId: string,
  pool: Pool,
  config: MessageUpdatedHandlerConfig
): Promise<void> {
  const extractedEntities = await extractEntities(
    content,
    sessionId,
    pool,
    config
  );
  
  logger.info(`Extracted ${extractedEntities.length} entities`);
  
  if (extractedEntities.length >= 2) {
    await extractAndStoreRelations(
      extractedEntities,
      content,
      sessionId,
      pool,
      config
    );
  }
}

/**
 * 从消息内容中提取实体
 * 
 * 注意：这是一个简化实现。生产环境应该调用 LLM API 进行 NER。
 */
async function extractEntities(
  content: string,
  sessionId: string,
  pool: Pool,
  config: MessageUpdatedHandlerConfig
): Promise<Array<{ id: string; name: string; type: string }>> {
  const entities: Array<{ id: string; name: string; type: string }> = [];
  
  // 移除 <private> 标记内容后再进行实体提取
  const sanitizedContent = stripPrivateContent(content);
  
  // 基于规则的实体提取（简化版）
  const extractedNames = heuristicEntityExtraction(sanitizedContent);
  
  for (const extracted of extractedNames.slice(0, config.maxEntitiesPerMessage)) {
    if (extracted.name.length < config.minEntityNameLength) {
      continue;
    }
    
    // 模拟置信度（实际应从 LLM 获取）
    const confidence = Math.random() * 0.5 + 0.5;
    
    if (confidence < config.minConfidence) {
      continue;
    }
    
    // 检查是否已存在相同实体
    const existingResult = await pool.query(`
      SELECT id, weight FROM entities 
      WHERE session_map_id = $1 AND name = $2 AND type = $3
    `, [sessionId, extracted.name, extracted.type]);
    
    if (existingResult.rows.length > 0) {
      // 更新现有实体
      const existingId = existingResult.rows[0].id;
      const currentWeight = existingResult.rows[0].weight;
      
      await pool.query(`
        UPDATE entities 
        SET weight = LEAST(weight + 0.1, 10.0),
            last_seen_at = NOW(),
            confidence = GREATEST(confidence, $1)
        WHERE id = $2
      `, [confidence, existingId]);
      
      entities.push({
        id: existingId,
        name: extracted.name,
        type: extracted.type
      });
      
      logger.info(`Updated entity: ${extracted.name} (weight: ${(currentWeight + 0.1).toFixed(2)})`);
    } else {
      // 创建新实体
      const tier = determineEntityTier(extracted.type, content);
      
      const insertResult = await pool.query(`
        INSERT INTO entities (
          session_id, name, type, tier, weight, description, 
          confidence, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
      `, [
        sessionId,
        extracted.name,
        extracted.type,
        tier,
        1.0,
        generateEntityDescription(extracted.name, extracted.type, content),
        confidence,
        JSON.stringify({ source: 'message.updated' })
      ]);
      
      const newId = insertResult.rows[0].id;
      entities.push({
        id: newId,
        name: extracted.name,
        type: extracted.type
      });
      
      logger.info(`Created entity: ${extracted.name} (${extracted.type})`);
    }
  }
  
  return entities;
}

/**
 * 启发式实体提取（简化版）
 */
function heuristicEntityExtraction(content: string): Array<{ name: string; type: string }> {
  const entities: Array<{ name: string; type: string }> = [];
  
  const patterns = [
    { regex: /function\s+(\w+)\s*\(/g, type: 'function' },
    { regex: /(?:const|let|var)\s+(\w+)\s*=\s*(?:function|=>)/g, type: 'function' },
    { regex: /class\s+(\w+)/g, type: 'class' },
    { regex: /(?:const|let|var)\s+([A-Z_][A-Z0-9_]*)\s*=/g, type: 'constant' },
    { regex: /['"]([\w\-./]+\.(?:ts|js|tsx|jsx|json|md))['"]/g, type: 'file' },
    { regex: /from\s+['"]([@\w\-/.]+)['"]/g, type: 'module' },
    { regex: /(?:TODO|FIXME|NOTE|HACK):?\s*(.+?)(?:\n|$)/gi, type: 'task' }
  ];
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.regex.exec(content)) !== null) {
      const name = match[1].trim();
      if (name.length >= 2 && !entities.some(e => e.name === name)) {
        entities.push({ name, type: pattern.type });
      }
    }
  }
  
  return entities;
}

/**
 * 确定实体层级
 */
function determineEntityTier(type: string, content: string): EntityTier {
  if (['constant', 'config', 'setting'].includes(type)) {
    return 'permanent';
  }
  
  if (['module', 'class', 'interface'].includes(type)) {
    return 'project';
  }
  
  return 'session';
}

/**
 * 生成实体描述
 */
function generateEntityDescription(name: string, type: string, content: string): string {
  const index = content.indexOf(name);
  if (index === -1) {
    return `${type}: ${name}`;
  }
  
  const start = Math.max(0, index - 100);
  const end = Math.min(content.length, index + name.length + 100);
  const context = content.substring(start, end);
  
  return `${type}: ${name} - ${context.trim()}`;
}

/**
 * 提取并存储实体间关系
 */
async function extractAndStoreRelations(
  entities: Array<{ id: string; name: string; type: string }>,
  content: string,
  sessionId: string,
  pool: Pool,
  config: MessageUpdatedHandlerConfig
): Promise<void> {
  for (let i = 0; i < entities.length; i++) {
    const source = entities[i];
    let relationsCreated = 0;
    
    for (let j = 0; j < entities.length && relationsCreated < config.maxRelationsPerEntity; j++) {
      if (i === j) continue;
      
      const target = entities[j];
      const proximity = checkEntityProximity(source.name, target.name, content);
      
      if (proximity.score > 0.3) {
        const confidence = proximity.score * (0.5 + Math.random() * 0.5);
        
        if (confidence < config.minConfidence) {
          continue;
        }
        
        const relationType = inferRelationType(source.type, target.type, content);
        
        const existingResult = await pool.query(`
          SELECT id FROM relations 
          WHERE source_entity_id = $1 AND target_entity_id = $2
        `, [source.id, target.id]);
        
        if (existingResult.rows.length === 0) {
          await pool.query(`
            INSERT INTO relations (
              source_entity_id, target_entity_id, relation_type,
              confidence, description, session_id
            ) VALUES ($1, $2, $3, $4, $5, $6)
          `, [
            source.id,
            target.id,
            relationType,
            confidence,
            `${source.name} ${relationType} ${target.name}`,
            sessionId
          ]);
          
          relationsCreated++;
          logger.info(`Created relation: ${source.name} ${relationType} ${target.name}`);
        }
      }
    }
  }
}

/**
 * 检查两个实体在文本中的接近程度
 */
function checkEntityProximity(
  name1: string, 
  name2: string, 
  content: string
): { score: number } {
  const index1 = content.indexOf(name1);
  const index2 = content.indexOf(name2);
  
  if (index1 === -1 || index2 === -1) {
    return { score: 0 };
  }
  
  const distance = Math.abs(index1 - index2);
  const maxDistance = 500;
  
  const score = Math.max(0, 1 - distance / maxDistance);
  return { score };
}

/**
 * 推断关系类型
 */
function inferRelationType(
  sourceType: string, 
  targetType: string,
  content: string
): string {
  if (sourceType === 'class' && targetType === 'class') {
    return content.includes('extends') ? 'belongs_to' : 'references';
  }
  
  if (sourceType === 'function' && targetType === 'function') {
    return 'depends_on';
  }
  
  if (sourceType === 'module' || targetType === 'module') {
    return 'uses';
  }
  
  return 'references';
}