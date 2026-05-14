import { Pool } from "pg";
import { createLogger } from "../services/logger";
import { InternalFact, RecallMemoryInput } from "../types";
import { semanticSearch } from "./semantic-search";
import { keywordSearch } from "./keyword-search";
import { bm25Search } from "./bm25-search";
import { graphTraversal, embeddingServiceFallback } from "./graph-traversal";

const logger = createLogger("retrieval-utils");

// ============================================================
// Session ID resolution
// ============================================================

export async function resolveSessionId(
  input: RecallMemoryInput,
  pool: Pool,
): Promise<string> {
  if (input.session_id) {
    const id = await resolveExternalSessionId(input.session_id, pool);
    if (id) return id;

    const legacyResult = await pool.query(
      "SELECT id FROM sessions WHERE external_id = $1",
      [input.session_id],
    );
    if (legacyResult.rows.length > 0) return legacyResult.rows[0].id;
    throw new Error(`Session not found: ${input.session_id}`);
  }

  // Auto-detect: try session_map first, then sessions
  try {
    const recent = await pool.query(
      "SELECT id, opencode_session_id FROM session_map ORDER BY last_active_at DESC LIMIT 1",
    );
    if (recent.rows.length > 0) {
      logger.info(
        `Auto-detected session: ${recent.rows[0].opencode_session_id}`,
      );
      return recent.rows[0].id;
    }
  } catch {
    // session_map table doesn't exist yet
  }

  const recentSession = await pool.query(
    "SELECT id, external_id FROM sessions ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1",
  );
  if (recentSession.rows.length > 0) {
    logger.info(
      `Auto-detected session (legacy): ${recentSession.rows[0].external_id}`,
    );
    return recentSession.rows[0].id;
  }

  throw new Error(
    "No session found. Please start a conversation first or provide session_id explicitly.",
  );
}

export async function resolveExternalSessionId(
  externalId: string,
  pool: Pool,
): Promise<string | null> {
  try {
    const result = await pool.query(
      "SELECT id FROM session_map WHERE opencode_session_id = $1",
      [externalId],
    );
    if (result.rows.length > 0) return result.rows[0].id;
  } catch {
    // table may not exist
  }

  const legacy = await pool.query(
    "SELECT id FROM sessions WHERE external_id = $1",
    [externalId],
  );
  if (legacy.rows.length > 0) return legacy.rows[0].id;

  return null;
}

export async function resolveScopeToSessionIds(
  pool: Pool,
  baseSessionMapId: string,
  scope: string,
): Promise<string[]> {
  if (scope === "session") return [baseSessionMapId];

  if (scope === "task") {
    try {
      const taskResult = await pool.query(
        "SELECT omo_task_id FROM session_map WHERE id = $1",
        [baseSessionMapId],
      );
      if (taskResult.rows.length === 0 || !taskResult.rows[0].omo_task_id) {
        logger.warn(
          "scope=task but omo_task_id is NULL, falling back to current session",
        );
        return [baseSessionMapId];
      }
      const omoTaskId = taskResult.rows[0].omo_task_id;
      const sessionsResult = await pool.query(
        "SELECT id FROM session_map WHERE omo_task_id = $1",
        [omoTaskId],
      );
      const ids = sessionsResult.rows.map((r: any) => r.id);
      return ids.length > 0 ? ids : [baseSessionMapId];
    } catch {
      return [baseSessionMapId];
    }
  }

  if (scope === "project") {
    try {
      const projectResult = await pool.query(
        "SELECT project_id FROM session_map WHERE id = $1",
        [baseSessionMapId],
      );
      if (
        projectResult.rows.length === 0 ||
        !projectResult.rows[0].project_id
      ) {
        return [baseSessionMapId];
      }
      const projectId = projectResult.rows[0].project_id;
      const sessionsResult = await pool.query(
        "SELECT id FROM session_map WHERE project_id = $1",
        [projectId],
      );
      const ids = sessionsResult.rows.map((r: any) => r.id);
      return ids.length > 0 ? ids : [baseSessionMapId];
    } catch {
      return [baseSessionMapId];
    }
  }

  return [baseSessionMapId];
}

// ============================================================
// Filter builder
// ============================================================

export function buildFilterConditions(filters?: RecallMemoryInput["filters"]): {
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

  const sql = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  return { sql, params };
}

// ============================================================
// Context enrichment
// ============================================================

export async function enrichWithContext(
  facts: InternalFact[],
  sessionId: string,
  pool: Pool,
): Promise<InternalFact[]> {
  if (facts.length === 0) return facts;

  const sessionIds = new Set<string>();
  const topicIds = new Set<string>();

  for (const fact of facts) {
    if (fact._sessionId) sessionIds.add(fact._sessionId);
    if (fact._topicSegmentId) topicIds.add(fact._topicSegmentId);
  }

  const [sessionMap, topicMap] = await Promise.all([
    lookupSessions([...sessionIds], pool),
    lookupTopics([...topicIds], pool),
  ]);

  for (const fact of facts) {
    if (fact._sessionId && sessionMap.has(fact._sessionId)) {
      const s = sessionMap.get(fact._sessionId)!;
      fact._omoTaskId = fact._omoTaskId || s.omo_task_id;
      if (!fact._sessionId)
        fact._sessionId = s.opencode_session_id || fact._sessionId;
    }

    if (fact._topicSegmentId && topicMap.has(fact._topicSegmentId)) {
      const t = topicMap.get(fact._topicSegmentId)!;
      fact._topicSummary = t.summary;
    }

    if (!fact._timestamp) {
      fact._timestamp = fact.metadata.createdAt || new Date().toISOString();
    }
  }

  return facts;
}

async function lookupSessions(
  ids: string[],
  pool: Pool,
): Promise<
  Map<string, { opencode_session_id?: string; omo_task_id?: string }>
> {
  const map = new Map<
    string,
    { opencode_session_id?: string; omo_task_id?: string }
  >();
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
// Helpers: type mapping, data payload builder
// ============================================================

export function mapType(
  type: "entity" | "observation" | "reflection" | "relation" | "message",
): "entity" | "observation" | "reflection" | "relation" {
  if (type === "message") return "observation";
  if (type === "relation") return "relation";
  return type;
}

export function buildDataPayload(fact: InternalFact): Record<string, any> {
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

// ============================================================
// Parallel retrieve orchestration
// ============================================================

export async function parallelRetrieve(
  query: string,
  queryEmbedding: number[],
  sessionIds: string[],
  strategies: string[],
  pool: Pool,
  filters?: RecallMemoryInput["filters"],
): Promise<Map<string, InternalFact[]>> {
  const results = new Map<string, InternalFact[]>();
  const filterSQL = buildFilterConditions(filters);
  const promises: Promise<void>[] = [];
  const logger2 = createLogger("parallel-retrieve");

  if (strategies.includes("semantic")) {
    promises.push(
      (async () => {
        try {
          const r = await semanticSearch(
            queryEmbedding,
            sessionIds,
            pool,
            filterSQL,
          );
          results.set("semantic", r);
        } catch (err) {
          logger2.warn("Semantic search failed:", err);
          results.set("semantic", []);
        }
      })(),
    );
  }

  if (strategies.includes("bm25")) {
    promises.push(
      (async () => {
        try {
          const r = await bm25Search(query, sessionIds, pool, filterSQL);
          results.set("bm25", r);
        } catch (err) {
          logger2.warn("BM25 search failed:", err);
          results.set("bm25", []);
        }
      })(),
    );
  }

  if (strategies.includes("graph")) {
    promises.push(
      (async () => {
        try {
          const r = await graphTraversal(
            query,
            embeddingServiceFallback(query),
            sessionIds,
            pool,
            filterSQL,
          );
          results.set("graph", r);
        } catch (err) {
          logger2.warn("Graph traversal failed:", err);
          results.set("graph", []);
        }
      })(),
    );
  }

  if (strategies.includes("keyword")) {
    promises.push(
      (async () => {
        try {
          const r = await keywordSearch(query, sessionIds, pool, filterSQL);
          results.set("keyword", r);
        } catch (err) {
          logger2.warn("Keyword search failed:", err);
          results.set("keyword", []);
        }
      })(),
    );
  }

  await Promise.all(promises);
  return results;
}
