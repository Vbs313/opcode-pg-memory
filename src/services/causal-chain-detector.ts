/**
 * causal-chain-detector.ts
 *
 * 检测 failure→fix 因果链模式：
 * 当同一工具在同一 session 内先失败后成功（5 分钟内），自动标记因果链。
 */

import crypto from "node:crypto";
import { Pool } from "pg";
import { createLogger } from "../services/logger";

const logger = createLogger("causal-chain-detector");

/**
 * 检测并标记 failure→fix 因果链。
 * 查找最近 5 分钟内同工具名的失败记录，若当前调用成功则标记为修复链。
 *
 * Fire-and-forget: 调用方应 catch 所有错误，因果链检测失败不应影响主流程。
 *
 * @returns chainId 如果检测到因果链，否则 null
 */
export async function detectCausalChain(
  pool: Pool,
  sessionInternalId: string,
  toolName: string,
  observationId: string,
  result: { success: boolean },
): Promise<string | null> {
  if (!result.success) return null;

  try {
    const { rows: priorFails } = await pool.query(
      `SELECT id, created_at FROM observations
       WHERE session_map_id = $1
         AND tool_name = $2
         AND tool_status = 'failed'
         AND causal_chain_id IS NULL
         AND created_at > NOW() - INTERVAL '5 minutes'
       ORDER BY created_at DESC
       LIMIT 1`,
      [sessionInternalId, toolName],
    );

    if (priorFails.length === 0) return null;

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
      `Causal chain detected: ${toolName} fail→fix (${chainId.substring(0, 8)})`,
    );
    return chainId;
  } catch (err) {
    logger.debug("Causal chain detection failed (non-fatal):", err);
    return null;
  }
}
