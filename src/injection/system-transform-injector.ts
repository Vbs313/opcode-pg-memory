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

// Types and scoring helpers — extracted to ranking.ts (single source of truth)
import {
  type MemoryResult,
  type InjectionConfig,
  type InjectionInput,
  type CausalChain,
  DEFAULT_INJECTION_CONFIG,
  computeRecencyBoost,
  hybridScore,
  dedupKey,
  dedup,
  trimToTokenBudget,
  formatInjectionBlock,
  hasUserContent,
  buildObservationContent,
  keywordRecall,
  semanticRecall,
  retrieveSessionSummary,
  retrieveCausalChains,
} from "./ranking";
import { getProjectSkeleton } from "./skeleton-injector";

// Re-export for backward compatibility (consumers still import from this file)
export {
  type MemoryResult,
  type InjectionConfig,
  type InjectionInput,
  type CausalChain,
  DEFAULT_INJECTION_CONFIG,
  computeRecencyBoost,
  hybridScore,
  dedupKey,
  dedup,
  estimateTokens,
  trimToTokenBudget,
  formatInjectionBlock,
} from "./ranking";

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

// ============================================================
// Active Rules (v3.9+)
// ============================================================

interface ActiveRule {
  pattern_type: string;
  summary: string;
  action_plan: any;
  applied_at: string;
}

/**
 * 从 reflections 表读取已应用的规则。
 * 按 applied_at DESC 取前 5 条（避免注入膨胀）。
 */
async function fetchActiveRules(pool: Pool): Promise<ActiveRule[]> {
  try {
    const { rows } = await pool.query(
      `SELECT pattern_type, summary, action_plan, applied_at
       FROM reflections
       WHERE applied_at IS NOT NULL AND action_plan IS NOT NULL
       ORDER BY applied_at DESC
       LIMIT 5`,
    );
    return rows;
  } catch (err) {
    logger.warn("Failed to fetch active rules:", err);
    return [];
  }
}

// ============================================================
// Path A + B + Session: keywordRecall, semanticRecall, retrieveSessionSummary
// are imported from ranking.ts (single source of truth)
// ============================================================

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
      resolveConfig("OPENAI_BASE_URL") || "https://api.openai.com/v1";

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
  // 含 reflections 检索（模式化知识比 raw observation 更有跨项目价值）
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

    // 全局 reflections 检索（模式化知识，跨项目价值最高）
    try {
      const { rows: refRows } = await pool.query(
        `SELECT id, summary, pattern_type, confidence, created_at
         FROM reflections
         WHERE confidence >= 0.6
         ORDER BY confidence DESC, created_at DESC
         LIMIT $1`,
        [cfg.keywordLimit],
      );
      for (const r of refRows) {
        globalPaths.push({
          id: r.id,
          type: "reflection" as const,
          content: `[${r.pattern_type || "insight"}] ${r.summary.substring(0, 300)}`,
          score: r.confidence,
          importance: Math.round(r.confidence * 5),
          project: null,
          createdAt: r.created_at,
        });
      }
    } catch {
      /* non-fatal */
    }

    // 全局 entities 检索（技术术语、模式名称等结构化知识）
    try {
      const { rows: entRows } = await pool.query(
        `SELECT id, name, type, description, weight, LEAST(weight / 10, 1.0) AS score
           FROM entities
           WHERE weight >= 5  -- 高频或重要的实体
           ORDER BY weight DESC
           LIMIT $1`,
        [cfg.keywordLimit],
      );
      for (const r of entRows) {
        globalPaths.push({
          id: r.id,
          type: "entity" as const,
          content: `${r.name}${r.description ? `: ${r.description.substring(0, 200)}` : ""} (${r.type})`,
          score: r.score,
          importance: Math.round(r.weight),
          project: null,
          createdAt: new Date(),
        });
      }
    } catch {
      /* non-fatal */
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

  // v3.9+: fetch applied rules from reflections table
  const activeRules = await fetchActiveRules(pool);

  // v3.11+: project skeleton — top files known from entity extraction
  const skeleton = input.project
    ? await getProjectSkeleton(input.project, pool)
    : null;

  return formatInjectionBlock(
    memories,
    summary,
    input.project ?? null,
    economics ?? null,
    chains ?? null,
    activeRules,
    skeleton,
  );
}
