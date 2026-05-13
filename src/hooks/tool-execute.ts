import crypto from "node:crypto";
import { Pool } from "pg";
import {
  ToolExecuteBeforeInput,
  ToolExecuteBeforeOutput,
  ToolExecuteAfterInput,
  ToolExecuteAfterOutput,
} from "../types";
import { stripPrivateContent } from "../services/privacy";
import { createLogger } from "../services/logger";
import { getAsyncEmbedder } from "../services/async-embedder";
import { detectAgentId } from "../services/agent-context";
import { getConfig } from "../config";
import { enqueueObservation } from "../services/memory-buffer";
import { addObservation } from "../services/short-term-memory";
import { extractEntities } from "../services/entity-extractor";
import { storeEntitiesAndRelations } from "../services/entity-store";

const logger = createLogger("tool-execute");

// ============================================================
// Session ID 缓存 — 避免每次工具调用重复查询 session_map
// ============================================================

const sessionIdCache = new Map<string, { internalId: string; ts: number }>();
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

async function resolveSessionInternalId(
  sessionId: string,
  pool: Pool,
): Promise<string | null> {
  const cached = sessionIdCache.get(sessionId);
  if (cached && Date.now() - cached.ts < SESSION_CACHE_TTL_MS) {
    return cached.internalId;
  }

  const result = await pool.query(
    "SELECT id FROM session_map WHERE opencode_session_id = $1",
    [sessionId],
  );

  if (result.rows.length === 0) return null;

  const internalId = result.rows[0].id as string;
  sessionIdCache.set(sessionId, { internalId, ts: Date.now() });
  return internalId;
}

/** 清除 session 缓存（session 删除/完成时调用） */
export function clearSessionCache(sessionId: string): void {
  sessionIdCache.delete(sessionId);
}

export interface ToolExecuteHandlerConfig {
  maxInputSummaryLength: number;
  maxOutputSummaryLength: number;
  defaultImportance: number;
}

const DEFAULT_CONFIG: ToolExecuteHandlerConfig = {
  maxInputSummaryLength: 500,
  maxOutputSummaryLength: 1000,
  defaultImportance: 3,
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
  output: ToolExecuteBeforeOutput, // ✅ 添加 output 参数
  pool: Pool,
  config: Partial<ToolExecuteHandlerConfig> = {},
): Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const { session, tool, messageId } = input;

  logger.info(`Tool execute before: ${tool.name}`);

  try {
    // 获取 session 内部 ID（带缓存）
    const sessionInternalId = await resolveSessionInternalId(session.id, pool);
    if (!sessionInternalId) {
      logger.warn(`Session not found: ${session.id}`);
      return;
    }

    // 生成输入摘要
    const inputSummary = summarizeToolInput(
      tool.parameters,
      mergedConfig.maxInputSummaryLength,
    );

    // 创建观察记录（此时还没有输出）
    await pool.query(
      `
      INSERT INTO observations (
        session_map_id, 
        tool_name, 
        tool_input_summary, 
        message_id, 
        importance,
        metadata,
        tool_call_id,
        message_external_id,
        tool_status,
        tool_parameters,
        platform_source,
        agent_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `,
      [
        sessionInternalId,
        tool.name,
        inputSummary,
        messageId,
        mergedConfig.defaultImportance,
        JSON.stringify({
          event: "tool.execute.before",
          parameters: sanitizeParameters(tool.parameters),
        }),
        messageId,
        messageId,
        "pending",
        JSON.stringify(sanitizeParameters(tool.parameters)),
        getConfig().platform || "opencode",
        detectAgentId(),
      ],
    );

    logger.info(`Recorded tool input: ${tool.name}`);
  } catch (error) {
    logger.error("Error handling tool.execute.after:", error);
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
  output: ToolExecuteAfterOutput, // ✅ 添加 output 参数
  pool: Pool,
  config: Partial<ToolExecuteHandlerConfig> = {},
): Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const { session, tool, result, messageId, executionTimeMs } = input;

  logger.info(`Tool execute after: ${tool.name}, success: ${result.success}`);

  // Buffer vars: must be declared before the try block for catch to reference
  let sessionInternalId: string | null = null;
  let outputSummary: string | null = null;
  let importance = 3;

  try {
    // 获取 session 内部 ID（缓存查询）
    sessionInternalId = await resolveSessionInternalId(session.id, pool);
    if (!sessionInternalId) {
      logger.warn(`Session not found: ${session.id}`);
      return;
    }

    // 生成输出摘要
    outputSummary = summarizeToolOutput(
      result,
      mergedConfig.maxOutputSummaryLength,
    );

    // 计算重要性（基于执行结果）
    importance = calculateImportance(result, executionTimeMs);

    // 更新观察记录
    const existingResult = await pool.query(
      `
      SELECT id FROM observations 
      WHERE session_map_id = $1 AND message_id = $2 AND tool_name = $3
      ORDER BY created_at DESC
      LIMIT 1
    `,
      [sessionInternalId, messageId, tool.name],
    );

    let observationId: any;

    if (existingResult.rows.length > 0) {
      observationId = existingResult.rows[0].id;

      await pool.query(
        `
        UPDATE observations 
        SET tool_output_summary = $1,
            importance = $2,
            metadata = metadata || $3,
            tool_status = $4,
            tool_parameters = $5,
            tool_error = $6
        WHERE id = $7
      `,
        [
          outputSummary,
          importance,
          JSON.stringify({
            executionTimeMs,
            success: result.success,
            event: "tool.execute.after",
          }),
          result.success ? "completed" : "failed",
          JSON.stringify(sanitizeParameters(tool.parameters)),
          result.error || null,
          observationId,
        ],
      );

      logger.info(`Updated observation: ${observationId}`);
    } else {
      const insertResult = await pool.query(
        `
        INSERT INTO observations (
          session_map_id, 
          tool_name, 
          tool_output_summary, 
          message_id, 
          importance,
          metadata,
          tool_call_id,
          message_external_id,
          tool_status,
          tool_parameters,
          tool_error,
          platform_source,
          agent_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id
      `,
        [
          sessionInternalId,
          tool.name,
          outputSummary,
          messageId,
          importance,
          JSON.stringify({
            executionTimeMs,
            success: result.success,
            event: "tool.execute.after",
          }),
          messageId,
          messageId,
          result.success ? "completed" : "failed",
          JSON.stringify(sanitizeParameters(tool.parameters)),
          result.error || null,
          getConfig().platform || "opencode",
          detectAgentId(),
        ],
      );

      observationId = insertResult.rows[0].id;
      logger.info("Created new observation for tool output");
    }

    // ── Causal chain detection: failure→fix pattern ──
    // If this tool call succeeded, check if the same tool failed recently
    if (result.success && observationId && sessionInternalId) {
      try {
        // Find the most recent failed observation with same tool, within 5 min
        const { rows: priorFails } = await pool.query(
          `SELECT id, created_at FROM observations
           WHERE session_map_id = $1
             AND tool_name = $2
             AND tool_status = 'failed'
             AND causal_chain_id IS NULL
             AND created_at > NOW() - INTERVAL '5 minutes'
           ORDER BY created_at DESC
           LIMIT 1`,
          [sessionInternalId, tool.name],
        );
        if (priorFails.length > 0) {
          const chainId = crypto.randomUUID();
          // Mark the failed observation as cause
          await pool.query(
            `UPDATE observations SET causal_chain_id = $1, causal_role = 'cause'
             WHERE id = $2`,
            [chainId, priorFails[0].id],
          );
          // Mark this success as fix
          await pool.query(
            `UPDATE observations SET causal_chain_id = $1, causal_role = 'fix'
             WHERE id = $2`,
            [chainId, observationId],
          );
          logger.info(
            `Causal chain detected: ${tool.name} fail→fix (${chainId.substring(0, 8)})`,
          );
        }
      } catch {
        // Non-fatal: chain detection failure
      }
    }

    // ── Entity extraction: populate knowledge graph from tool outputs ──
    if (sessionInternalId && result.data && tool.name) {
      try {
        const { entities, relations } = extractEntities(
          tool.name,
          tool.parameters ?? {},
          String(result.data),
        );
        if (entities.length > 0) {
          // Fire-and-forget: never block the tool execution flow
          storeEntitiesAndRelations(
            { entities, relations },
            sessionInternalId,
            pool,
          ).catch((err: Error) =>
            logger.warn("Entity store failed:", err.message),
          );
        }
      } catch {
        // Non-fatal: extraction failure
      }
    }

    // Add to short-term memory (zero-latency for next LLM call)
    if (sessionInternalId) {
      const summaryText = `[${tool.name}] ${outputSummary || ""}`;
      addObservation(session.id, {
        id: observationId ?? `st-${Date.now()}`,
        toolName: tool.name,
        summary: summaryText.substring(0, 200),
        importance,
        timestamp: new Date(),
      });
    }

    // Enqueue async embedding (non-blocking)
    if (observationId != null) {
      const embedder = getAsyncEmbedder();
      if (embedder) {
        const inputSummary = summarizeToolInput(
          tool.parameters,
          mergedConfig.maxInputSummaryLength,
        );
        const summaryText = `[${tool.name}] ${outputSummary || inputSummary || ""}`;
        embedder.enqueue(
          "observations",
          String(observationId),
          summaryText,
          importance,
        );
      }
    }

    // 记录 token 使用（估算）
    const estimatedTokens = estimateToolTokens(tool.name, result);
    await pool.query(
      `
      INSERT INTO token_usage_log (session_map_id, operation_type, tokens_used, metadata)
      VALUES ($1, $2, $3, $4)
    `,
      [
        sessionInternalId,
        "tool_execution",
        estimatedTokens,
        JSON.stringify({
          toolName: tool.name,
          executionTimeMs,
          success: result.success,
        }),
      ],
    );
  } catch (error) {
    logger.warn("PG unavailable — enqueuing observation in memory", error);
    try {
      enqueueObservation({
        sessionMapId: sessionInternalId ?? "unknown",
        toolName: tool.name,
        toolInputSummary: null,
        toolOutputSummary: outputSummary,
        importance,
        metadata: {
          event: "tool.execute.after",
          executionTimeMs,
          success: result.success,
          platform_source: getConfig().platform || "opencode",
          agent_id: detectAgentId(),
        },
        platformSource: getConfig().platform || "opencode",
        agentId: detectAgentId(),
      });
    } catch {
      /* buffer also failed — log already emitted */
    }
  }
}

/**
 * 生成工具输入摘要
 */
function summarizeToolInput(
  parameters: Record<string, any>,
  maxLength: number,
): string {
  try {
    // 过滤敏感信息
    const sanitized = sanitizeParameters(parameters);

    // 生成摘要
    let summary = JSON.stringify(sanitized);

    // 移除 <private> 标记内容
    summary = stripPrivateContent(summary);

    if (summary.length > maxLength) {
      summary = summary.substring(0, maxLength) + "... [truncated]";
    }

    return summary;
  } catch {
    return "[Error summarizing input]";
  }
}

/**
 * 生成工具输出摘要
 */
function summarizeToolOutput(
  result: { success: boolean; data?: any; error?: string },
  maxLength: number,
): string {
  try {
    let summary: string;

    if (!result.success) {
      summary = `Error: ${result.error || "Unknown error"}`;
    } else if (result.data === undefined || result.data === null) {
      summary = "Success (no data)";
    } else if (typeof result.data === "string") {
      summary = result.data;
    } else {
      summary = JSON.stringify(result.data);
    }

    // 移除 <private> 标记内容
    summary = stripPrivateContent(summary);

    if (summary.length > maxLength) {
      summary = summary.substring(0, maxLength) + "... [truncated]";
    }

    return summary;
  } catch {
    return "[Error summarizing output]";
  }
}

/**
 * 清理参数，移除敏感信息
 */
function sanitizeParameters(
  parameters: Record<string, any>,
): Record<string, any> {
  const sensitiveKeys = [
    "password",
    "token",
    "secret",
    "key",
    "auth",
    "credential",
  ];
  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(parameters)) {
    const isSensitive = sensitiveKeys.some((sk) =>
      key.toLowerCase().includes(sk.toLowerCase()),
    );

    if (isSensitive) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
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
  executionTimeMs: number,
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
  result: { success: boolean; data?: any },
): number {
  // 基础 token 开销
  let tokens = 50;

  // 根据结果数据大小估算
  if (result.data) {
    const dataStr =
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data);
    tokens += Math.ceil(dataStr.length / 4);
  }

  return tokens;
}
