import { Pool } from 'pg';
import { MessagePartUpdatedInput, MessagePartUpdatedOutput } from '../types';
import { createLogger } from '../services/logger';

const logger = createLogger('message-part-updated');

export interface MessagePartUpdatedHandlerConfig {
  maxContentLength: number;
  accumulationTimeoutMs: number;
}

const DEFAULT_CONFIG: MessagePartUpdatedHandlerConfig = {
  maxContentLength: 10000,
  accumulationTimeoutMs: 5000
};

// 内存中的部分消息累积器
// 注意：生产环境应使用 Redis 等外部存储
const partAccumulators = new Map<string, {
  contents: string[];
  lastUpdate: number;
  sessionId: string;
  messageId: string;
}>();

/**
 * 处理 message.part.updated 事件
 * 
 * 功能：
 * 1. 监听工具输出的增量更新
 * 2. 触发经验增量记录
 * 3. 累积部分内容，在 isComplete = true 时统一处理
 * 
 * 签名规范：(input, output) => Promise<void>
 */
export async function handleMessagePartUpdated(
  input: MessagePartUpdatedInput,
  output: MessagePartUpdatedOutput,    // ✅ 添加 output 参数
  pool: Pool,
  config: Partial<MessagePartUpdatedHandlerConfig> = {}
): Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const { session, message } = input;
  
  logger.info(`Message part updated: ${message.id}, partIndex: ${message.partIndex}, isComplete: ${message.isComplete}`);
  
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
    const accumulatorKey = `${sessionInternalId}:${message.id}`;
    
    // 获取或创建累积器
    let accumulator = partAccumulators.get(accumulatorKey);
    if (!accumulator) {
      accumulator = {
        contents: [],
        lastUpdate: Date.now(),
        sessionId: sessionInternalId,
        messageId: message.id
      };
      partAccumulators.set(accumulatorKey, accumulator);
    }
    
    // 累积内容
    accumulator.contents.push(message.content);
    accumulator.lastUpdate = Date.now();
    
    // 如果内容完成，处理累积的内容
    if (message.isComplete) {
      await processCompletedParts(accumulatorKey, pool);
    } else {
      // 设置超时处理（防止部分消息丢失）
      scheduleAccumulationTimeout(accumulatorKey, pool, mergedConfig.accumulationTimeoutMs);
    }
    
    // ✅ 正确的钩子签名：不返回任何值
  } catch (error) {
    logger.error('Error handling message.part.updated:', error);
    // 出错时不阻断主流程
  }
}

/**
 * 处理完成的部分消息
 */
async function processCompletedParts(
  accumulatorKey: string,
  pool: Pool
): Promise<void> {
  const accumulator = partAccumulators.get(accumulatorKey);
  if (!accumulator) {
    return;
  }
  
  // 合并所有部分内容
  const fullContent = accumulator.contents.join('');
  
  // 清理累积器
  partAccumulators.delete(accumulatorKey);
  
  if (fullContent.length === 0) {
    return;
  }
  
  logger.info(`Processing completed parts for message: ${accumulator.messageId}`);
  
  // 生成摘要
  const summary = generatePartSummary(fullContent);
  
  // 存储为观察记录
  await pool.query(`
    INSERT INTO observations (
      session_map_id,
      tool_output_summary,
      message_id,
      importance,
      metadata
    ) VALUES ($1, $2, $3, $4, $5)
  `, [
    accumulator.sessionId,
    summary,
    accumulator.messageId,
    calculatePartImportance(fullContent),
    JSON.stringify({
      source: 'message.part.updated',
      isAccumulated: true,
      partCount: accumulator.contents.length,
      contentLength: fullContent.length
    })
  ]);
  
  logger.info(`Stored accumulated observation for message: ${accumulator.messageId}`);
}

/**
 * 设置累积超时处理
 */
function scheduleAccumulationTimeout(
  accumulatorKey: string,
  pool: Pool,
  timeoutMs: number
): void {
  setTimeout(async () => {
    const accumulator = partAccumulators.get(accumulatorKey);
    if (!accumulator) {
      return;
    }
    
    // 检查是否超时（可能已经被完成处理）
    const timeSinceLastUpdate = Date.now() - accumulator.lastUpdate;
    if (timeSinceLastUpdate >= timeoutMs * 0.8) {
      // 超时，强制处理
      logger.info(`Accumulation timeout for message: ${accumulator.messageId}`);
      await processCompletedParts(accumulatorKey, pool);
    }
  }, timeoutMs);
}

/**
 * 生成部分内容摘要
 */
function generatePartSummary(content: string): string {
  const maxLength = 1000;
  
  // 提取关键信息
  const lines = content.split('\n');
  const keyLines: string[] = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // 关注错误、警告、成功等关键信息
    if (
      trimmed.toLowerCase().includes('error') ||
      trimmed.toLowerCase().includes('warning') ||
      trimmed.toLowerCase().includes('success') ||
      trimmed.toLowerCase().includes('completed') ||
      trimmed.toLowerCase().includes('failed') ||
      trimmed.startsWith('>') ||
      trimmed.startsWith('$')
    ) {
      keyLines.push(trimmed);
    }
    
    if (keyLines.length >= 10) {
      break;
    }
  }
  
  let summary = keyLines.join('\n');
  
  // 如果关键行太少，添加内容开头
  if (summary.length < 200) {
    summary = content.substring(0, maxLength);
  }
  
  if (summary.length > maxLength) {
    summary = summary.substring(0, maxLength) + '... [truncated]';
  }
  
  return summary;
}

/**
 * 计算部分内容的重要性
 */
function calculatePartImportance(content: string): number {
  let importance = 3; // 默认中等
  
  const lowerContent = content.toLowerCase();
  
  // 包含错误信息
  if (lowerContent.includes('error') || lowerContent.includes('exception')) {
    importance += 1;
  }
  
  // 包含警告信息
  if (lowerContent.includes('warning') || lowerContent.includes('warn')) {
    importance += 0.5;
  }
  
  // 包含成功信息
  if (lowerContent.includes('success') || lowerContent.includes('completed')) {
    importance += 0.5;
  }
  
  // 内容较长可能更复杂
  if (content.length > 5000) {
    importance += 0.5;
  }
  
  return Math.min(5, importance);
}

/**
 * 清理过期的累积器（防止内存泄漏）
 * 应定期调用
 */
export function cleanupExpiredAccumulators(maxAgeMs: number = 300000): void {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [key, accumulator] of partAccumulators.entries()) {
    if (now - accumulator.lastUpdate > maxAgeMs) {
      partAccumulators.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    logger.info(`Cleaned up ${cleaned} expired accumulators`);
  }
}

// 每 5 分钟清理一次过期累积器
setInterval(() => cleanupExpiredAccumulators(), 300000);