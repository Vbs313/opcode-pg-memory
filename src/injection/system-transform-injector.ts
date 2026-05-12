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
import { getObservations } from "../services/short-term-memory";
import { getQueueLength } from "../services/memory-buffer";

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
  chains?: CausalChain[] | null,
): string {
  if (
    !project &&
    memories.length === 0 &&
    !sessionSummary &&
    !economics &&
    (!chains || chains.length === 0)
  )
    return "";

  const lines: string[] = [];
  lines.push("<pg_memory>");

  // ── Meta-cognition header — dynamic based on system state ──
  const bufferLen = getQueueLength();
  const oldestAge =
    memories.length > 0
      ? Math.round(
          (Date.now() -
            Math.max(...memories.map((m) => m.createdAt.getTime()))) /
            3600000,
        )
      : 0;

  lines.push("## Memory System");

  // Degraded mode
  if (bufferLen > 5) {
    lines.push("⚠️ MEMORY IN DEGRADED MODE");
    lines.push(
      `PostgreSQL is under load. ${bufferLen} recent observations are`,
    );
    lines.push(
      "buffered and not yet searchable. Older memories below are complete.",
    );
  }

  // Base guidance
  lines.push(
    "Context from previous sessions is injected below. Use it as reference,",
  );
  lines.push("not authority — project constraints may have changed.");

  // Staleness warning
  if (oldestAge > 72) {
    lines.push(
      `(Oldest memory shown is from ${oldestAge}h ago — project may have changed.)`,
    );
  }

  lines.push("Guidelines:");
  lines.push("- >= 80%: high confidence, treat as confirmed knowledge");
  lines.push("- 60-79%: moderate confidence, cross-check before acting");
  lines.push("- < 60%: low confidence, treat as hint, verify independently");

  if (project) {
    lines.push(`project: ${project}`);
  }

  if (economics && economics.totalObservations > 0) {
    const savingsPct =
      economics.estimatedReadTokens > 0
        ? `${Math.round((economics.savingsEstimate / (economics.estimatedReadTokens + economics.savingsEstimate)) * 100)}%`
        : "N/A";
    lines.push(
      `economics: ${economics.totalObservations} obs · ${savingsPct} saved`,
    );
  }

  if (sessionSummary) {
    lines.push("");
    lines.push("### Session Summary");
    lines.push(sessionSummary);
  }

  if (chains && chains.length > 0) {
    lines.push("");
    lines.push("### Causal Chains");
    for (const ch of chains) {
      const cause = ch.cause.summary.substring(0, 100);
      const fix = ch.fix.summary.substring(0, 100);
      lines.push(`- [${ch.cause.toolName}] ❌ ${cause}`);
      lines.push(`  [${ch.fix.toolName}] ✅ ${fix}`);
    }
  }

  if (memories.length > 0) {
    lines.push("");
    lines.push("### Relevant Memories");
    for (const m of memories) {
      const label =
        m.type === "reflection"
          ? "REFLECTION"
          : m.type === "entity"
            ? "ENTITY"
            : "OBSERVATION";
      const pct = (m.score * 100).toFixed(0);
      // ── Compress: show only the key insight, not raw text ──
      const compressed = compressObservation(m.content);
      lines.push(`- [${label}] (${pct}%) ${compressed}`);
    }
    lines.push("</relevant_memories>");
  }

  lines.push("</pg_memory>");
  return lines.join("\n");
}

/**
 * Compress raw observation text into a concise narrative.
 * Strips redundant prefixes, focuses on the output/result.
 */
function compressObservation(content: string): string {
  if (!content || content.length < 60) return content;
  // Extract the output part (after "output:" or "→")
  const outputMatch = content.match(/(?:output|→)\s*(.+)/);
  if (outputMatch && outputMatch[1].trim().length > 5) {
    // Prefer output summary — it's the actual result
    return outputMatch[1].trim().substring(0, 200);
  }
  // Extract the input part (after "input:")
  const inputMatch = content.match(/input:\s*(.+?)(?:\s+output:|$)/);
  if (inputMatch) {
    return inputMatch[1].trim().substring(0, 200);
  }
  // Fallback: just take the last meaningful part
  const parts = content.split(/\s{2,}/);
  return (
    parts[parts.length - 1]?.substring(0, 200) || content.substring(0, 200)
  );
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
  chains: CausalChain[];
}> {
  const cfg: InjectionConfig = { ...DEFAULT_INJECTION_CONFIG, ...config };

  // ── Short-term memory: zero-latency, no PG query ──
  if (input.sessionId) {
    const shortTerm = getObservations(input.sessionId);
    if (shortTerm.length > 0) {
      const memories: MemoryResult[] = shortTerm.map((obs) => ({
        id: obs.id,
        type: "observation" as const,
        content: obs.summary,
        score: obs.importance / 5,
        importance: obs.importance,
        project: input.project ?? null,
        createdAt: obs.timestamp,
      }));
      logger.debug(
        `Short-term memory hit: ${memories.length} observations (no PG query)`,
      );
      return { memories, summary: null, economics: null, chains: [] };
    }
    logger.debug("Short-term memory empty — falling back to PG recall");
  }

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

  // ── Global fallback: 新项目跨会话记忆 ──
  // 如果项目级召回结果太少（<3条），降级到全局检索（不按项目过滤）
  if (input.project && sorted.length < 3) {
    logger.debug("Project recall too sparse — trying global fallback");
    const globalKW = await keywordRecall(pool, undefined, cfg.keywordLimit);
    const globalPaths: MemoryResult[] = [];
    if (hasUserContent(input.systemPrompt)) {
      const emb = await generateQueryEmbedding(input.systemPrompt);
      if (emb) {
        const sem = await semanticRecall(
          pool,
          emb,
          undefined,
          cfg.semanticLimit,
        );
        globalPaths.push(...sem);
      }
    }

    // 合并全局结果（排除已经在 sorted 里的）
    const existingIds = new Set(sorted.map((m) => m.id));
    for (const r of [...globalKW, ...globalPaths]) {
      if (existingIds.has(r.id)) continue;
      const key = dedupKey(r.content, cfg.dedupPrefixLength);
      const rec = computeRecencyBoost(r.createdAt, cfg.recencyHalfLifeDays);
      const s = hybridScore(null, r.importance, rec, cfg.weights);
      merged.set(key, { ...r, score: s });
      existingIds.add(r.id);
    }

    // 重新排序
    sorted = Array.from(merged.values())
      .filter((r) => r.score >= cfg.minScore)
      .sort((a, b) => b.score - a.score);
    sorted = dedup(sorted, cfg.dedupPrefixLength);
    logger.info(
      `Global fallback added ${sorted.length} cross-project memories`,
    );
  }

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

  // ── Retrieve causal chains ──
  let chains: CausalChain[] = [];
  if (input.project) {
    chains = await retrieveCausalChains(pool, input.project);
  }

  logger.info(
    `Injection: ${sorted.length} memories${summary ? " + summary" : ""}${economics ? " + economics" : ""}${chains.length > 0 ? ` + ${chains.length} chains` : ""}`,
  );

  return { memories: sorted, summary, economics, chains };
}

export interface CausalChain {
  chainId: string;
  cause: { toolName: string; summary: string; createdAt: Date };
  fix: { toolName: string; summary: string; createdAt: Date };
}

async function retrieveCausalChains(
  pool: Pool,
  project: string,
): Promise<CausalChain[]> {
  try {
    const { rows } = await pool.query(
      `SELECT c.causal_chain_id,
              c.tool_name AS cause_tool, c.tool_input_summary AS cause_input,
              c.tool_output_summary AS cause_output, c.created_at AS cause_time,
              f.tool_name AS fix_tool, f.tool_input_summary AS fix_input,
              f.tool_output_summary AS fix_output, f.created_at AS fix_time
       FROM observations c
       JOIN observations f ON c.causal_chain_id = f.causal_chain_id
       LEFT JOIN session_map sm ON c.session_map_id = sm.id
       WHERE c.causal_role = 'cause'
         AND f.causal_role = 'fix'
         AND sm.project_id = $1
         AND c.created_at > NOW() - INTERVAL '90 days'
       ORDER BY c.created_at DESC
       LIMIT 5`,
      [project],
    );
    return rows.map((r: any) => ({
      chainId: r.causal_chain_id,
      cause: {
        toolName: r.cause_tool,
        summary: r.cause_output || r.cause_input || "",
        createdAt: r.cause_time,
      },
      fix: {
        toolName: r.fix_tool,
        summary: r.fix_output || r.fix_input || "",
        createdAt: r.fix_time,
      },
    }));
  } catch {
    return [];
  }
}

/**
 * Build the injection block string for system prompt merging.
 */
export async function buildInjectionBlock(
  input: InjectionInput,
  pool: Pool,
  config?: Partial<InjectionConfig>,
): Promise<string> {
  const { memories, summary, economics, chains } =
    await retrieveMemoriesForInjection(input, pool, config);
  return formatInjectionBlock(
    memories,
    summary,
    input.project ?? null,
    economics ?? null,
    chains ?? null,
  );
}
