/**
 * ranking.ts
 *
 * Two-path recall + hybrid scoring pipeline. Extracted from system-transform-injector.
 *
 * Scoring formula: score = vector_similarity × 0.5 + importance × 0.3 + recency_boost × 0.2
 */
import crypto from "node:crypto";
import { Pool } from "pg";
import { createLogger } from "../services/logger";
import { getObservations } from "../services/short-term-memory";
import { getQueueLength } from "../services/memory-buffer";

const logger = createLogger("ranking");

// ============================================================
// Types
// ============================================================

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
  maxTokens: number;
  minScore: number;
  keywordLimit: number;
  semanticLimit: number;
  dedupPrefixLength: number;
  weights: [number, number, number];
  recencyHalfLifeDays: number;
}

export interface CausalChain {
  chainId: string;
  cause: { toolName: string; summary: string; createdAt: Date };
  fix: { toolName: string; summary: string; createdAt: Date };
}

export const DEFAULT_INJECTION_CONFIG: InjectionConfig = {
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
  const imp = (importance / 5) * wImp;
  const rec = recencyBoost * wRec;
  return sem + imp + rec;
}

// ============================================================
// Content dedup helpers
// ============================================================

export function dedupKey(content: string, prefixLen: number): string {
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
  if (chineseRatio > 0.5) return Math.ceil(totalChars * 0.8);
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
// Result compression
// ============================================================

function compressObservation(content: string): string {
  if (!content || content.length < 60) return content;
  const outputMatch = content.match(/(?:output|→)\s*(.+)/);
  if (outputMatch && outputMatch[1].trim().length > 5) {
    return outputMatch[1].trim().substring(0, 200);
  }
  const inputMatch = content.match(/input:\s*(.+?)(?:\s+output:|$)/);
  if (inputMatch) return inputMatch[1].trim().substring(0, 200);
  const parts = content.split(/\s{2,}/);
  return (
    parts[parts.length - 1]?.substring(0, 200) || content.substring(0, 200)
  );
}

// ============================================================
// Cold start detection
// ============================================================

export function hasUserContent(systemPrompt: string): boolean {
  if (!systemPrompt || systemPrompt.length < 100) return false;
  if (systemPrompt.includes("<pg_memory>")) return true;
  if (systemPrompt.length > 2000) return true;
  return false;
}

// ============================================================
// Retrieval helpers
// ============================================================

export function buildObservationContent(row: any): string {
  const parts: string[] = [];
  if (row.tool_name) parts.push(`[${row.tool_name}]`);
  if (row.tool_input_summary)
    parts.push(`input: ${row.tool_input_summary.substring(0, 100)}`);
  if (row.tool_output_summary)
    parts.push(`output: ${row.tool_output_summary.substring(0, 100)}`);
  if (row.source) parts.push(`(source: ${row.source})`);
  return parts.join(" ") || `observation ${row.id}`;
}

export async function keywordRecall(
  pool: Pool,
  project: string | undefined,
  limit: number,
): Promise<MemoryResult[]> {
  if (project) {
    const { rows } = await pool.query(
      `SELECT o.id, o.tool_name, o.tool_input_summary, o.tool_output_summary,
              o.importance, o.created_at, o.source, sm.project_id
       FROM observations o LEFT JOIN session_map sm ON o.session_map_id = sm.id
       WHERE sm.project_id = $1 AND o.importance >= 2
         AND o.created_at > NOW() - INTERVAL '90 days'
       ORDER BY o.importance DESC, o.created_at DESC LIMIT $2`,
      [project, limit],
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
  const { rows } = await pool.query(
    `SELECT o.id, o.tool_name, o.tool_input_summary, o.tool_output_summary,
            o.importance, o.created_at, o.source, sm.project_id
     FROM observations o LEFT JOIN session_map sm ON o.session_map_id = sm.id
     WHERE o.importance >= 3 AND o.created_at > NOW() - INTERVAL '90 days'
     ORDER BY o.importance DESC, o.created_at DESC LIMIT $1`,
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

export async function semanticRecall(
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
    query = `SELECT o.id, o.tool_name, o.tool_input_summary, o.tool_output_summary,
                    o.importance, o.created_at, o.source, sm.project_id,
                    1 - (o.embedding <=> $1::vector) AS similarity
             FROM observations o LEFT JOIN session_map sm ON o.session_map_id = sm.id
             WHERE o.embedding IS NOT NULL AND sm.project_id = $2
             ORDER BY o.embedding <=> $1::vector LIMIT $3`;
    params = [vectorLit, project, limit];
  } else {
    query = `SELECT o.id, o.tool_name, o.tool_input_summary, o.tool_output_summary,
                    o.importance, o.created_at, o.source, sm.project_id,
                    1 - (o.embedding <=> $1::vector) AS similarity
             FROM observations o LEFT JOIN session_map sm ON o.session_map_id = sm.id
             WHERE o.embedding IS NOT NULL
             ORDER BY o.embedding <=> $1::vector LIMIT $2`;
    params = [vectorLit, limit];
  }
  const { rows } = await pool.query(query, params);
  return rows.map((row: any) => ({
    id: row.id,
    type: "observation" as const,
    content: buildObservationContent(row),
    score: Number(row.similarity) || 0,
    importance: row.importance,
    project: row.project_id,
    createdAt: row.created_at,
  }));
}

export async function retrieveSessionSummary(
  pool: Pool,
  opencodeSessionId?: string,
): Promise<string | null> {
  if (!opencodeSessionId) return null;
  try {
    const { rows } = await pool.query(
      `SELECT learned, completed, next_steps, request FROM session_summaries
       WHERE opencode_session_id = $1 ORDER BY updated_at DESC LIMIT 1`,
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
    const { rows: refRows } = await pool.query(
      `SELECT summary FROM reflections
       WHERE session_map_id = (SELECT id FROM session_map WHERE opencode_session_id = $1 LIMIT 1)
       ORDER BY created_at DESC LIMIT 1`,
      [opencodeSessionId],
    );
    if (refRows.length > 0)
      return `reflection: ${refRows[0].summary.substring(0, 500)}`;
    return null;
  } catch (err) {
    logger.warn("Failed to retrieve session summary", err);
    return null;
  }
}

export async function retrieveCausalChains(
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
       FROM observations c JOIN observations f ON c.causal_chain_id = f.causal_chain_id
       LEFT JOIN session_map sm ON c.session_map_id = sm.id
       WHERE c.causal_role = 'cause' AND f.causal_role = 'fix'
         AND sm.project_id = $1 AND c.created_at > NOW() - INTERVAL '90 days'
       ORDER BY c.created_at DESC LIMIT 5`,
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

// ============================================================
// Injection input type (used by both coordinator and ranking)
// ============================================================

export interface InjectionInput {
  systemPrompt: string;
  sessionId?: string;
  contextLimit: number;
  project?: string;
  platformSource?: string;
}

// ============================================================
// rankAndFilterFacts — main two-path recall + hybrid scoring pipeline
// ============================================================

/**
 * Core retrieval + ranking pipeline. Performs two-path recall (keyword + semantic),
 * hybrid scoring, dedup, global fallback, and token-budget trimming.
 *
 * @param embedFn — callback to generate text embeddings (coordinator provides the cached version)
 */
export async function rankAndFilterFacts(
  input: InjectionInput,
  pool: Pool,
  config: Partial<InjectionConfig> | undefined,
  embedFn: (text: string) => Promise<number[] | null>,
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

  // Short-term memory: zero-latency, no PG query
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
      return { memories, summary: null, economics: null, chains: [] };
    }
  }

  // Path A: Keyword recall (always, fast, DB-only)
  const pathAResults = await keywordRecall(
    pool,
    input.project,
    cfg.keywordLimit,
  );

  // Path B: Semantic recall (skip on cold start, use embedding if available)
  let pathBResults: MemoryResult[] = [];
  if (hasUserContent(input.systemPrompt)) {
    const embedding = await embedFn(input.systemPrompt);
    if (embedding) {
      pathBResults = await semanticRecall(
        pool,
        embedding,
        input.project,
        cfg.semanticLimit,
      );
    }
  }

  // Merge & hybrid score
  const merged = new Map<string, MemoryResult>();
  for (const r of pathAResults) {
    const key = dedupKey(r.content, cfg.dedupPrefixLength);
    const recencyBoost = computeRecencyBoost(
      r.createdAt,
      cfg.recencyHalfLifeDays,
    );
    merged.set(key, {
      ...r,
      score: hybridScore(null, r.importance, recencyBoost, cfg.weights),
    });
  }
  for (const r of pathBResults) {
    const key = dedupKey(r.content, cfg.dedupPrefixLength);
    const existing = merged.get(key);
    const recencyBoost = computeRecencyBoost(
      r.createdAt,
      cfg.recencyHalfLifeDays,
    );
    const score = hybridScore(r.score, r.importance, recencyBoost, cfg.weights);
    if (existing)
      merged.set(key, { ...existing, score: Math.max(existing.score, score) });
    else merged.set(key, { ...r, score });
  }

  let sorted = Array.from(merged.values())
    .filter((r) => r.score >= cfg.minScore)
    .sort((a, b) => b.score - a.score);
  sorted = dedup(sorted, cfg.dedupPrefixLength);

  // Global fallback: if project recall is too sparse (<3), broaden to global
  if (input.project && sorted.length < 3) {
    logger.debug("Project recall too sparse — trying global fallback");
    const globalKW = await keywordRecall(pool, undefined, cfg.keywordLimit);
    const globalPaths: MemoryResult[] = [];
    if (hasUserContent(input.systemPrompt)) {
      const emb = await embedFn(input.systemPrompt);
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
    // Global reflections
    try {
      const { rows: refRows } = await pool.query(
        `SELECT id, summary, pattern_type, confidence, created_at FROM reflections
         WHERE confidence >= 0.6 ORDER BY confidence DESC, created_at DESC LIMIT $1`,
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
    // Global entities
    try {
      const { rows: entRows } = await pool.query(
        `SELECT id, name, type, description, weight, LEAST(weight / 10, 1.0) AS score
         FROM entities WHERE weight >= 5 ORDER BY weight DESC LIMIT $1`,
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
    // Merge global results (skip dups already in sorted)
    const existingIds = new Set(sorted.map((m) => m.id));
    for (const r of [...globalKW, ...globalPaths]) {
      if (existingIds.has(r.id)) continue;
      const key = dedupKey(r.content, cfg.dedupPrefixLength);
      const rec = computeRecencyBoost(r.createdAt, cfg.recencyHalfLifeDays);
      merged.set(key, {
        ...r,
        score: hybridScore(null, r.importance, rec, cfg.weights),
      });
      existingIds.add(r.id);
    }
    sorted = Array.from(merged.values())
      .filter((r) => r.score >= cfg.minScore)
      .sort((a, b) => b.score - a.score);
    sorted = dedup(sorted, cfg.dedupPrefixLength);
    logger.info(
      `Global fallback added ${sorted.length} cross-project memories`,
    );
  }

  // Trim to token budget
  sorted = trimToTokenBudget(sorted, cfg.maxTokens);

  // Session summary
  const summary = await retrieveSessionSummary(pool, input.sessionId);

  // Token economics
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
         FROM token_economics te JOIN session_map sm ON te.session_map_id = sm.id
         WHERE sm.project_id = $1 ORDER BY te.calculated_at DESC LIMIT 1`,
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
      /* non-fatal */
    }
  }

  // Causal chains
  let chains: CausalChain[] = [];
  if (input.project) chains = await retrieveCausalChains(pool, input.project);

  logger.info(
    `Injection: ${sorted.length} memories${summary ? " + summary" : ""}${economics ? " + economics" : ""}${chains.length > 0 ? ` + ${chains.length} chains` : ""}`,
  );
  return { memories: sorted, summary, economics, chains };
}

// ============================================================
// formatInjectionBlock — renders the pg_memory XML injection block
// ============================================================

interface ActiveRule {
  pattern_type: string;
  summary: string;
  action_plan: any;
  applied_at: string;
}

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
  activeRules?: ActiveRule[] | null,
  skeleton?: string | null,
): string {
  if (
    !project &&
    memories.length === 0 &&
    !sessionSummary &&
    !economics &&
    (!chains || chains.length === 0) &&
    (!activeRules || activeRules.length === 0) &&
    !skeleton
  )
    return "";

  const lines: string[] = [];
  lines.push("<pg_memory>");
  lines.push("## Memory System");

  const bufferLen = getQueueLength();
  const oldestAge =
    memories.length > 0
      ? Math.round(
          (Date.now() -
            Math.max(...memories.map((m) => m.createdAt.getTime()))) /
            3600000,
        )
      : 0;

  if (bufferLen > 5) {
    lines.push("⚠️ MEMORY IN DEGRADED MODE");
    lines.push(
      "PostgreSQL is under load. " + bufferLen + " recent observations are",
    );
    lines.push(
      "buffered and not yet searchable. Older memories below are complete.",
    );
  }
  lines.push(
    "Context from previous sessions is injected below. Use it as reference,",
  );
  lines.push("not authority — project constraints may have changed.");
  if (oldestAge > 72) {
    lines.push(
      `(Oldest memory shown is from ${oldestAge}h ago — project may have changed.)`,
    );
  }
  lines.push("Guidelines:");
  lines.push("- >= 80%: high confidence, treat as confirmed knowledge");
  lines.push("- 60-79%: moderate confidence, cross-check before acting");
  lines.push("- < 60%: low confidence, treat as hint, verify independently");

  if (project) lines.push(`project: ${project}`);
  if (skeleton) lines.push(`project skeleton: ${skeleton}`);

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
      lines.push(
        `- [${ch.cause.toolName}] ❌ ${ch.cause.summary.substring(0, 100)}`,
      );
      lines.push(
        `  [${ch.fix.toolName}] ✅ ${ch.fix.summary.substring(0, 100)}`,
      );
    }
  }

  if (activeRules && activeRules.length > 0) {
    lines.push("");
    lines.push("### Active Rules");
    for (const rule of activeRules) {
      const trigger = rule.action_plan?.trigger;
      const action = rule.action_plan?.action;
      if (trigger?.tool) {
        const markers = trigger.output_contains?.length
          ? ` (output: ${trigger.output_contains.join(", ")})`
          : "";
        lines.push(`- When \`${trigger.tool}\`${markers}:`);
      }
      if (action?.content)
        lines.push(`  → ${action.content.substring(0, 120)}`);
      else lines.push(`  → ${rule.summary.substring(0, 120)}`);
    }
    lines.push(
      "  (These rules are persisted in rules.md — you may follow them automatically.)",
    );
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
      lines.push(`- [${label}] (${pct}%) ${compressObservation(m.content)}`);
    }
    lines.push("</relevant_memories>");
  }

  lines.push("</pg_memory>");
  return lines.join("\n");
}
