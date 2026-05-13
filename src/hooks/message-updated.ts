import { Pool } from "pg";
import { MessageUpdatedInput, MessageUpdatedOutput } from "../types";
import { estimateTokens } from "../utils/token-budget";
import { stripPrivateContent } from "../services/privacy";
import { createLogger } from "../services/logger";
import { getConfig } from "../config";
import { addObservation } from "../services/short-term-memory";
import { detectAgentId } from "../services/agent-context";
import {
  storeEntitiesAndRelations,
  type EntitySeed,
  type RelationSeed,
} from "../services/entity-store";

// ── 用户消息噪声过滤 ─────────────────────────────────────
// 常见问候语和噪音模式，不存入 PG 也不注入短时记忆
const NOISE_PATTERNS = [
  /^hi$/i,
  /^hello$/i,
  /^hey$/i,
  /^ok$/i,
  /^okay$/i,
  /^thanks$/i,
  /^thank you$/i,
  /^thx$/i,
  /^ty$/i,
  /^yep$/i,
  /^yes$/i,
  /^no$/i,
  /^nope$/i,
  /^sure$/i,
  /^got it$/i,
  /^understood$/i,
  /^\.$/,
  /^\.\.\.$/,
  /^好的$/i,
  /^嗯$/i,
  /^知道$/i,
  /^明白了$/i,
  /^继续$/i,
  /^好$/i,
  /^行$/i,
  /^可以$/i,
];

/**
 * 评估用户消息的价值 (1-5)。
 * 高价值消息保留更久，低价值更快被 cleanup 删除。
 */
function calculateMessageImportance(content: string): number {
  const trimmed = content.trim();
  let score = 2; // 基准: 普通对话

  // 长消息 → 更有价值
  if (trimmed.length > 200) score += 1;
  if (trimmed.length > 500) score += 1;

  // 包含代码/配置 → 高价值
  if (
    /[{};=]|=>|->|\bfunction\b|\bconst\b|\blet\b|\bvar\b|\bdef\b|\bimport\b/.test(
      trimmed,
    )
  )
    score += 1;
  // 包含路径/命令 → 高价值
  if (/\/[\w-]+\/[\w.-]+|`[\w\s/-]+`/.test(trimmed)) score += 1;
  // 包含数字参数/配置值 → 高价值
  if (/\b\d{3,}\b|=\d+|port|host|key|token|password|url/i.test(trimmed))
    score += 1;
  // 包含技术术语 → 高价值
  if (
    /error|bug|fix|config|deploy|migrate|refactor|optimize|benchmark/i.test(
      trimmed,
    )
  )
    score += 1;
  // 包含明确的问题 → 中等价值
  if (
    /[？?]|why|how|what|when|where|哪个|为什么|怎么|是否/.test(trimmed) &&
    trimmed.length > 20
  )
    score += 1;
  // 包含决策/结论 → 高价值
  if (/决定|确认|同意|就用|采用|原因|因为|所以|因此|结论|方案/.test(trimmed))
    score += 1;

  return Math.max(1, Math.min(5, score));
}

function isNoise(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 5) return true; // 过短（修复前阈值是 5）
  if (trimmed.length > 2000) return false; // 长消息不可能是噪音
  if (NOISE_PATTERNS.some((p) => p.test(trimmed))) return true;
  // 纯标点符号或表情
  if (/^[\p{P}\p{S}\s]+$/u.test(trimmed)) return true;
  // 连续重复字符（如 "啊啊啊啊啊"、"......"）
  if (/^(.)\1{4,}$/.test(trimmed)) return true;
  return false;
}

const logger = createLogger("message-updated");

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
  maxRelationsPerEntity: 5,
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
  output: MessageUpdatedOutput, // ✅ 添加 output 参数
  pool: Pool,
  config: Partial<MessageUpdatedHandlerConfig> = {},
): Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const { session, message } = input;

  logger.info(`Message updated: ${message.id}, role: ${message.role}`);

  try {
    // storeMessage disabled: messages table removed in v2.3.2
    // Raw messages stored only in OpenCode SQLite

    // 2. 获取 session 内部 ID
    const sessionResult = await pool.query(
      "SELECT id FROM session_map WHERE opencode_session_id = $1",
      [session.id],
    );

    if (sessionResult.rows.length === 0) {
      logger.warn(`Session not found: ${session.id}`);
      return; // ✅ 返回 void
    }

    const sessionInternalId = sessionResult.rows[0].id;

    // 3. 存储用户消息到 PG（工具调用由 tool-execute 处理）
    if (message.role === "user" && message.content) {
      const content = message.content.trim();
      if (content.length > 5 && !isNoise(content)) {
        const importance = calculateMessageImportance(content);
        const truncated = content.substring(0, 1000);
        await pool.query(
          `INSERT INTO observations
           (session_map_id, tool_name, tool_input_summary, importance, metadata, platform_source, agent_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            sessionInternalId,
            "user_message",
            truncated,
            importance,
            JSON.stringify({ event: "message.updated", role: "user" }),
            getConfig().platform || "opencode",
            detectAgentId(),
          ],
        );

        // 同时写入短时记忆（下次 LLM 调用即可零延迟注入）
        addObservation(session.id, {
          id: `msg-${Date.now()}`,
          toolName: "user_message",
          summary: truncated.substring(0, 200),
          importance,
          timestamp: new Date(),
        });

        if (importance >= 4) {
          logger.info(`High-value message stored (importance=${importance})`);
        }
      } else if (content.length <= 5) {
        logger.debug(`Skipped short message (${content.length} chars)`);
      } else {
        logger.debug(`Skipped noise message: "${content.substring(0, 30)}"`);
      }
    }

    // 4. 提取实体（异步，不阻塞主流程）
    extractEntitiesAndRelations(
      sessionInternalId,
      message.content ?? "",
      session.id,
      pool,
      mergedConfig,
    ).catch((err) => logger.warn("Failed to extract entities:", err.message));

    // ✅ 正确的钩子签名：不返回任何值
  } catch (error) {
    logger.error("Error handling message.updated:", error);
    // 出错时不阻断主流程
  }
}

/**
 * storeMessage disabled: messages table removed in v2.3.2
 * Raw messages stored only in OpenCode SQLite
 */ /*
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
 * 从消息内容中提取实体并存入知识图谱。
 * 提取逻辑使用启发式规则，存储层复用 entity-store.ts。
 */
async function extractEntitiesAndRelations(
  sessionMapId: string,
  content: string,
  _externalSessionId: string,
  pool: Pool,
  config: MessageUpdatedHandlerConfig,
): Promise<void> {
  try {
    const sanitizedContent = stripPrivateContent(content);
    const extractedNames = heuristicEntityExtraction(sanitizedContent);

    const seeds: EntitySeed[] = [];
    for (const extracted of extractedNames.slice(
      0,
      config.maxEntitiesPerMessage,
    )) {
      if (extracted.name.length < config.minEntityNameLength) continue;
      seeds.push({
        name: extracted.name,
        type: extracted.type as EntitySeed["type"],
      });
    }

    if (seeds.length === 0) return;

    const relations: RelationSeed[] = [];
    // 实体两两之间建立 REFERENCES 关系（同一消息中同时出现）
    for (let i = 0; i < seeds.length; i++) {
      for (let j = i + 1; j < seeds.length; j++) {
        relations.push({
          sourceName: seeds[i].name,
          sourceType: seeds[i].type,
          targetName: seeds[j].name,
          targetType: seeds[j].type,
          relationType: "references",
        });
      }
    }

    await storeEntitiesAndRelations(
      { entities: seeds, relations },
      sessionMapId,
      pool,
    );
  } catch (err) {
    logger.warn("Entity extraction from message failed:", err);
  }
}

/**
 * 从消息文本中启发式提取实体（纯正则，零 LLM）
 */
function heuristicEntityExtraction(
  content: string,
): Array<{ name: string; type: string }> {
  const entities: Array<{ name: string; type: string }> = [];

  const patterns = [
    { regex: /function\s+(\w+)\s*\(/g, type: "function" },
    {
      regex: /(?:const|let|var)\s+(\w+)\s*=\s*(?:function|=>)/g,
      type: "function",
    },
    { regex: /class\s+(\w+)/g, type: "class" },
    { regex: /(?:const|let|var)\s+([A-Z_][A-Z0-9_]*)\s*=/g, type: "constant" },
    { regex: /['"]([\w\-./]+\.(?:ts|js|tsx|jsx|json|md))['"]/g, type: "file" },
    { regex: /from\s+['"]([@\w\-/.]+)['"]/g, type: "module" },
    { regex: /(?:TODO|FIXME|NOTE|HACK):?\s*(.+?)(?:\n|$)/gi, type: "task" },
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.regex.exec(content)) !== null) {
      const name = match[1].trim();
      if (name.length >= 2 && !entities.some((e) => e.name === name)) {
        entities.push({ name, type: pattern.type });
      }
    }
  }

  return entities;
}
