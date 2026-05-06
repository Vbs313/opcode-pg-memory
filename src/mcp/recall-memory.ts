import { Pool } from 'pg';
import { getEmbeddingService, EmbeddingService } from '../utils/embedding';

// ============================================================
// Interfaces (enhanced — backward compatible with old MCP handler)
// ============================================================

export interface RecallMemoryInput {
  /** The search query text */
  query: string;
  /** OpenCode session external ID. Auto-detected as most recent active session if omitted. */
  session_id?: string;
  /** OmO task ID for agent-scoped retrieval */
  omo_task_id?: string;
  /** Specific topic segment to bias toward (ignored if caller_context.current_session_id is set) */
  topic_segment_id?: string;
  /** Caller metadata for topic-context fusion and agent-aware retrieval */
  caller_context?: {
    type: 'user' | 'omo_agent';
    current_goal?: string;
    current_session_id?: string;
  };
  /** Retrieval strategies to execute in parallel. Default: ['semantic', 'bm25', 'graph'] */
  retrieval_strategies?: Array<'semantic' | 'bm25' | 'graph' | 'keyword' | 'temporal'>;
  /** Max results to return. Default: 10 */
  max_results?: number;
  /** Filters applied post-retrieval */
  filters?: {
    min_confidence?: number;
    min_importance?: number;
    /** Single tier filter */
    tier?: 'permanent' | 'project' | 'session';
    /** Backward compat: array of tier levels (maps to tier for single value) */
    tier_levels?: Array<'permanent' | 'project' | 'session'>;
    entity_types?: string[];
    exclude_topic_segment_ids?: string[];
    /** Time range in days (backward compat) */
    time_range_days?: number;
  };
  /** Cross-encoder rerank (backward compat). Default: true */
  rerank?: boolean;
}

export interface MemoryResult {
  id: string;
  type: 'entity' | 'observation' | 'reflection' | 'relation';
  /** Structured data payload for the new interface */
  data: Record<string, any>;
  relevance_score: number;
  /** Full context metadata */
  context: {
    session_id: string;
    omo_task_id?: string;
    topic_segment_id: string;
    topic_summary?: string;
    timestamp: string;
  };
  // ── backward-compat accessors (same data, flat) ──
  content: string;
  metadata: Record<string, any>;
}

export interface RecallMemoryOutput {
  // ── new fields ──
  query: string;
  context_used?: {
    topic_segment_id: string;
    topic_summary: string;
  };

  // ── backward-compat fields ──
  success: boolean;
  results: MemoryResult[];
  total_found: number;
  retrieval_time_ms: number;
  strategies_used: string[];
  session_id: string;
  error?: string;
}

export interface RecallMemoryConfig {
  weights: {
    semantic: number;
    recency: number;
    importance: number;
  };
  maxResults: number;
  rerankEnabled: boolean;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_CONFIG: RecallMemoryConfig = {
  weights: {
    semantic: 0.5,
    recency: 0.3,
    importance: 0.2,
  },
  maxResults: 10,
  rerankEnabled: true,
};

/** Topic-fusion blend ratio: 70% query + 30% topic */
const TOPIC_FUSION_RATIO = 0.3;

/** Max results per strategy before merge */
const PER_STRATEGY_LIMIT = 20;

// ============================================================
// Main function: recallMemory
// ============================================================

/**
 * Enhanced recall_memory MCP tool.
 *
 * Innovations:
 * 1. Topic context fusion — blends query embedding with current topic embedding
 * 2. Structured output — every result carries full context metadata
 * 3. Agent-friendly — OmO agents pass caller_context for better retrieval
 * 4. Enhanced filters — min_importance, tier, exclude_topic_segment_ids
 *
 * Backward compatible with simple { query: "..." } calls.
 */
export async function recallMemory(
  input: RecallMemoryInput,
  pool: Pool,
  config: Partial<RecallMemoryConfig> = {},
): Promise<RecallMemoryOutput> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();

  console.log(`[PG Memory] recall_memory called: "${input.query.substring(0, 100)}..."`);

  try {
    // ── Step 0: Resolve session ID ──
    const sessionId = await resolveSessionId(input, pool);

    // ── Step 1: Generate query embedding ──
    const embeddingService = getEmbeddingService();
    if (!embeddingService) {
      throw new Error(
        'Embedding service is not available. Check EMBEDDING_PROVIDER and API keys.',
      );
    }
    const queryEmbedding = await embeddingService.generateEmbedding(input.query);

    // ── Step 2: Topic context fusion ──
    let fusedEmbedding = queryEmbedding;
    let contextUsed: RecallMemoryOutput['context_used'] | undefined;

    const effectiveSessionId =
      input.caller_context?.current_session_id || input.session_id;

    if (effectiveSessionId) {
      const fusionResult = await topicContextFusion(
        effectiveSessionId,
        queryEmbedding,
        embeddingService,
        pool,
      );
      if (fusionResult) {
        fusedEmbedding = fusionResult.fusedEmbedding;
        contextUsed = fusionResult.contextUsed;
        console.log(
          `[PG Memory] Topic fusion applied (topic: ${fusionResult.contextUsed.topic_segment_id.substring(0, 8)}...)`,
        );
      }
    }

    // ── Step 3: Multi-strategy parallel retrieval ──
    const strategies = input.retrieval_strategies || ['semantic', 'bm25', 'graph'];
    const retrievalResults = await parallelRetrieve(
      input.query,
      fusedEmbedding,
      sessionId,
      strategies,
      pool,
      input.filters,
    );

    // ── Step 4: Merge & deduplicate ──
    const mergedResults = mergeAndDeduplicate(retrievalResults);

    // ── Step 5: Multi-dimensional scoring ──
    const scoredResults = calculateMultiDimensionalScores(
      mergedResults,
      fusedEmbedding,
      mergedConfig.weights,
    );

    // ── Step 6: Apply filters ──
    let filteredResults = applyFilters(scoredResults, input.filters);

    // ── Step 7: Cross-encoder rerank (backward compat) ──
    if (input.rerank !== false && mergedConfig.rerankEnabled) {
      filteredResults = await crossEncoderRerank(filteredResults, input.query);
    }

    // ── Step 8: Limit results ──
    const maxResults = input.max_results || mergedConfig.maxResults;
    filteredResults = filteredResults.slice(0, maxResults);

    // ── Step 9: Enrich with context ──
    const enrichedResults = await enrichWithContext(filteredResults, sessionId, pool);

    // ── Step 10: Convert to structured MemoryResult ──
    const results: MemoryResult[] = enrichedResults.map((fact) => {
      const id = fact.id || `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return {
        id,
        type: mapType(fact.type),
        data: buildDataPayload(fact),
        relevance_score: fact.relevanceScore,
        context: {
          session_id: fact._sessionId || sessionId,
          omo_task_id: fact._omoTaskId,
          topic_segment_id: fact._topicSegmentId || 'unknown',
          topic_summary: fact._topicSummary,
          timestamp: fact._timestamp || new Date().toISOString(),
        },
        // backward-compat flat fields
        content: fact.content,
        metadata: {
          ...fact.metadata,
          id,
          topic_segment_id: fact._topicSegmentId,
          topic_summary: fact._topicSummary,
          session_id: fact._sessionId || sessionId,
        },
      };
    });

    const retrievalTime = Date.now() - startTime;
    console.log(
      `[PG Memory] recall_memory completed: ${results.length} results in ${retrievalTime}ms`,
    );

    return {
      query: input.query,
      context_used: contextUsed,
      success: true,
      results,
      total_found: mergedResults.length,
      retrieval_time_ms: retrievalTime,
      strategies_used: strategies,
      session_id: sessionId,
    };
  } catch (error: any) {
    console.error('[PG Memory] recall_memory error:', error);
    const retrievalTime = Date.now() - startTime;
    return {
      query: input.query,
      success: false,
      results: [],
      total_found: 0,
      retrieval_time_ms: retrievalTime,
      strategies_used: [],
      session_id: '',
      error: error.message || String(error),
    };
  }
}

// ============================================================
// Internal fact representation (intermediate, before MemoryResult)
// ============================================================

interface InternalFact {
  id?: string;
  type: 'entity' | 'observation' | 'reflection' | 'relation' | 'message';
  content: string;
  relevanceScore: number;
  metadata: Record<string, any>;
  tokens: number;
  // context fields populated by enrichWithContext
  _sessionId?: string;
  _omoTaskId?: string;
  _topicSegmentId?: string;
  _topicSummary?: string;
  _timestamp?: string;
}

// ============================================================
// Step 0: Session ID resolution
// ============================================================

async function resolveSessionId(
  input: RecallMemoryInput,
  pool: Pool,
): Promise<string> {
  if (input.session_id) {
    // Provided session_id — try session_map first, then fall back to sessions
    const id = await resolveExternalSessionId(input.session_id, pool);
    if (id) return id;

    // If not found in session_map, try legacy sessions table
    const legacyResult = await pool.query(
      'SELECT id FROM sessions WHERE external_id = $1',
      [input.session_id],
    );
    if (legacyResult.rows.length > 0) return legacyResult.rows[0].id;
    throw new Error(`Session not found: ${input.session_id}`);
  }

  // Auto-detect: try session_map first, then sessions
  try {
    const recent = await pool.query(
      'SELECT id, opencode_session_id FROM session_map ORDER BY last_active_at DESC LIMIT 1',
    );
    if (recent.rows.length > 0) {
      console.log(
        `[PG Memory] Auto-detected session: ${recent.rows[0].opencode_session_id}`,
      );
      return recent.rows[0].id;
    }
  } catch {
    // session_map table doesn't exist yet
  }

  // Fall back to legacy sessions
  const recentSession = await pool.query(
    "SELECT id, external_id FROM sessions ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1",
  );
  if (recentSession.rows.length > 0) {
    console.log(
      `[PG Memory] Auto-detected session (legacy): ${recentSession.rows[0].external_id}`,
    );
    return recentSession.rows[0].id;
  }

  throw new Error(
    'No session found. Please start a conversation first or provide session_id explicitly.',
  );
}

/**
 * Resolve an external session ID to internal UUID via session_map or sessions table.
 */
async function resolveExternalSessionId(
  externalId: string,
  pool: Pool,
): Promise<string | null> {
  // Try session_map
  try {
    const result = await pool.query(
      'SELECT id FROM session_map WHERE opencode_session_id = $1',
      [externalId],
    );
    if (result.rows.length > 0) return result.rows[0].id;
  } catch {
    // table may not exist
  }

  // Try legacy sessions
  const legacy = await pool.query(
    'SELECT id FROM sessions WHERE external_id = $1',
    [externalId],
  );
  if (legacy.rows.length > 0) return legacy.rows[0].id;

  return null;
}

// ============================================================
// Step 2: Topic context fusion
// ============================================================

async function topicContextFusion(
  externalSessionId: string,
  queryEmbedding: number[],
  embeddingService: EmbeddingService,
  pool: Pool,
): Promise<{
  fusedEmbedding: number[];
  contextUsed: NonNullable<RecallMemoryOutput['context_used']>;
} | null> {
  try {
    // Look up internal session ID
    const sessionLookup = await pool.query(
      `SELECT id FROM session_map WHERE opencode_session_id = $1
       UNION ALL
       SELECT id FROM sessions WHERE external_id = $1
       LIMIT 1`,
      [externalSessionId],
    );
    if (sessionLookup.rows.length === 0) return null;
    const internalSessionId = sessionLookup.rows[0].id;

    // Find most recent active topic segment for this session
    const topicResult = await pool.query(
      `SELECT id, summary, embedding
       FROM topic_segments
       WHERE session_map_id = $1
         AND closed_at IS NULL
         AND embedding IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [internalSessionId],
    );

    if (topicResult.rows.length === 0) {
      // Try finding any topic segment with embedding
      const anyTopic = await pool.query(
        `SELECT id, summary, embedding
         FROM topic_segments
         WHERE session_map_id = $1
           AND embedding IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [internalSessionId],
      );
      if (anyTopic.rows.length === 0) return null;

      const topicEmbedding = anyTopic.rows[0].embedding as number[];
      const fusedEmbedding = fuseEmbeddings(queryEmbedding, topicEmbedding, TOPIC_FUSION_RATIO);

      return {
        fusedEmbedding,
        contextUsed: {
          topic_segment_id: anyTopic.rows[0].id,
          topic_summary: anyTopic.rows[0].summary || 'No summary',
        },
      };
    }

    const topicEmbedding = topicResult.rows[0].embedding as number[];
    const fusedEmbedding = fuseEmbeddings(queryEmbedding, topicEmbedding, TOPIC_FUSION_RATIO);

    return {
      fusedEmbedding,
      contextUsed: {
        topic_segment_id: topicResult.rows[0].id,
        topic_summary: topicResult.rows[0].summary || 'No summary',
      },
    };
  } catch (err) {
    // topic_segments table may not exist — skip fusion gracefully
    console.warn('[PG Memory] Topic context fusion skipped:', err);
    return null;
  }
}

/**
 * Fuse two embeddings: fused = normalize((1-ratio) * a + ratio * b)
 */
function fuseEmbeddings(
  queryEmb: number[],
  topicEmb: number[],
  topicRatio: number,
): number[] {
  const dim = Math.min(queryEmb.length, topicEmb.length);
  const result: number[] = new Array(dim);
  const queryWeight = 1 - topicRatio;

  for (let i = 0; i < dim; i++) {
    result[i] = queryWeight * (queryEmb[i] || 0) + topicRatio * (topicEmb[i] || 0);
  }

  return normalizeVector(result);
}

/**
 * L2-normalize a vector to unit length.
 */
function normalizeVector(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vec.slice();
  return vec.map((v) => v / magnitude);
}

// ============================================================
// Step 3: Multi-strategy parallel retrieval
// ============================================================

async function parallelRetrieve(
  query: string,
  queryEmbedding: number[],
  sessionId: string,
  strategies: string[],
  pool: Pool,
  filters?: RecallMemoryInput['filters'],
): Promise<Map<string, InternalFact[]>> {
  const results = new Map<string, InternalFact[]>();

  const filterSQL = buildFilterConditions(filters);

  const promises: Promise<void>[] = [];

  if (strategies.includes('semantic')) {
    promises.push(
      (async () => {
        try {
          const r = await semanticSearch(queryEmbedding, sessionId, pool, filterSQL);
          results.set('semantic', r);
        } catch (err) {
          console.warn('[PG Memory] Semantic search failed:', err);
          results.set('semantic', []);
        }
      })(),
    );
  }

  if (strategies.includes('bm25')) {
    promises.push(
      (async () => {
        try {
          const r = await bm25Search(query, sessionId, pool, filterSQL);
          results.set('bm25', r);
        } catch (err) {
          console.warn('[PG Memory] BM25 search failed:', err);
          results.set('bm25', []);
        }
      })(),
    );
  }

  if (strategies.includes('graph')) {
    promises.push(
      (async () => {
        try {
          const r = await graphTraversal(query, embeddingServiceFallback(query), sessionId, pool, filterSQL);
          results.set('graph', r);
        } catch (err) {
          console.warn('[PG Memory] Graph traversal failed:', err);
          results.set('graph', []);
        }
      })(),
    );
  }

  if (strategies.includes('keyword')) {
    promises.push(
      (async () => {
        try {
          const r = await keywordSearch(query, sessionId, pool, filterSQL);
          results.set('keyword', r);
        } catch (err) {
          console.warn('[PG Memory] Keyword search failed:', err);
          results.set('keyword', []);
        }
      })(),
    );
  }

  await Promise.all(promises);
  return results;
}

/** Fallback embedding for non-vector strategies (simple keyword affinity) */
function embeddingServiceFallback(_query: string): number[] {
  // Graph traversal uses keyword matching, not vector search
  return [];
}

// ============================================================
// Filter builder
// ============================================================

function buildFilterConditions(filters?: RecallMemoryInput['filters']): {
  sql: string;
  params: any[];
} {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters?.min_confidence !== undefined) {
    conditions.push(`(e.confidence >= $${idx} OR o.importance IS NULL)`);
    params.push(filters.min_confidence);
    idx++;
  }

  // Note: min_importance, tier, entity_types, exclude_topic_segment_ids are applied
  // in the post-retrieval applyFilters() step, not in SQL.

  const sql = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
  return { sql, params };
}

// ============================================================
// Semantic search (vector)
// ============================================================

async function semanticSearch(
  queryEmbedding: number[],
  sessionId: string,
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
      WHERE (e.session_map_id = $2 OR e.session_id = $2 OR e.tier = 'permanent')
        AND e.embedding IS NOT NULL
        ${filters.sql}
      ORDER BY e.embedding <=> $1
      LIMIT ${PER_STRATEGY_LIMIT}
    `;
    const entityResult = await pool.query(entityQuery, [
      queryEmbedding,
      sessionId,
      ...filters.params.filter((_, i) => i < filters.params.length),
    ]);
    facts.push(
      ...entityResult.rows.map((row) => ({
        id: row.id,
        type: 'entity' as const,
        content: `[${(row.type || '').toUpperCase()}] ${row.name}: ${row.description || ''}`,
        relevanceScore: row.similarity ?? 0,
        tokens: 0,
        metadata: {
          entityType: row.type,
          weight: row.weight,
          confidence: row.confidence,
          createdAt: row.created_at,
          tier: row.tier,
          source: 'semantic',
        },
        _sessionId: row.session_map_id || row.session_id,
        _topicSegmentId: row.topic_segment_id,
        _timestamp: row.created_at,
      })),
    );
  } catch (err) {
    console.warn('[PG Memory] Entity semantic search error:', err);
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
      WHERE (o.session_map_id = $2 OR o.session_id = $2)
        AND o.embedding IS NOT NULL
      ORDER BY o.embedding <=> $1
      LIMIT ${PER_STRATEGY_LIMIT}
    `;
    const obsResult = await pool.query(obsQuery, [queryEmbedding, sessionId]);
    facts.push(
      ...obsResult.rows.map((row) => ({
        id: row.id,
        type: 'observation' as const,
        content: `[${row.tool_name || 'Observation'}] ${row.content || ''}`,
        relevanceScore: row.similarity ?? 0,
        tokens: 0,
        metadata: {
          toolName: row.tool_name,
          importance: row.importance,
          createdAt: row.created_at,
          source: 'semantic',
        },
        _sessionId: row.session_map_id || row.session_id,
        _topicSegmentId: row.topic_segment_id,
        _timestamp: row.created_at,
      })),
    );
  } catch (err) {
    console.warn('[PG Memory] Observation semantic search error:', err);
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
      WHERE (r.session_map_id = $2 OR r.session_id = $2)
        AND r.embedding IS NOT NULL
      ORDER BY r.embedding <=> $1
      LIMIT ${PER_STRATEGY_LIMIT / 2}
    `;
    const refResult = await pool.query(refQuery, [queryEmbedding, sessionId]);
    facts.push(
      ...refResult.rows.map((row) => ({
        id: row.id,
        type: 'reflection' as const,
        content: `[Reflection${row.pattern_type ? ` - ${row.pattern_type}` : ''}] ${row.content || ''}`,
        relevanceScore: row.similarity ?? 0,
        tokens: 0,
        metadata: {
          patternType: row.pattern_type,
          confidence: row.confidence,
          createdAt: row.created_at,
          source: 'semantic',
        },
        _sessionId: row.session_map_id || row.session_id,
        _topicSegmentId: row.topic_segment_id,
        _timestamp: row.created_at,
      })),
    );
  } catch (err) {
    console.warn('[PG Memory] Reflection semantic search error:', err);
  }

  return facts;
}

// ============================================================
// BM25 / trigram text search
// ============================================================

async function bm25Search(
  query: string,
  sessionId: string,
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
      WHERE (e.session_map_id = $2 OR e.session_id = $2 OR e.tier = 'permanent')
        AND (e.name % $1 OR e.description % $1)
        ${filters.sql}
      ORDER BY similarity(e.name, $1) DESC
      LIMIT ${PER_STRATEGY_LIMIT}
    `;
    const entityResult = await pool.query(entityQuery, [
      query,
      sessionId,
      ...filters.params,
    ]);
    facts.push(
      ...entityResult.rows.map((row) => ({
        id: row.id,
        type: 'entity' as const,
        content: `[${(row.type || '').toUpperCase()}] ${row.name}: ${row.description || ''}`,
        relevanceScore: row.bm25_score ?? 0,
        tokens: 0,
        metadata: {
          entityType: row.type,
          weight: row.weight,
          confidence: row.confidence,
          createdAt: row.created_at,
          tier: row.tier,
          source: 'bm25',
        },
        _sessionId: row.session_map_id || row.session_id,
        _topicSegmentId: row.topic_segment_id,
        _timestamp: row.created_at,
      })),
    );
  } catch (err) {
    console.warn('[PG Memory] BM25 search failed (pg_trgm may not be installed):', err);
  }

  return facts;
}

// ============================================================
// Graph traversal
// ============================================================

async function graphTraversal(
  query: string,
  _queryEmb: number[],
  sessionId: string,
  pool: Pool,
  filters: { sql: string; params: any[] },
): Promise<InternalFact[]> {
  // 1. Find seed entities matching query text
  let seedQuery: string;
  let seedParams: any[];

  try {
    // Try newer schema (session_map_id)
    seedQuery = `
      SELECT id, name, type
      FROM entities
      WHERE (session_map_id = $1 OR session_id = $1 OR tier = 'permanent')
        AND (name ILIKE $2 OR description ILIKE $2)
      LIMIT 5
    `;
    seedParams = [sessionId, `%${query}%`];
  } catch {
    return [];
  }

  const seedResult = await pool.query(seedQuery, seedParams);
  if (seedResult.rows.length === 0) return [];

  const seedIds = seedResult.rows.map((row) => row.id);

  // 2. Traverse relations (1-hop neighbors) using the graph query pattern from spec
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
      type: 'entity' as const,
      content: `[${(row.type || '').toUpperCase()}] ${row.name}: ${row.description || ''} (related to ${row.related_entity_name} via ${row.relation_type})`,
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
        source: 'graph',
      },
      _sessionId: row.session_map_id || row.session_id,
      _topicSegmentId: row.topic_segment_id,
      _timestamp: row.created_at,
    }));
  } catch (err) {
    console.warn('[PG Memory] Graph traversal error:', err);
    return [];
  }
}

// ============================================================
// Keyword search
// ============================================================

async function keywordSearch(
  query: string,
  sessionId: string,
  pool: Pool,
  filters: { sql: string; params: any[] },
): Promise<InternalFact[]> {
  const keywords = query.split(/\s+/).filter((k) => k.length > 2);
  if (keywords.length === 0) return [];

  const pattern = keywords.join('|');

  try {
    const entityQuery = `
      SELECT e.id, e.name, e.type, e.tier, e.weight, e.description,
             e.first_seen_at as created_at, e.confidence,
             e.session_id, e.session_map_id, e.topic_segment_id
      FROM entities e
      WHERE (e.session_map_id = $1 OR e.session_id = $1 OR e.tier = 'permanent')
        AND (e.name ~* $2 OR e.description ~* $2)
        ${filters.sql}
      LIMIT ${PER_STRATEGY_LIMIT}
    `;
    const entityResult = await pool.query(entityQuery, [sessionId, pattern, ...filters.params]);
    return entityResult.rows.map((row) => ({
      id: row.id,
      type: 'entity' as const,
      content: `[${(row.type || '').toUpperCase()}] ${row.name}: ${row.description || ''}`,
      relevanceScore: 0.6,
      tokens: 0,
      metadata: {
        entityType: row.type,
        weight: row.weight,
        confidence: row.confidence,
        createdAt: row.created_at,
        tier: row.tier,
        source: 'keyword',
      },
      _sessionId: row.session_map_id || row.session_id,
      _topicSegmentId: row.topic_segment_id,
      _timestamp: row.created_at,
    }));
  } catch (err) {
    console.warn('[PG Memory] Keyword search error:', err);
    return [];
  }
}

// ============================================================
// Step 4: Merge & deduplicate
// ============================================================

function mergeAndDeduplicate(
  strategyResults: Map<string, InternalFact[]>,
): InternalFact[] {
  const seen = new Set<string>();
  const merged: InternalFact[] = [];

  for (const [, facts] of strategyResults) {
    for (const fact of facts) {
      const key = `${fact.type}:${fact.id || fact.metadata.id || ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(fact);
      } else {
        // Keep highest score
        const existing = merged.find(
          (f) => `${f.type}:${f.id || f.metadata.id || ''}` === key,
        );
        if (existing && fact.relevanceScore > existing.relevanceScore) {
          existing.relevanceScore = fact.relevanceScore;
        }
      }
    }
  }

  return merged;
}

// ============================================================
// Step 5: Multi-dimensional scoring
// ============================================================

function calculateMultiDimensionalScores(
  facts: InternalFact[],
  _queryEmbedding: number[],
  weights: { semantic: number; recency: number; importance: number },
): InternalFact[] {
  const now = new Date();

  return facts
    .map((fact) => {
      const semanticScore = fact.relevanceScore;

      // Recency decay
      const createdAt = new Date(fact.metadata.createdAt || fact._timestamp || Date.now());
      const daysAgo = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
      const recencyScore = 1.0 / (1 + daysAgo);

      // Importance (normalize to 0-1)
      const importance = fact.metadata.importance || fact.metadata.weight || 3;
      const importanceScore = Math.min(1, importance / 5.0);

      const finalScore =
        weights.semantic * semanticScore +
        weights.recency * recencyScore +
        weights.importance * importanceScore;

      return {
        ...fact,
        relevanceScore: Math.round(finalScore * 1000) / 1000,
      };
    })
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

// ============================================================
// Step 6: Apply filters (post-retrieval)
// ============================================================

function applyFilters(
  facts: InternalFact[],
  filters?: RecallMemoryInput['filters'],
): InternalFact[] {
  if (!filters) return facts;

  // Resolve tier filter: single `tier` takes precedence, fall back to `tier_levels` (first element)
  const effectiveTiers: string[] = [];
  if (filters.tier) {
    effectiveTiers.push(filters.tier);
  } else if (filters.tier_levels && filters.tier_levels.length > 0) {
    effectiveTiers.push(...filters.tier_levels);
  }

  const now = Date.now();

  return facts.filter((fact) => {
    // min_confidence
    if (filters.min_confidence !== undefined) {
      const conf = fact.metadata.confidence;
      if (conf !== undefined && conf !== null && conf < filters.min_confidence) return false;
    }

    // min_importance
    if (filters.min_importance !== undefined) {
      const imp = fact.metadata.importance;
      if (imp !== undefined && imp !== null && imp < filters.min_importance) return false;
    }

    // tier filter (single + array backward compat)
    if (effectiveTiers.length > 0) {
      const tier = fact.metadata.tier;
      if (tier && !effectiveTiers.includes(tier)) return false;
    }

    // entity_types filter
    if (filters.entity_types && filters.entity_types.length > 0) {
      const etype = fact.metadata.entityType;
      if (etype && !filters.entity_types.includes(etype)) return false;
    }

    // exclude_topic_segment_ids
    if (filters.exclude_topic_segment_ids && filters.exclude_topic_segment_ids.length > 0) {
      if (
        fact._topicSegmentId &&
        filters.exclude_topic_segment_ids.includes(fact._topicSegmentId)
      ) {
        return false;
      }
    }

    // time_range_days (backward compat)
    if (filters.time_range_days !== undefined) {
      const ts = fact._timestamp || fact.metadata.createdAt;
      if (ts) {
        const ageMs = now - new Date(ts).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays > filters.time_range_days) return false;
      }
    }

    return true;
  });
}

// ============================================================
// Step 7: Cross-encoder rerank (simplified)
// ============================================================

async function crossEncoderRerank(
  facts: InternalFact[],
  query: string,
): Promise<InternalFact[]> {
  const queryLower = query.toLowerCase();

  const reranked = facts.map((fact) => {
    const contentLower = fact.content.toLowerCase();
    const queryWords = queryLower.split(/\s+/);
    const contentWords = contentLower.split(/\s+/);

    let overlap = 0;
    for (const word of queryWords) {
      if (word.length > 2 && contentWords.some((cw) => cw.includes(word))) {
        overlap++;
      }
    }

    const overlapScore = queryWords.length > 0 ? overlap / queryWords.length : 0;
    const adjustedScore = fact.relevanceScore * 0.7 + overlapScore * 0.3;

    return {
      ...fact,
      relevanceScore: Math.round(adjustedScore * 1000) / 1000,
    };
  });

  return reranked.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

// ============================================================
// Step 9: Enrich with context (session_map + topic_segments)
// ============================================================

async function enrichWithContext(
  facts: InternalFact[],
  sessionId: string,
  pool: Pool,
): Promise<InternalFact[]> {
  if (facts.length === 0) return facts;

  // Collect unique session IDs that need context lookup
  const sessionIds = new Set<string>();
  const topicIds = new Set<string>();

  for (const fact of facts) {
    if (fact._sessionId) sessionIds.add(fact._sessionId);
    if (fact._topicSegmentId) topicIds.add(fact._topicSegmentId);
  }

  // Batch lookups
  const [sessionMap, topicMap] = await Promise.all([
    lookupSessions([...sessionIds], pool),
    lookupTopics([...topicIds], pool),
  ]);

  // Apply context to each fact
  for (const fact of facts) {
    if (fact._sessionId && sessionMap.has(fact._sessionId)) {
      const s = sessionMap.get(fact._sessionId)!;
      fact._omoTaskId = fact._omoTaskId || s.omo_task_id;
      if (!fact._sessionId) fact._sessionId = s.opencode_session_id || fact._sessionId;
    }

    if (fact._topicSegmentId && topicMap.has(fact._topicSegmentId)) {
      const t = topicMap.get(fact._topicSegmentId)!;
      fact._topicSummary = t.summary;
    }

    // Fallback timestamp
    if (!fact._timestamp) {
      fact._timestamp = fact.metadata.createdAt || new Date().toISOString();
    }
  }

  return facts;
}

async function lookupSessions(
  ids: string[],
  pool: Pool,
): Promise<Map<string, { opencode_session_id?: string; omo_task_id?: string }>> {
  const map = new Map<string, { opencode_session_id?: string; omo_task_id?: string }>();
  if (ids.length === 0) return map;

  try {
    const result = await pool.query(
      `SELECT id, opencode_session_id, omo_task_id FROM session_map WHERE id = ANY($1)`,
      [ids],
    );
    for (const row of result.rows) {
      map.set(row.id, {
        opencode_session_id: row.opencode_session_id,
        omo_task_id: row.omo_task_id,
      });
    }
  } catch {
    // session_map may not exist, try sessions
    try {
      const result = await pool.query(
        `SELECT id, external_id FROM sessions WHERE id = ANY($1)`,
        [ids],
      );
      for (const row of result.rows) {
        map.set(row.id, { opencode_session_id: row.external_id });
      }
    } catch {
      // Both failed — context will be sparse
    }
  }

  return map;
}

async function lookupTopics(
  ids: string[],
  pool: Pool,
): Promise<Map<string, { summary?: string }>> {
  const map = new Map<string, { summary?: string }>();
  if (ids.length === 0) return map;

  try {
    const result = await pool.query(
      `SELECT id, summary FROM topic_segments WHERE id = ANY($1)`,
      [ids],
    );
    for (const row of result.rows) {
      map.set(row.id, { summary: row.summary });
    }
  } catch {
    // topic_segments may not exist
  }

  return map;
}

// ============================================================
// Helpers: type mapping, data payload builder, vector formatting
// ============================================================

function mapType(
  type: 'entity' | 'observation' | 'reflection' | 'relation' | 'message',
): 'entity' | 'observation' | 'reflection' | 'relation' {
  if (type === 'message') return 'observation'; // legacy messages → observation
  if (type === 'relation') return 'relation';
  return type;
}

function buildDataPayload(fact: InternalFact): Record<string, any> {
  return {
    name: fact.metadata.entityType,
    type: fact.type,
    content: fact.content,
    confidence: fact.metadata.confidence,
    importance: fact.metadata.importance || fact.metadata.weight,
    created_at: fact.metadata.createdAt || fact._timestamp,
    pattern_type: fact.metadata.patternType,
    relation_type: fact.metadata.relationType,
    related_entity: fact.metadata.relatedEntity,
    tool_name: fact.metadata.toolName,
    ...fact.metadata,
  };
}

/** Format a number[] as a pgvector literal string: '[0.1,0.2,...]' */
function formatVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
