import { Pool } from "pg";
import { createLogger } from "../services/logger";
import { InternalFact } from "../types";

const logger = createLogger("graph-traversal");
const PER_STRATEGY_LIMIT = 20;

/** Fallback embedding for non-vector strategies (simple keyword affinity) */
export function embeddingServiceFallback(_query: string): number[] {
  return [];
}

/**
 * Graph traversal: find seed entities matching query text, then traverse
 * 1-hop relations to discover connected entities.
 */
export async function graphTraversal(
  query: string,
  _queryEmb: number[],
  sessionIds: string[],
  pool: Pool,
  filters: { sql: string; params: any[] },
): Promise<InternalFact[]> {
  // 1. Find seed entities matching query text
  let seedQuery: string;
  let seedParams: any[];

  try {
    seedQuery = `
      SELECT id, name, type
      FROM entities
      WHERE (session_map_id = ANY($1::uuid[]) OR session_id = ANY($1::uuid[]) OR tier = 'permanent')
        AND (name ILIKE $2 OR description ILIKE $2)
      LIMIT 5
    `;
    seedParams = [sessionIds, `%${query}%`];
  } catch {
    return [];
  }

  const seedResult = await pool.query(seedQuery, seedParams);
  if (seedResult.rows.length === 0) return [];

  const seedIds = seedResult.rows.map((row) => row.id);

  // 2. Traverse relations (1-hop neighbors)
  const graphQuery = `
    SELECT
      e2.id, e2.name, e2.type, e2.tier, e2.weight, e2.description,
      e2.first_seen_at as created_at, e2.confidence,
      r.relation_type,
      e_seed.name as related_entity_name,
      e2.session_id, e2.session_map_id, e2.topic_segment_id
    FROM entities e_seed
    JOIN relations r ON e_seed.id = r.source_entity_id
    JOIN entities e2 ON r.target_entity_id = e2.id
    WHERE e_seed.id = ANY($1)
      AND r.confidence >= $2
      AND e_seed.id != e2.id
    ORDER BY r.confidence DESC
    LIMIT ${PER_STRATEGY_LIMIT}
  `;

  try {
    const graphResult = await pool.query(graphQuery, [seedIds, 0.5]);
    return graphResult.rows.map((row) => ({
      id: row.id,
      type: "entity" as const,
      content: `[${(row.type || "").toUpperCase()}] ${row.name}: ${row.description || ""} (related to ${row.related_entity_name} via ${row.relation_type})`,
      relevanceScore: (row.confidence ?? 0) * 0.8,
      tokens: 0,
      metadata: {
        entityType: row.type,
        weight: row.weight,
        confidence: row.confidence,
        createdAt: row.created_at,
        tier: row.tier,
        relationType: row.relation_type,
        relatedEntity: row.related_entity_name,
        source: "graph",
      },
      _sessionId: row.session_map_id || row.session_id,
      _topicSegmentId: row.topic_segment_id,
      _timestamp: row.created_at,
    }));
  } catch (err) {
    logger.warn("Graph traversal error:", err);
    return [];
  }
}
