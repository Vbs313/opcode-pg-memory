import { Pool } from "pg";
import { createLogger } from "../services/logger";
import { InternalFact } from "../types";

const logger = createLogger("keyword-search");
const PER_STRATEGY_LIMIT = 20;

/**
 * Keyword search using ILIKE and regex matching.
 * Includes entity relation JOIN logic from v3.13:
 * - Batch-fetches relations for all matched entities
 * - Resolves file→symbols and symbols→file references
 */
export async function keywordSearch(
  query: string,
  sessionIds: string[],
  pool: Pool,
  filters: { sql: string; params: any[] },
): Promise<InternalFact[]> {
  const keywords = query.split(/\s+/).filter((k) => k.length > 2);
  if (keywords.length === 0) return [];

  const pattern = keywords.join("|");

  try {
    const entityQuery = `
      SELECT e.id, e.name, e.type, e.tier, e.weight, e.description,
             e.first_seen_at as created_at, e.confidence,
             e.session_id, e.session_map_id, e.topic_segment_id
      FROM entities e
      WHERE (e.session_map_id = ANY($1::uuid[]) OR e.session_id = ANY($1::uuid[]) OR e.tier = 'permanent')
        AND (e.name ~* $2 OR e.description ~* $2)
        ${filters.sql}
      LIMIT ${PER_STRATEGY_LIMIT}
    `;
    const entityResult = await pool.query(entityQuery, [
      sessionIds,
      pattern,
      ...filters.params,
    ]);

    // Batch fetch relations for all matched entities: file→symbols and symbols→file
    const entityIds = entityResult.rows.map((r: any) => r.id);
    const relationsByEntity = new Map<string, string[]>();
    if (entityIds.length > 0) {
      const relResult = await pool.query(
        `SELECT re.source_entity_id, re.target_entity_id, re.relation_type,
                e_source.name as source_name, e_target.name as target_name,
                e_source.type as source_type, e_target.type as target_type
         FROM relations re
         JOIN entities e_source ON re.source_entity_id = e_source.id
         JOIN entities e_target ON re.target_entity_id = e_target.id
         WHERE (re.source_entity_id = ANY($1::uuid[]) OR re.target_entity_id = ANY($1::uuid[]))
           AND re.relation_type = 'references'
         LIMIT 100`,
        [entityIds],
      );
      for (const row of relResult.rows) {
        // File → symbols: key by source (file)
        if (!relationsByEntity.has(row.source_entity_id)) {
          relationsByEntity.set(row.source_entity_id, []);
        }
        relationsByEntity
          .get(row.source_entity_id)!
          .push(`${row.target_name} (${row.target_type})`);
        // Symbols → file: key by target (symbol)
        if (!relationsByEntity.has(row.target_entity_id)) {
          relationsByEntity.set(row.target_entity_id, []);
        }
        relationsByEntity
          .get(row.target_entity_id)!
          .push(`in: ${row.source_name}`);
      }
    }

    return entityResult.rows.map((row) => {
      const related = relationsByEntity.get(row.id);
      let content = `[${(row.type || "").toUpperCase()}] ${row.name}: ${row.description || ""}`;
      if (related && related.length > 0) {
        content += ` | ${related.slice(0, 5).join(", ")}`;
      }
      return {
        id: row.id,
        type: "entity" as const,
        content,
        relevanceScore: 0.6,
        tokens: 0,
        metadata: {
          entityType: row.type,
          weight: row.weight,
          confidence: row.confidence,
          createdAt: row.created_at,
          tier: row.tier,
          source: "keyword",
          related: related?.slice(0, 10),
        },
        _sessionId: row.session_map_id || row.session_id,
        _topicSegmentId: row.topic_segment_id,
        _timestamp: row.created_at,
      };
    });
  } catch (err) {
    logger.warn("Keyword search error:", err);
    return [];
  }
}
