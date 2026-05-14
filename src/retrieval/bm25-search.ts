import { Pool } from "pg";
import { createLogger } from "../services/logger";
import { InternalFact } from "../types";

const logger = createLogger("bm25-search");
const PER_STRATEGY_LIMIT = 20;

/**
 * BM25 / trigram text search using PostgreSQL pg_trgm similarity() operator.
 * Matches entities by name and description similarity.
 */
export async function bm25Search(
  query: string,
  sessionIds: string[],
  pool: Pool,
  filters: { sql: string; params: any[] },
): Promise<InternalFact[]> {
  const queryTerms = query.split(/\s+/).filter((t) => t.length > 2);
  if (queryTerms.length === 0) return [];

  const facts: InternalFact[] = [];

  try {
    const entityQuery = `
      SELECT e.id, e.name, e.type, e.tier, e.weight, e.description,
             similarity(e.name, $1) as bm25_score,
             e.first_seen_at as created_at, e.confidence,
             e.session_id, e.session_map_id, e.topic_segment_id
      FROM entities e
      WHERE (e.session_map_id = ANY($2::uuid[]) OR e.session_id = ANY($2::uuid[]) OR e.tier = 'permanent')
        AND (e.name % $1 OR e.description % $1)
        ${filters.sql}
      ORDER BY similarity(e.name, $1) DESC
      LIMIT ${PER_STRATEGY_LIMIT}
    `;
    const entityResult = await pool.query(entityQuery, [
      query,
      sessionIds,
      ...filters.params,
    ]);
    facts.push(
      ...entityResult.rows.map((row) => ({
        id: row.id,
        type: "entity" as const,
        content: `[${(row.type || "").toUpperCase()}] ${row.name}: ${row.description || ""}`,
        relevanceScore: row.bm25_score ?? 0,
        tokens: 0,
        metadata: {
          entityType: row.type,
          weight: row.weight,
          confidence: row.confidence,
          createdAt: row.created_at,
          tier: row.tier,
          source: "bm25",
        },
        _sessionId: row.session_map_id || row.session_id,
        _topicSegmentId: row.topic_segment_id,
        _timestamp: row.created_at,
      })),
    );
  } catch (err) {
    logger.warn("BM25 search failed (pg_trgm may not be installed):", err);
  }

  return facts;
}
