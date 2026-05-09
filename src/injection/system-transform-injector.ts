/**
 * system-transform-injector.ts
 *
 * 两路召回 + 混合排序的 memory injection 引擎。
 * 专用于 experimental.chat.system.transform 钩子。
 *
 * 设计参考：
 * - claude-mem 的 context-generator（SQLite → 注入 system prompt）
 * - OpenCode 官方文档：合并到 output.system[0]，禁止 push 新条目
 * - 混合策略：关键词召回（project 过滤） + 语义召回（pgvector ANN）
 *
 * 评分公式：
 *   score = vector_similarity × 0.5 + importance × 0.3 + recency_boost × 0.2
 */

import crypto from "node:crypto";
import { Pool } from "pg";
import { createLogger } from "../services/logger";

const logger = createLogger("system-transform-injector");

// ============================================================
// Embedding cache — prevent calling external API on every LLM call
// ============================================================

const embeddingCache = new Map<
  string,
  { hash: string; embedding: number[]; timestamp: number }
>();
const EMBEDDING_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedEmbedding(text: string): number[] | null {
  const hash = crypto.createHash("md5").update(text).digest("hex");
  const cached = embeddingCache.get(hash);
  if (cached && Date.now() - cached.timestamp < EMBEDDING_CACHE_TTL_MS) {
    return cached.embedding;
  }
  return null;
}

function setCachedEmbedding(text: string, embedding: number[]): void {
  const hash = crypto.createHash("md5").update(text).digest("hex");
  embeddingCache.set(hash, { hash, embedding, timestamp: Date.now() });
  // Evict old entries if cache grows too large
  if (embeddingCache.size > 50) {
    const oldest = [...embeddingCache.entries()].sort(
      ([, a], [, b]) => a.timestamp - b.timestamp,
    )[0];
    if (oldest) embeddingCache.delete(oldest[0]);
  }
}

/**
 * Estimate how much of the system prompt is "user content" vs "boilerplate instructions".
 * If the system prompt is mostly Agent instructions and has very little variable content,
 * skip semantic search entirely (cold start).
 */
function hasUserContent(systemPrompt: string): boolean {
  if (!systemPrompt || systemPrompt.length < 100) return false;
  // Check if there are memory injections from previous calls
  if (systemPrompt.includes("<pg_memory>")) return true;
  // If system prompt is very long, it likely has user content embedded
  if (systemPrompt.length > 2000) return true;
  return false;
}

// ============================================================
// Types
// ============================================================

export interface InjectionInput {
  /** The system prompt content being built (pre-transform) */
  systemPrompt: string;
  /** OpenCode session ID */
  sessionId?: string;
  /** Model context limit */
  contextLimit: number;
  /** Current project name (if available) */
  project?: string;
  /** Platform source (opencode, claude-code, cursor, etc.) */
  platformSource?: string;
}

export interface MemoryResult {
  id: string;
  type: "observation" | "reflection" | "entity";
  content: string;
  score: number;
  importance: number;
  project: string | null;
  createdAt: Date;
}

export interface InjectionConfig {
  /** Max tokens for injection block. Default: 2000 */
  maxTokens: number;
  /** Min score threshold. Default: 0.3 */
  minScore: number;
  /** Path A — keyword recall limit. Default: 20 */
  keywordLimit: number;
  /** Path B — semantic recall limit. Default: 20 */
  semanticLimit: number;
  /** Dedup window (chars). Default: 100 — observations with same prefix hash are deduped */
  dedupPrefixLength: number;
  /** Hybrid scoring weights: [semantic, importance, recency] */
  weights: [number, number, number];
  /** Recency half-life in days. Default: 2 (48h) */
  recencyHalfLifeDays: number;
}

const DEFAULT_INJECTION_CONFIG: InjectionConfig = {
  maxTokens: 2000,
  minScore: 0.3,
  keywordLimit: 20,
  semanticLimit: 20,
  dedupPrefixLength: 100,
  weights: [0.5, 0.3, 0.2],
  recencyHalfLifeDays: 2,
};

// ============================================================
// Scoring helpers
// ============================================================

export function computeRecencyBoost(
  createdAt: Date,
  halfLifeDays: number,
): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // Exponential decay: boost = 2^(-age / halfLife)
  return Math.pow(2, -ageDays / halfLifeDays);
}

export function hybridScore(
  vectorSimilarity: number | null,
  importance: number,
  recencyBoost: number,
  weights: [number, number, number],
): number {
  const [wSem, wImp, wRec] = weights;
  const sem = (vectorSimilarity ?? 0.5) * wSem;
  const imp = (importance / 5) * wImp; // normalize importance 1-5 → 0.2-1.0
  const rec = recencyBoost * wRec;
  return sem + imp + rec;
}

// ============================================================
// Content dedup helpers
// ============================================================

export function dedupKey(content: string, prefixLen: number): string {
  // Normalize whitespace first, then take prefix
  return content
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .substring(0, prefixLen);
}

export function dedup(
  results: MemoryResult[],
  prefixLen: number,
): MemoryResult[] {
  const seen = new Set<string>();
  const deduped: MemoryResult[] = [];
  for (const r of results) {
    const key = dedupKey(r.content, prefixLen);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  return deduped;
}

// ============================================================
// Token estimation
// ============================================================

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const totalChars = text.length;
  const chineseRatio = chineseChars / totalChars;
  if (chineseRatio > 0.5) {
    return Math.ceil(totalChars * 0.8);
  }
  return Math.ceil(totalChars / 4);
}

export function trimToTokenBudget(
  results: MemoryResult[],
  maxTokens: number,
): MemoryResult[] {
  let used = 0;
  const trimmed: MemoryResult[] = [];
  for (const r of results) {
    const tokens = estimateTokens(r.content);
    if (used + tokens > maxTokens) break;
    used += tokens;
    trimmed.push(r);
  }
  return trimmed;
}

// ============================================================
// Formatter
// ============================================================

export function formatInjectionBlock(
  memories: MemoryResult[],
  sessionSummary: string | null,
  project: string | null,
  economics?: {
    savingsEstimate: number;
    totalObservations: number;
    avgImportance: number;
    estimatedReadTokens: number;
  } | null,
): string {
  // Always render if we have project context, summary, or memories, or economics
  if (!project && memories.length === 0 && !sessionSummary && !economics)
    return "";

  const lines: string[] = [];
  lines.push("<pg_memory>");

  if (project) {
    lines.push(`project: ${project}`);
  }

  if (economics && economics.totalObservations > 0) {
    const savingsPct =
      economics.estimatedReadTokens > 0
        ? `${Math.round((economics.savingsEstimate / (economics.estimatedReadTokens + economics.savingsEstimate)) * 100)}%`
        : "N/A";
    lines.push(
      `economics: ${economics.totalObservations} obs | ${savingsPct} saved`,
    );
  }

  if (sessionSummary) {
    lines.push("");
    lines.push("<session_context>");
    lines.push(sessionSummary);
    lines.push("</session_context>");
  }

  if (memories.length > 0) {
    lines.push("");
    lines.push("<relevant_memories>");
    for (const m of memories) {
      const label =
        m.type === "reflection"
          ? "REFLECTION"
          : m.type === "entity"
            ? "ENTITY"
            : "OBSERVATION";
      const pct = (m.score * 100).toFixed(0);
      lines.push(`- [${label}] (${pct}%) ${m.content.substring(0, 300)}`);
    }
    lines.push("</relevant_memories>");
  }

  lines.push("</pg_memory>");
  return lines.join("\n");
}

// ============================================================
// Path A: Keyword recall (project-scoped, importance-sorted)
// ============================================================

async function keywordRecall(
  pool: Pool,
  project: string | undefined,
  limit: number,
): Promise<MemoryResult[]> {
  if (project) {
    // Project-scoped: top observations by importance + recency, last 90 days
    const { rows } = await pool.query(
      `
      SELECT o.id, o.tool_name, o.tool_input_summary, o.tool_output_summary,
             o.importance, o.created_at, o.source,
             sm.project_id
      FROM observations o
      LEFT JOIN session_map sm ON o.session_map_id = sm.id
      WHERE sm.project_id = $1
        AND o.importance >= 2
        AND o.created_at > NOW() - INTERVAL '90 days'
      ORDER BY o.importance DESC, o.created_at DESC
      LIMIT $2
      `,
      [project, limit],
    );
    return rows.map((row: any) => {
      const content = buildObservationContent(row);
      return {
        id: row.id,
        type: "observation" as const,
        content,
        score: row.importance / 5,
        importance: row.importance,
        project: row.project_id,
        createdAt: row.created_at,
      };
    });
  }

  // No project: global top observations from last 90 days
  const { rows } = await pool.query(
    `
    SELECT o.id, o.tool_name, o.tool_input_summary, o.tool_output_summary,
           o.importance, o.created_at, o.source,
           sm.project_id
    FROM observations o
    LEFT JOIN session_map sm ON o.session_map_id = sm.id
    WHERE o.importance >= 3
      AND o.created_at > NOW() - INTERVAL '90 days'
    ORDER BY o.importance DESC, o.created_at DESC
    LIMIT $1
    `,
    [limit],
  );
  return rows.map((row: any) => ({
    id: row.id,
    type: "observation" as const,
    content: buildObservationContent(row),
    score: row.importance / 5,
    importance: row.importance,
    project: row.project_id,
    createdAt: row.created_at,
  }));
}

function buildObservationContent(row: any): string {
  const parts: string[] = [];
  if (row.tool_name) parts.push(`[${row.tool_name}]`);
  if (row.tool_input_summary)
    parts.push(`input: ${row.tool_input_summary.substring(0, 100)}`);
  if (row.tool_output_summary)
    parts.push(`output: ${row.tool_output_summary.substring(0, 100)}`);
  if (row.source) parts.push(`(source: ${row.source})`);
  return parts.join(" ") || `observation ${row.id}`;
}

// ============================================================
// Path B: Semantic recall (pgvector ANN)
// ============================================================

async function semanticRecall(
  pool: Pool,
  embedding: number[],
  project: string | undefined,
  limit: number,
): Promise<MemoryResult[]> {
  if (!embedding || embedding.length === 0) return [];

  const vectorLit = `[${embedding.join(",")}]`;
  let query: string;
  let params: any[];

  if (project) {
    query = `
      SELECT o.id, o.tool_name, o.tool_input_summary, o.tool_output_summary,
             o.importance, o.created_at, o.source,
             sm.project_id,
             1 - (o.embedding <=> $1::vector) AS similarity
      FROM observations o
      LEFT JOIN session_map sm ON o.session_map_id = sm.id
      WHERE o.embedding IS NOT NULL
        AND sm.project_id = $2
      ORDER BY o.embedding <=> $1::vector
      LIMIT $3
    `;
    params = [vectorLit, project, limit];
  } else {
    query = `
      SELECT o.id, o.tool_name, o.tool_input_summary, o.tool_output_summary,
             o.importance, o.created_at, o.source,
             sm.project_id,
             1 - (o.embedding <=> $1::vector) AS similarity
      FROM observations o
      LEFT JOIN session_map sm ON o.session_map_id = sm.id
      WHERE o.embedding IS NOT NULL
      ORDER BY o.embedding <=> $1::vector
      LIMIT $2
    `;
    params = [vectorLit, limit];
  }

  const { rows } = await pool.query(query, params);
  return rows.map((row: any) => {
    const content = buildObservationContent(row);
    return {
      id: row.id,
      type: "observation" as const,
      content,
      score: Number(row.similarity) || 0,
      importance: row.importance,
      project: row.project_id,
      createdAt: row.created_at,
    };
  });
}

// ============================================================
// Session summary retrieval
// ============================================================

async function retrieveSessionSummary(
  pool: Pool,
  opencodeSessionId?: string,
): Promise<string | null> {
  if (!opencodeSessionId) return null;

  try {
    // First check session_summaries table
    const { rows } = await pool.query(
      `SELECT learned, completed, next_steps, request
       FROM session_summaries
       WHERE opencode_session_id = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [opencodeSessionId],
    );
    if (rows.length > 0) {
      const r = rows[0];
      const parts: string[] = [];
      if (r.request) parts.push(`request: ${r.request.substring(0, 200)}`);
      if (r.learned) parts.push(`learned: ${r.learned.substring(0, 300)}`);
      if (r.completed)
        parts.push(`completed: ${r.completed.substring(0, 200)}`);
      if (r.next_steps) parts.push(`next: ${r.next_steps.substring(0, 200)}`);
      return parts.length > 0 ? parts.join("\n") : null;
    }

    // Fallback: check reflections table (existing data)
    const { rows: refRows } = await pool.query(
      `SELECT summary FROM reflections
       WHERE session_map_id = (
         SELECT id FROM session_map WHERE opencode_session_id = $1 LIMIT 1
       )
       ORDER BY created_at DESC
       LIMIT 1`,
      [opencodeSessionId],
    );
    if (refRows.length > 0) {
      return `reflection: ${refRows[0].summary.substring(0, 500)}`;
    }

    return null;
  } catch (err) {
    logger.warn("Failed to retrieve session summary", err);
    return null;
  }
}

// ============================================================
// Embedding generation for the system prompt content
// ============================================================

async function generateQueryEmbedding(text: string): Promise<number[] | null> {
  if (!text || text.trim().length < 10) return null;

  // ── Check cache first ──
  const cached = getCachedEmbedding(text);
  if (cached) {
    logger.debug("Using cached embedding");
    return cached;
  }

  try {
    // API keys resolved from config: process.env → .env file → fallback
    const { getConfig, resolveEmbeddingApiKey, resolveConfig } =
      await import("../config");
    const cfg = getConfig();
    const provider = cfg.embeddingProvider;
    const model = cfg.embeddingModel;
    const apiKey = resolveEmbeddingApiKey(provider);
    const baseURL =
      provider === "deepseek"
        ? resolveConfig("DEEPSEEK_BASE_URL") || "https://api.deepseek.com"
        : undefined;

    if (!apiKey) {
      logger.warn("No API key for embedding — semantic recall disabled");
      return null;
    }

    const { OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey, baseURL });

    // ── Timeout: if embedding takes > 3s, fall back to keyword-only ──
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 3000),
    );
    const embedPromise = client.embeddings.create({
      model,
      input: text.substring(0, 8000),
    });

    const response = await Promise.race([embedPromise, timeoutPromise]);
    if (!response) {
      logger.warn("Embedding timed out (>3s) — using keyword-only recall");
      return null;
    }

    const embedding = response.data[0].embedding;
    setCachedEmbedding(text, embedding);
    return embedding;
  } catch (err) {
    logger.warn(
      "Embedding generation failed — falling back to keyword-only recall",
      err,
    );
    return null;
  }
}

// ============================================================
// Main entry: mixed two-path retrieval + hybrid scoring
// ============================================================

export async function retrieveMemoriesForInjection(
  input: InjectionInput,
  pool: Pool,
  config?: Partial<InjectionConfig>,
): Promise<{
  memories: MemoryResult[];
  summary: string | null;
  economics: {
    savingsEstimate: number;
    totalObservations: number;
    avgImportance: number;
    estimatedReadTokens: number;
  } | null;
}> {
  const cfg: InjectionConfig = { ...DEFAULT_INJECTION_CONFIG, ...config };

  // ── Path A: Keyword recall (always, fast, DB-only) ──
  const pathAResults = await keywordRecall(
    pool,
    input.project,
    cfg.keywordLimit,
  );

  // ── Path B: Semantic recall (skip on cold start, use cache if available) ──
  let pathBResults: MemoryResult[] = [];
  if (hasUserContent(input.systemPrompt)) {
    const embedding = await generateQueryEmbedding(input.systemPrompt);
    if (embedding) {
      pathBResults = await semanticRecall(
        pool,
        embedding,
        input.project,
        cfg.semanticLimit,
      );
    }
  } else {
    logger.debug("Cold start — skipping semantic recall, keyword only");
  }

  // ── Merge & hybrid score ──
  const merged = new Map<string, MemoryResult>();

  for (const r of pathAResults) {
    const key = dedupKey(r.content, cfg.dedupPrefixLength);
    const recencyBoost = computeRecencyBoost(
      r.createdAt,
      cfg.recencyHalfLifeDays,
    );
    const score = hybridScore(null, r.importance, recencyBoost, cfg.weights);
    merged.set(key, { ...r, score });
  }

  for (const r of pathBResults) {
    const key = dedupKey(r.content, cfg.dedupPrefixLength);
    const existing = merged.get(key);
    const recencyBoost = computeRecencyBoost(
      r.createdAt,
      cfg.recencyHalfLifeDays,
    );
    const score = hybridScore(r.score, r.importance, recencyBoost, cfg.weights);
    if (existing) {
      // Use max score from both paths
      merged.set(key, { ...existing, score: Math.max(existing.score, score) });
    } else {
      merged.set(key, { ...r, score });
    }
  }

  // ── Sort by score DESC ──
  let sorted = Array.from(merged.values())
    .filter((r) => r.score >= cfg.minScore)
    .sort((a, b) => b.score - a.score);

  // ── Dedup by content prefix ──
  sorted = dedup(sorted, cfg.dedupPrefixLength);

  // ── Trim to token budget ──
  sorted = trimToTokenBudget(sorted, cfg.maxTokens);

  // ── Retrieve session summary ──
  const summary = await retrieveSessionSummary(pool, input.sessionId);

  // ── Retrieve token economics ──
  let economics: {
    savingsEstimate: number;
    totalObservations: number;
    avgImportance: number;
    estimatedReadTokens: number;
  } | null = null;
  if (input.project) {
    try {
      const { rows } = await pool.query(
        `SELECT total_observations, avg_importance, estimated_read_tokens,
                estimated_discovery_tokens, savings_estimate
         FROM token_economics te
         JOIN session_map sm ON te.session_map_id = sm.id
         WHERE sm.project_id = $1
         ORDER BY te.calculated_at DESC
         LIMIT 1`,
        [input.project],
      );
      if (rows.length > 0) {
        economics = {
          savingsEstimate: rows[0].savings_estimate || 0,
          totalObservations: rows[0].total_observations || 0,
          avgImportance: rows[0].avg_importance || 0,
          estimatedReadTokens: rows[0].estimated_read_tokens || 0,
        };
      }
    } catch {
      // Non-fatal: economics is optional
    }
  }

  logger.info(
    `Injection: ${sorted.length} memories + ${summary ? "summary" : "no summary"}${economics ? " + economics" : ""}`,
  );

  return { memories: sorted, summary, economics };
}

/**
 * Build the injection block string for system prompt merging.
 */
export async function buildInjectionBlock(
  input: InjectionInput,
  pool: Pool,
  config?: Partial<InjectionConfig>,
): Promise<string> {
  const { memories, summary, economics } = await retrieveMemoriesForInjection(
    input,
    pool,
    config,
  );
  return formatInjectionBlock(
    memories,
    summary,
    input.project ?? null,
    economics ?? null,
  );
}
