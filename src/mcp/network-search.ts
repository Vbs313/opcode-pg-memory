/**
 * network-search.ts — 联邦式认知网络检索 (v4.0 MCP 工具)
 *
 * 允许 Agent 跨项目搜索整个认知网络中的记忆和技能。
 *
 * 参考模式:
 *   - Mnemoverse: 联邦式 MCP — 跨服务工具调用 + 自动发现
 *   - hive-mcp: 层次化上下文检索 (HCR) + 项目作用域
 *   - agent-memory-mcp: scope-aware retrieval (global/project/session)
 *
 * MCP 工具:
 *   search_network(query, scope, min_reputation, limit)
 *     → 返回跨项目匹配的记忆 + 技能 + 实体，含声誉评分
 *
 * 搜索范围:
 *   - "skills": 全局技能索引 (skill_index 表)
 *   - "memories": 跨项目 observations (含 embedding 相似度)
 *   - "entities": 知识图谱实体 (含关系)
 *   - "all": 以上全部
 */

import { Pool } from "pg";
import { createLogger } from "../services/logger";
import { getEmbeddingService } from "../utils/embedding";
import {
  getTopReputationSkills,
  ReputationScore,
} from "../services/skill-reputation";

const logger = createLogger("network-search");

// ── 类型 ──────────────────────────────────────────────

export interface NetworkSearchInput {
  query: string;
  scope?: "skills" | "memories" | "entities" | "all";
  min_reputation?: number;
  max_results?: number;
  exclude_project_id?: string;
  exclude_deprecated?: boolean;
}

export interface NetworkSearchResult {
  type: "skill" | "memory" | "entity";
  id: string;
  title: string;
  content: string;
  project_id: string | null;
  relevance: number;
  reputation?: ReputationScore;
  source: string; // 来源表名
}

export interface NetworkSearchOutput {
  success: boolean;
  query: string;
  results: NetworkSearchResult[];
  total_found: number;
  search_time_ms: number;
  scope_used: string;
  error?: string;
}

// ── 技能搜索 ──────────────────────────────────────────

async function searchSkills(
  pool: Pool,
  query: string,
  fingerprintEmbedding: number[] | null,
  options: NetworkSearchInput,
): Promise<NetworkSearchResult[]> {
  try {
    const minRep = options.min_reputation || 0;
    const limit = Math.min(options.max_results || 10, 50);

    let sql: string;
    let params: any[] = [];

    if (fingerprintEmbedding) {
      const embStr = `[${fingerprintEmbedding.join(",")}]`;
      sql = `
        SELECT skill_name, version, pattern_type, trigger_tool, effectiveness,
               project_id, search_text,
               1 - (embedding <=> '${embStr}') as relevance
        FROM skill_index
        WHERE embedding IS NOT NULL
          AND effectiveness != 'deprecated'
        ORDER BY relevance DESC
        LIMIT $1
      `;
      params = [limit];
    } else {
      sql = `
        SELECT skill_name, version, pattern_type, trigger_tool, effectiveness,
               project_id, search_text,
               0.5 as relevance
        FROM skill_index
        WHERE search_text ILIKE $1
        ORDER BY indexed_at DESC
        LIMIT $2
      `;
      params = [`%${query}%`, limit];
    }

    if (options.exclude_project_id) {
      sql = sql.replace("ORDER BY", "AND project_id != $3 ORDER BY");
      params.push(options.exclude_project_id);
    }

    const { rows } = await pool.query(sql, params);

    // 附加声誉评分
    const reputationMap = new Map<string, ReputationScore>();
    for (const row of rows) {
      if (!reputationMap.has(row.skill_name)) {
        const score = await computeReputationForRow(pool, row);
        if (score) reputationMap.set(row.skill_name, score);
      }
    }

    return rows
      .filter((row: any) => {
        const rep = reputationMap.get(row.skill_name);
        return !rep || rep.reputation >= minRep;
      })
      .map((row: any) => ({
        type: "skill" as const,
        id: `skill:${row.skill_name}`,
        title: `${row.skill_name} v${row.version}`,
        content: row.search_text?.substring(0, 500) || "",
        project_id: row.project_id,
        relevance: Math.round((row.relevance || 0.5) * 100) / 100,
        reputation: reputationMap.get(row.skill_name),
        source: "skill_index",
      }));
  } catch (err) {
    logger.debug("Skill network search failed:", err);
    return [];
  }
}

async function computeReputationForRow(
  pool: Pool,
  row: any,
): Promise<ReputationScore | null> {
  try {
    const { computeReputation } = await import("../services/skill-reputation");
    return computeReputation(pool, row.skill_name);
  } catch {
    return null;
  }
}

// ── 记忆搜索 (跨项目 observations) ──────────────────

async function searchMemories(
  pool: Pool,
  query: string,
  embedding: number[] | null,
  options: NetworkSearchInput,
): Promise<NetworkSearchResult[]> {
  try {
    const limit = Math.min(options.max_results || 10, 50);

    let rows: any[];
    if (embedding) {
      const embStr = `[${embedding.join(",")}]`;
      const { rows: r } = await pool.query(
        `SELECT o.id, o.tool_name, o.tool_output_summary, o.importance,
                sm.project_id, o.created_at,
                1 - (o.embedding <=> '${embStr}') as relevance
         FROM observations o
         JOIN session_map sm ON o.session_map_id = sm.id
         WHERE o.embedding IS NOT NULL
           AND o.importance >= 3
         ORDER BY relevance DESC
         LIMIT $1`,
        [limit],
      );
      rows = r;
    } else {
      const { rows: r } = await pool.query(
        `SELECT o.id, o.tool_name, o.tool_output_summary, o.importance,
                sm.project_id, o.created_at,
                0.3 as relevance
         FROM observations o
         JOIN session_map sm ON o.session_map_id = sm.id
         WHERE o.tool_output_summary ILIKE $1
           AND o.importance >= 3
         ORDER BY o.created_at DESC
         LIMIT $2`,
        [`%${query}%`, limit],
      );
      rows = r;
    }

    return rows.map((row: any) => ({
      type: "memory" as const,
      id: `obs:${row.id}`,
      title: `[${row.tool_name || "observation"}] ${(row.tool_output_summary || "").substring(0, 100)}`,
      content: row.tool_output_summary || "",
      project_id: row.project_id,
      relevance: Math.round((row.relevance || 0.3) * 100) / 100,
      source: "observations",
    }));
  } catch (err) {
    logger.debug("Memory network search failed:", err);
    return [];
  }
}

// ── 实体搜索 (跨项目知识图谱) ────────────────────────

async function searchEntities(
  pool: Pool,
  query: string,
  options: NetworkSearchInput,
): Promise<NetworkSearchResult[]> {
  try {
    const limit = Math.min(options.max_results || 10, 50);

    const { rows } = await pool.query(
      `SELECT e.id, e.name, e.type, e.description, e.weight, e.confidence,
              sm.project_id
       FROM entities e
       JOIN session_map sm ON e.session_map_id = sm.id
       WHERE e.name ILIKE $1
         AND e.tier IN ('permanent', 'project')
       ORDER BY e.weight DESC
       LIMIT $2`,
      [`%${query}%`, limit],
    );

    return rows.map((row: any) => ({
      type: "entity" as const,
      id: `entity:${row.id}`,
      title: `${row.name} (${row.type})`,
      content: row.description || row.name,
      project_id: row.project_id,
      relevance: Math.min(row.weight / 10, 1.0),
      source: "entities",
    }));
  } catch (err) {
    logger.debug("Entity network search failed:", err);
    return [];
  }
}

// ── 主入口 ──────────────────────────────────────────

export async function searchNetwork(
  input: NetworkSearchInput,
  pool: Pool,
): Promise<NetworkSearchOutput> {
  const startTime = Date.now();
  const scope = input.scope || "all";

  try {
    // 计算 query embedding
    let embedding: number[] | null = null;
    const emb = getEmbeddingService();
    if (emb) {
      try {
        embedding = await emb.generateEmbedding(input.query);
      } catch {
        // 降级到关键词搜索
      }
    }

    // 并行搜索
    const searches: Promise<NetworkSearchResult[]>[] = [];
    if (scope === "skills" || scope === "all") {
      searches.push(searchSkills(pool, input.query, embedding, input));
    }
    if (scope === "memories" || scope === "all") {
      searches.push(searchMemories(pool, input.query, embedding, input));
    }
    if (scope === "entities" || scope === "all") {
      searches.push(searchEntities(pool, input.query, input));
    }

    const results = (await Promise.all(searches)).flat();

    // 按 relevance 降序排列
    results.sort((a, b) => b.relevance - a.relevance);

    const limit = Math.min(input.max_results || 20, 100);
    const sliced = results.slice(0, limit);

    logger.info(
      `Network search: "${input.query}" → ${sliced.length}/${results.length} results (${Date.now() - startTime}ms)`,
    );

    return {
      success: true,
      query: input.query,
      results: sliced,
      total_found: results.length,
      search_time_ms: Date.now() - startTime,
      scope_used: scope,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error("Network search failed:", msg);
    return {
      success: false,
      query: input.query,
      results: [],
      total_found: 0,
      search_time_ms: Date.now() - startTime,
      scope_used: scope,
      error: msg,
    };
  }
}
