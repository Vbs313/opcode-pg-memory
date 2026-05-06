import { Pool } from 'pg';
import { 
  ToolExecuteBeforeInput, 
  ToolExecuteBeforeOutput,
  ToolExecuteAfterInput,
  ToolExecuteAfterOutput 
} from '../types';
import { stripPrivateContent } from '../services/privacy';
import { createLogger } from '../services/logger';

const logger = createLogger('tool-execute');

export interface ToolExecuteHandlerConfig {
  maxInputSummaryLength: number;
  maxOutputSummaryLength: number;
  defaultImportance: number;
}

const DEFAULT_CONFIG: ToolExecuteHandlerConfig = {
  maxInputSummaryLength: 500,
  maxOutputSummaryLength: 1000,
  defaultImportance: 3
};

/**
 * 处理 tool.execute.before 事件
 * 
 * 功能：
 * 1. 记录工具调用参数摘要到 observations 表
 * 2. 零 token 开销，仅做记录
 * 
 * 签名规范：(input, output) => Promise<void>
 */
export async function handleToolExecuteBefore(
  input: ToolExecuteBeforeInput,
  output: ToolExecuteBeforeOutput,    // ✅ 添加 output 参数
  pool: Pool,
  config: Partial<ToolExecuteHandlerConfig> = {}
): Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const { session, tool, messageId } = input;
  
  logger.info(`Tool execute before: ${tool.name}`);
  
  try {
    // 获取 session 内部 ID
    const sessionResult = await pool.query(
      'SELECT id FROM session_map WHERE opencode_session_id = $1',
      [session.id]
    );
    
    if (sessionResult.rows.length === 0) {
      logger.warn(`Session not found: ${session.id}`);
      return;  // ✅ 返回 void 而非 {}
    }
    
    const sessionInternalId = sessionResult.rows[0].id;
    
    // 生成输入摘要
    const inputSummary = summarizeToolInput(
      tool.parameters, 
      mergedConfig.maxInputSummaryLength
    );
    
    // 创建观察记录（此时还没有输出）
    await pool.query(`
      INSERT INTO observations (
        session_id, 
        tool_name, 
        tool_input_summary, 
        message_id, 
        importance,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      sessionInternalId,
      tool.name,
      inputSummary,
      messageId,
      mergedConfig.defaultImportance,
      JSON.stringify({ 
        event: 'tool.execute.before',
        parameters: sanitizeParameters(tool.parameters)
      })
    ]);
    
    logger.info(`Recorded tool input: ${tool.name}`);
    
    // ✅ 正确的钩子签名：不返回任何值（void）
  } catch (error) {
    logger.error('Error handling tool.execute.before:', error);
    // 出错时不阻断主流程
  }
}

/**
 * 处理 tool.execute.after 事件
 * 
 * 功能：
 * 1. 生成工具输出摘要
 * 2. 异步向量化摘要内容
 * 3. 更新 observations 表
 * 4. 记录 token 使用
 * 
 * 签名规范：(input, output) => Promise<void>
 */
export async function handleToolExecuteAfter(
  input: ToolExecuteAfterInput,
  output: ToolExecuteAfterOutput,    // ✅ 添加 output 参数
  pool: Pool,
  config: Partial<ToolExecuteHandlerConfig> = {}
): Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const { session, tool, result, messageId, executionTimeMs } = input;
  
  logger.info(`Tool execute after: ${tool.name}, success: ${result.success}`);
  
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
    
    // 生成输出摘要
    const outputSummary = summarizeToolOutput(
      result,
      mergedConfig.maxOutputSummaryLength
    );
    
    // 计算重要性（基于执行结果）
    const importance = calculateImportance(result, executionTimeMs);
    
    // 更新观察记录
    const existingResult = await pool.query(`
      SELECT id FROM observations 
      WHERE session_id = $1 AND message_id = $2 AND tool_name = $3
      ORDER BY created_at DESC
      LIMIT 1
    `, [sessionInternalId, messageId, tool.name]);
    
    if (existingResult.rows.length > 0) {
      const observationId = existingResult.rows[0].id;
      
      await pool.query(`
        UPDATE observations 
        SET tool_output_summary = $1,
            importance = $2,
            metadata = metadata || $3
        WHERE id = $4
      `, [
        outputSummary,
        importance,
        JSON.stringify({
          executionTimeMs,
          success: result.success,
          event: 'tool.execute.after'
        }),
        observationId
      ]);
      
      logger.info(`Updated observation: ${observationId}`);
    } else {
      await pool.query(`
        INSERT INTO observations (
          session_id, 
          tool_name, 
          tool_output_summary, 
          message_id, 
          importance,
          metadata
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        sessionInternalId,
        tool.name,
        outputSummary,
        messageId,
        importance,
        JSON.stringify({
          executionTimeMs,
          success: result.success,
          event: 'tool.execute.after'
        })
      ]);
      
      logger.info('Created new observation for tool output');
    }
    
    // 记录 token 使用（估算）
    const estimatedTokens = estimateToolTokens(tool.name, result);
    await pool.query(`
      INSERT INTO token_usage_log (session_id, operation_type, tokens_used, metadata)
      VALUES ($1, $2, $3, $4)
    `, [
      sessionInternalId,
      'tool_execution',
      estimatedTokens,
      JSON.stringify({
        toolName: tool.name,
        executionTimeMs,
        success: result.success
      })
    ]);
    
    // ✅ 正确的钩子签名：不返回任何值
  } catch (error) {
    logger.error('Error handling tool.execute.after:', error);
    // 出错时不阻断主流程
  }
}

/**
 * 生成工具输入摘要
 */
function summarizeToolInput(
  parameters: Record<string, any>,
  maxLength: number
): string {
  try {
    // 过滤敏感信息
    const sanitized = sanitizeParameters(parameters);
    
    // 生成摘要
    let summary = JSON.stringify(sanitized);
    
    // 移除 <private> 标记内容
    summary = stripPrivateContent(summary);
    
    if (summary.length > maxLength) {
      summary = summary.substring(0, maxLength) + '... [truncated]';
    }
    
    return summary;
  } catch {
    return '[Error summarizing input]';
  }
}

/**
 * 生成工具输出摘要
 */
function summarizeToolOutput(
  result: { success: boolean; data?: any; error?: string },
  maxLength: number
): string {
  try {
    let summary: string;
    
    if (!result.success) {
      summary = `Error: ${result.error || 'Unknown error'}`;
    } else if (result.data === undefined || result.data === null) {
      summary = 'Success (no data)';
    } else if (typeof result.data === 'string') {
      summary = result.data;
    } else {
      summary = JSON.stringify(result.data);
    }
    
    // 移除 <private> 标记内容
    summary = stripPrivateContent(summary);
    
    if (summary.length > maxLength) {
      summary = summary.substring(0, maxLength) + '... [truncated]';
    }
    
    return summary;
  } catch {
    return '[Error summarizing output]';
  }
}

/**
 * 清理参数，移除敏感信息
 */
function sanitizeParameters(parameters: Record<string, any>): Record<string, any> {
  const sensitiveKeys = ['password', 'token', 'secret', 'key', 'auth', 'credential'];
  const sanitized: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(parameters)) {
    const isSensitive = sensitiveKeys.some(sk => 
      key.toLowerCase().includes(sk.toLowerCase())
    );
    
    if (isSensitive) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeParameters(value);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

/**
 * 计算观察的重要性
 */
function calculateImportance(
  result: { success: boolean; error?: string },
  executionTimeMs: number
): number {
  let importance = 3; // 默认中等重要性
  
  // 失败的操作通常更重要
  if (!result.success) {
    importance += 1;
  }
  
  // 执行时间长的操作可能更复杂
  if (executionTimeMs > 5000) {
    importance += 1;
  }
  
  // 限制在 1-5 范围内
  return Math.max(1, Math.min(5, importance));
}

/**
 * 估算工具执行使用的 token 数
 */
function estimateToolTokens(
  toolName: string,
  result: { success: boolean; data?: any }
): number {
  // 基础 token 开销
  let tokens = 50;
  
  // 根据结果数据大小估算
  if (result.data) {
    const dataStr = typeof result.data === 'string' 
      ? result.data 
      : JSON.stringify(result.data);
    tokens += Math.ceil(dataStr.length / 4);
  }
  
  return tokens;
}