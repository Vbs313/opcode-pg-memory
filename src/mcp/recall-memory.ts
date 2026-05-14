import { Pool } from "pg";
import { createLogger } from "../services/logger";
import { getEmbeddingService, EmbeddingService } from "../utils/embedding";
import {
  RecallMemoryInput,
  RecallMemoryOutput,
  MemoryResult,
  RecallMemoryConfig,
  DecayConfig,
} from "../types";
import {
  resolveSessionId,
  resolveScopeToSessionIds,
  parallelRetrieve,
  enrichWithContext,
  mapType,
  buildDataPayload,
} from "../retrieval/utils";
import {
  mergeAndDeduplicate,
  calculateMultiDimensionalScores,
  applyFilters,
  aggregateConsecutiveSimilar,
  crossEncoderRerank,
} from "../retrieval/fusion";

const logger = createLogger("recall-memory");
const DEFAULT_DECAY: DecayConfig = {
  enabled: true,
  factor: 0.99,
  maxAgeDays: 365,
};
const TOPIC_RATIO = 0.3;
const DEFAULT_CFG: RecallMemoryConfig = {
  weights: { semantic: 0.5, recency: 0.3, importance: 0.2 },
  maxResults: 10,
  rerankEnabled: true,
  decay: { ...DEFAULT_DECAY },
};

export type {
  RecallMemoryInput,
  RecallMemoryOutput,
  MemoryResult,
  RecallMemoryConfig,
  DecayConfig,
};
export { aggregateConsecutiveSimilar } from "../retrieval/fusion";

/** Enhanced recall_memory MCP tool -- multi-strategy retrieval with topic-context fusion. Backward compatible with simple { query: "..." } calls. */
export async function recallMemory(
  input: RecallMemoryInput,
  pool: Pool,
  config: Partial<RecallMemoryConfig> = {},
): Promise<RecallMemoryOutput> {
  const cfg = { ...DEFAULT_CFG, ...config };
  const t0 = Date.now();
  try {
    const sid = await resolveSessionId(input, pool);
    const scope = input.scope || "session";
    const sids = await resolveScopeToSessionIds(pool, sid, scope);
    if (scope !== "session")
      logger.info("Scope " + scope + ": " + sids.length + " sessions");

    const emb = getEmbeddingService();
    if (!emb) throw new Error("Embedding service not available");
    let qEmb = await emb.generateEmbedding(input.query);
    let ctx: RecallMemoryOutput["context_used"] | undefined;

    if (input.session_id || sid) {
      const f = await topicFusion(input.session_id || sid, qEmb, emb, pool);
      if (f) {
        qEmb = f.fusedEmbedding;
        ctx = f.contextUsed;
      }
    }

    const strats = input.retrieval_strategies || ["semantic", "bm25", "graph"];
    const results = await parallelRetrieve(
      input.query,
      qEmb,
      sids,
      strats,
      pool,
      input.filters,
    );

    let facts = mergeAndDeduplicate(results);
    facts = calculateMultiDimensionalScores(facts, qEmb, cfg.weights, {
      ...DEFAULT_DECAY,
      ...cfg.decay,
    });
    facts = applyFilters(facts, input.filters);
    if (input.aggregate_similar && facts.length > 0)
      facts = aggregateConsecutiveSimilar(facts);
    if (input.rerank !== false && cfg.rerankEnabled)
      facts = await crossEncoderRerank(facts, input.query);
    facts = facts.slice(0, input.max_results || cfg.maxResults);
    facts = await enrichWithContext(facts, sid, pool);

    const memoryResults: MemoryResult[] = facts.map((fact) => {
      const id =
        fact.id ||
        "fb-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      return {
        id,
        type: mapType(fact.type),
        data: buildDataPayload(fact),
        relevance_score: fact.relevanceScore,
        context: {
          session_id: fact._sessionId || sid,
          omo_task_id: fact._omoTaskId,
          topic_segment_id: fact._topicSegmentId || "unknown",
          topic_summary: fact._topicSummary,
          timestamp: fact._timestamp || new Date().toISOString(),
        },
        content: fact.content,
        metadata: {
          ...fact.metadata,
          id,
          topic_segment_id: fact._topicSegmentId,
          topic_summary: fact._topicSummary,
          session_id: fact._sessionId || sid,
        },
      };
    });

    const ms = Date.now() - t0;
    (ms > 1000 ? logger.warn : logger.info)(
      "recall_memory: " + memoryResults.length + " results in " + ms + "ms",
    );
    return {
      query: input.query,
      context_used: ctx,
      success: true,
      results: memoryResults,
      total_found: memoryResults.length,
      retrieval_time_ms: ms,
      strategies_used: strats,
      session_id: sid,
    };
  } catch (error: any) {
    logger.error("recall_memory error:", error);
    return {
      query: input.query,
      success: false,
      results: [],
      total_found: 0,
      retrieval_time_ms: Date.now() - t0,
      strategies_used: [],
      session_id: "",
      error: error.message || String(error),
    };
  }
}

/** Topic context fusion -- blends query embedding with current topic embedding (70/30 ratio) */
async function topicFusion(
  extId: string,
  qEmb: number[],
  embSvc: EmbeddingService,
  pool: Pool,
): Promise<{
  fusedEmbedding: number[];
  contextUsed: NonNullable<RecallMemoryOutput["context_used"]>;
} | null> {
  try {
    const lk = await pool.query(
      "SELECT id FROM session_map WHERE opencode_session_id = $1 UNION ALL SELECT id FROM sessions WHERE external_id = $1 LIMIT 1",
      [extId],
    );
    if (lk.rows.length === 0) return null;
    const isid = lk.rows[0].id;
    const topic = await pool.query(
      "SELECT id, summary, embedding FROM topic_segments WHERE session_map_id = $1 AND closed_at IS NULL AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      [isid],
    );
    const use = (r: any) => ({
      fusedEmbedding: fuse(qEmb, r.embedding, TOPIC_RATIO),
      contextUsed: {
        topic_segment_id: r.id,
        topic_summary: r.summary || "No summary",
      },
    });
    if (topic.rows.length > 0) return use(topic.rows[0]);
    const any = await pool.query(
      "SELECT id, summary, embedding FROM topic_segments WHERE session_map_id = $1 AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      [isid],
    );
    if (any.rows.length > 0) return use(any.rows[0]);
    return null;
  } catch (err) {
    logger.warn("Topic fusion skipped:", err);
    return null;
  }
}

function fuse(a: number[], b: number[], r: number): number[] {
  return norm(a.map((v, i) => (1 - r) * v + r * (b[i] || 0)));
}
function norm(v: number[]): number[] {
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return m === 0 ? v.slice() : v.map((x) => x / m);
}
