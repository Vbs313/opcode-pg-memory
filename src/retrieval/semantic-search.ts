import { Pool } from "pg";
import { createLogger } from "../services/logger";
import { InternalFact } from "../types";

const logger = createLogger("semantic-search");
const PER_STRATEGY_LIMIT = 20;

/** Format a number[] as a pgvector literal string: '[0.1,0.2,...]' */
function formatVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Semantic search using pgvector cosine similarity (<=> operator).
 * Queries entities, observations, and reflections tables.
 */
export async function semanticSearch(
  queryEmbedding: number[],
  sessionIds: string[],
  pool: Pool,
  filters: { sql: string; params: any[] },
): Promise<InternalFact[]> {
  const facts: InternalFact[] = [];
  const embeddingStr = formatVectorLiteral(queryEmbedding);

  // ── 1. Entities (via session_map + topic_segments if available, fall back to sessions) ──
  try {
    const entityQuery = `
      SELECT e.id, e.name, e.type, e.tier, e.weight, e.description,
             1 - (e.embedding <=> $1) as similarity,
             e.first_seen_at as created_at, e.confidence,
             e.session_id, e.session_map_id, e.topic_segment_id
      FROM entities e
      LEFT JOIN session_map sm ON e.session_map_id = sm.id
      LEFT JOIN topic_segments ts ON e.topic_segment_id = ts.id
      WHERE (e.session_map_id = ANY($2::uuid[]) OR e.session_id = ANY($2::uuid[]) OR e.tier = 'permanent')
        AND e.embedding IS NOT NULL
        ${filters.sql}
      ORDER BY e.embedding <=> $1
      LIMIT ${PER_STRATEGY_LIMIT}
    `;
    const entityResult = await pool.query(entityQuery, [
      queryEmbedding,
      sessionIds,
      ...filters.params.filter((_, i) => i < filters.params.length),
    ]);
    facts.push(
      ...entityResult.rows.map((row) => ({
        id: row.id,
        type: "entity" as const,
        content: `[${(row.type || "").toUpperCase()}] ${row.name}: ${row.description || ""}`,
        relevanceScore: row.similarity ?? 0,
        tokens: 0,
        metadata: {
          entityType: row.type,
          weight: row.weight,
          confidence: row.confidence,
          createdAt: row.created_at,
          tier: row.tier,
          source: "semantic",
        },
        _sessionId: row.session_map_id || row.session_id,
        _topicSegmentId: row.topic_segment_id,
        _timestamp: row.created_at,
      })),
    );
  } catch (err) {
    logger.warn("Entity semantic search error:", err);
  }

  // ── 2. Observations ──
  try {
    const obsQuery = `
      SELECT o.id, o.tool_name, o.tool_output_summary as content, o.embedding,
             1 - (o.embedding <=> $1) as similarity,
             o.created_at, o.importance,
             o.session_id, o.session_map_id, o.topic_segment_id
      FROM observations o
      LEFT JOIN session_map sm ON o.session_map_id = sm.id
      LEFT JOIN topic_segments ts ON o.topic_segment_id = ts.id
      WHERE (o.session_map_id = ANY($2::uuid[]) OR o.session_id = ANY($2::uuid[]))
        AND o.embedding IS NOT NULL
      ORDER BY o.embedding <=> $1
      LIMIT ${PER_STRATEGY_LIMIT}
    `;
    const obsResult = await pool.query(obsQuery, [queryEmbedding, sessionIds]);
    facts.push(
      ...obsResult.rows.map((row) => ({
        id: row.id,
        type: "observation" as const,
        content: `[${row.tool_name || "Observation"}] ${row.content || ""}`,
        relevanceScore: row.similarity ?? 0,
        tokens: 0,
        metadata: {
          toolName: row.tool_name,
          importance: row.importance,
          createdAt: row.created_at,
          source: "semantic",
        },
        _sessionId: row.session_map_id || row.session_id,
        _topicSegmentId: row.topic_segment_id,
        _timestamp: row.created_at,
      })),
    );
  } catch (err) {
    logger.warn("Observation semantic search error:", err);
  }

  // ── 3. Reflections ──
  try {
    const refQuery = `
      SELECT r.id, r.summary as content, r.pattern_type, r.embedding,
             1 - (r.embedding <=> $1) as similarity,
             r.created_at, r.confidence,
             r.session_id, r.session_map_id, r.topic_segment_id
      FROM reflections r
      LEFT JOIN session_map sm ON r.session_map_id = sm.id
      LEFT JOIN topic_segments ts ON r.topic_segment_id = ts.id
      WHERE (r.session_map_id = ANY($2::uuid[]) OR r.session_id = ANY($2::uuid[]))
        AND r.embedding IS NOT NULL
      ORDER BY r.embedding <=> $1
      LIMIT ${PER_STRATEGY_LIMIT / 2}
    `;
    const refResult = await pool.query(refQuery, [queryEmbedding, sessionIds]);
    facts.push(
      ...refResult.rows.map((row) => ({
        id: row.id,
        type: "reflection" as const,
        content: `[Reflection${row.pattern_type ? ` - ${row.pattern_type}` : ""}] ${row.content || ""}`,
        relevanceScore: row.similarity ?? 0,
        tokens: 0,
        metadata: {
          patternType: row.pattern_type,
          confidence: row.confidence,
          createdAt: row.created_at,
          source: "semantic",
        },
        _sessionId: row.session_map_id || row.session_id,
        _topicSegmentId: row.topic_segment_id,
        _timestamp: row.created_at,
      })),
    );
  } catch (err) {
    logger.warn("Reflection semantic search error:", err);
  }

  return facts;
}
