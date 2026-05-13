/**
 * review-rules.ts — MCP 工具
 *
 * 列出所有已应用的规则及其有效性和状态。
 * 支持按 pattern_type 过滤，按 applied_at 排序。
 */

import { Pool } from "pg";
import { createLogger } from "../services/logger";

const logger = createLogger("review-rules");

export interface ReviewRulesInput {
  pattern_type?: string;
  include_archived?: boolean;
  limit?: number;
}

interface RuleEntry {
  id: string;
  pattern_type: string;
  summary: string;
  confidence: number;
  applied_at: string;
  session_count_since_apply?: number;
  error_count_since_apply?: number;
}

export interface ReviewRulesOutput {
  success: boolean;
  rules: RuleEntry[];
  total: number;
  error?: string;
}

export async function reviewRules(
  input: ReviewRulesInput,
  pool: Pool,
): Promise<ReviewRulesOutput> {
  try {
    let whereClause = "WHERE r.applied_at IS NOT NULL";
    const params: any[] = [];
    let paramIdx = 1;

    if (input.pattern_type) {
      whereClause += ` AND r.pattern_type = $${paramIdx++}`;
      params.push(input.pattern_type);
    }
    if (!input.include_archived) {
      whereClause += ` AND r.applied_at > NOW() - INTERVAL '90 days'`;
    }

    const limit = Math.min(input.limit ?? 50, 100);
    const { rows } = await pool.query(
      `SELECT r.id, r.pattern_type, r.summary, r.confidence,
              r.applied_at,
              r.action_plan
       FROM reflections r
       ${whereClause}
       ORDER BY r.applied_at DESC
       LIMIT $${paramIdx}`,
      [...params, limit],
    );

    const rules: RuleEntry[] = await Promise.all(
      rows.map(async (row: any) => {
        let errorCount = 0;
        let sessionCount = 0;
        // Count errors since apply
        const stats = await pool.query(
          `SELECT COUNT(*) as errors,
                  COUNT(DISTINCT session_map_id) as sessions
           FROM observations
           WHERE created_at > $1
             AND (tool_output_summary ILIKE '%error%'
               OR tool_output_summary ILIKE '%failed%')
             AND importance >= 3`,
          [row.applied_at],
        );
        if (stats.rows.length > 0) {
          errorCount = parseInt(stats.rows[0].errors, 10);
          sessionCount = parseInt(stats.rows[0].sessions, 10);
        }
        return {
          id: row.id,
          pattern_type: row.pattern_type,
          summary: row.summary,
          confidence: row.confidence,
          applied_at: row.applied_at,
          session_count_since_apply: sessionCount,
          error_count_since_apply: errorCount,
        };
      }),
    );

    return { success: true, rules, total: rules.length };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error("reviewRules failed:", msg);
    return { success: false, rules: [], total: 0, error: msg };
  }
}
