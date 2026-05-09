/**
 * observation-scorer.ts
 *
 * Scores and ranks observations per session for token economics.
 * Calculates quality metrics and maintains the token_economics table.
 */

import { Pool } from "pg";
import { createLogger } from "../services/logger";
import { getConfig, resolveEmbeddingApiKey, resolveConfig } from "../config";

const logger = createLogger("observation-scorer");

// ============================================================
// Scoring configuration
// ============================================================

export interface ScorerConfig {
  /** Importance weight in quality score (0-1). Default: 0.4 */
  importanceWeight: number;
  /** Recency weight (0-1). Default: 0.3 */
  recencyWeight: number;
  /** Completeness weight (has output/embedding). Default: 0.3 */
  completenessWeight: number;
  /** Recency half-life in days. Default: 7 */
  recencyHalfLifeDays: number;
  /** Min observations to calculate economics. Default: 5 */
  minObservationsForEconomics: number;
  /** Max observations to consider for scoring (recent N). Default: 1000 */
  maxScoredObservations: number;
}

const DEFAULT_SCORER_CONFIG: ScorerConfig = {
  importanceWeight: 0.4,
  recencyWeight: 0.3,
  completenessWeight: 0.3,
  recencyHalfLifeDays: 7,
  minObservationsForEconomics: 5,
  maxScoredObservations: 1000,
};

// ============================================================
// Types
// ============================================================

export interface ObservationScore {
  id: string;
  qualityScore: number;
  importance: number;
  recencyScore: number;
  completenessScore: number;
  daysOld: number;
  hasEmbedding: boolean;
  hasOutput: boolean;
}

export interface SessionEconomics {
  sessionMapId: string;
  totalObservations: number;
  avgImportance: number;
  estimatedReadTokens: number;
  estimatedDiscoveryTokens: number;
  savingsEstimate: number;
}

// ============================================================
// Scoring logic
// ============================================================

function computeRecencyScore(createdAt: Date, halfLifeDays: number): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(2, -ageDays / halfLifeDays);
}

function computeCompletenessScore(
  hasOutputSummary: boolean,
  hasEmbedding: boolean,
): number {
  let score = 0;
  if (hasOutputSummary) score += 0.6;
  if (hasEmbedding) score += 0.4;
  return score;
}

function estimateReadTokens(
  inputSummary: string | null,
  outputSummary: string | null,
): number {
  let total = 0;
  if (inputSummary) total += inputSummary.length / 4;
  if (outputSummary) total += outputSummary.length / 4;
  return Math.ceil(total);
}

// ============================================================
// Score all observations in a session
// ============================================================

export async function scoreSessionObservations(
  sessionMapId: string,
  pool: Pool,
  config?: Partial<ScorerConfig>,
): Promise<ObservationScore[]> {
  const cfg: ScorerConfig = { ...DEFAULT_SCORER_CONFIG, ...config };

  try {
    const { rows } = await pool.query(
      `SELECT id, importance, tool_input_summary, tool_output_summary,
              created_at,
              embedding IS NOT NULL AS has_embedding
       FROM observations
       WHERE session_map_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [sessionMapId, cfg.maxScoredObservations],
    );

    const scores: ObservationScore[] = rows.map((row: any) => {
      const daysOld =
        (Date.now() - new Date(row.created_at).getTime()) /
        (1000 * 60 * 60 * 24);
      const recencyScore = computeRecencyScore(
        row.created_at,
        cfg.recencyHalfLifeDays,
      );
      const completenessScore = computeCompletenessScore(
        !!row.tool_output_summary,
        row.has_embedding,
      );
      const qualityScore =
        (row.importance / 5) * cfg.importanceWeight +
        recencyScore * cfg.recencyWeight +
        completenessScore * cfg.completenessWeight;

      return {
        id: row.id,
        qualityScore: Math.round(qualityScore * 100) / 100,
        importance: row.importance,
        recencyScore: Math.round(recencyScore * 100) / 100,
        completenessScore: Math.round(completenessScore * 100) / 100,
        daysOld: Math.round(daysOld * 10) / 10,
        hasEmbedding: row.has_embedding,
        hasOutput: !!row.tool_output_summary,
      };
    });

    // Sort by quality score descending
    scores.sort((a, b) => b.qualityScore - a.qualityScore);
    return scores;
  } catch (error) {
    logger.error("Failed to score session observations", error);
    return [];
  }
}

// ============================================================
// Calculate and persist token economics for a session
// ============================================================

export async function calculateTokenEconomics(
  sessionMapId: string,
  pool: Pool,
  config?: Partial<ScorerConfig>,
): Promise<SessionEconomics | null> {
  const cfg: ScorerConfig = { ...DEFAULT_SCORER_CONFIG, ...config };

  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS total,
              COALESCE(AVG(importance), 0) AS avg_imp,
              SUM(
                COALESCE(LENGTH(tool_input_summary), 0)
                + COALESCE(LENGTH(tool_output_summary), 0)
              ) AS total_chars
       FROM observations
       WHERE session_map_id = $1`,
      [sessionMapId],
    );

    if (rows.length === 0) return null;

    const total = parseInt(rows[0].total, 10);
    if (total < cfg.minObservationsForEconomics) return null;

    const avgImportance = parseFloat(rows[0].avg_imp);
    const totalChars = parseInt(rows[0].total_chars || "0", 10);

    // Estimate: 1 token ≈ 4 chars, each observation ≈ 1 read + embedded
    const estimatedReadTokens = Math.ceil(totalChars / 4);
    // Discovery tokens = what the LLM would spend re-discovering this info
    const estimatedDiscoveryTokens = Math.ceil(estimatedReadTokens * 1.5);
    // Savings = what was NOT re-discovered because memory exists
    const savingsEstimate = Math.max(
      0,
      estimatedDiscoveryTokens - estimatedReadTokens,
    );

    const economics: SessionEconomics = {
      sessionMapId,
      totalObservations: total,
      avgImportance: Math.round(avgImportance * 100) / 100,
      estimatedReadTokens,
      estimatedDiscoveryTokens,
      savingsEstimate,
    };

    // Persist to token_economics table (UPSERT)
    await pool.query(
      `INSERT INTO token_economics
        (session_map_id, total_observations, avg_importance,
         estimated_read_tokens, estimated_discovery_tokens, savings_estimate,
         calculated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (session_map_id)
       DO UPDATE SET
         total_observations = EXCLUDED.total_observations,
         avg_importance = EXCLUDED.avg_importance,
         estimated_read_tokens = EXCLUDED.estimated_read_tokens,
         estimated_discovery_tokens = EXCLUDED.estimated_discovery_tokens,
         savings_estimate = EXCLUDED.savings_estimate,
         calculated_at = NOW()`,
      [
        sessionMapId,
        total,
        avgImportance,
        estimatedReadTokens,
        estimatedDiscoveryTokens,
        savingsEstimate,
      ],
    );

    logger.info(
      `Token economics for ${sessionMapId}: ${savingsEstimate} savings`,
    );
    return economics;
  } catch (error) {
    logger.error("Failed to calculate token economics", error);
    return null;
  }
}

/**
 * Format token economics as a dashboard string for system prompt injection.
 */
export function formatEconomicsDashboard(economics: SessionEconomics): string {
  return [
    "<token_economics>",
    `  observations: ${economics.totalObservations}`,
    `  avg_importance: ${economics.avgImportance}`,
    `  read_tokens: ${economics.estimatedReadTokens.toLocaleString()}`,
    `  discovery_tokens: ${economics.estimatedDiscoveryTokens.toLocaleString()}`,
    `  estimated_savings: ${economics.savingsEstimate.toLocaleString()} tokens`,
    `  savings_ratio: ${
      economics.estimatedReadTokens > 0
        ? `${Math.round((economics.savingsEstimate / economics.estimatedDiscoveryTokens) * 100)}%`
        : "N/A"
    }`,
    "</token_economics>",
  ].join("\n");
}

// ============================================================
// Eval: recall@10 self-benchmark
// ============================================================

export interface EvalResult {
  total: number;
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  avgScore: number;
}

/**
 * Run recall@k evaluation on existing observations.
 *
 * Methodology:
 *   1. Take 50 recent observations with embeddings as "ground truth"
 *   2. For each, use its text as a keyword query (ILIKE)
 *   3. Check if the observation appears in keyword-only top-k results
 *   4. Then check semantic (pgvector) top-k results
 *
 * Result is two numbers: keyword recall@10 and semantic recall@10.
 * Tune weights until both are maximized.
 */
export async function evalRecall(pool: Pool): Promise<{
  keyword: EvalResult;
  semantic: EvalResult;
}> {
  const { rows: samples } = await pool.query(
    `SELECT id, tool_input_summary, tool_output_summary
     FROM observations
     WHERE embedding IS NOT NULL
       AND (tool_input_summary IS NOT NULL OR tool_output_summary IS NOT NULL)
     ORDER BY created_at DESC
     LIMIT 50`,
  );

  if (samples.length === 0) {
    const empty = {
      total: 0,
      recallAt1: 0,
      recallAt5: 0,
      recallAt10: 0,
      avgScore: 0,
    };
    return { keyword: empty, semantic: empty };
  }

  // ── Keyword recall test ──
  let kHits1 = 0,
    kHits5 = 0,
    kHits10 = 0,
    kScore = 0;
  // ── Semantic recall test ──
  let sHits1 = 0,
    sHits5 = 0,
    sHits10 = 0,
    sScore = 0;

  for (const sample of samples) {
    const queryText = (
      sample.tool_output_summary ||
      sample.tool_input_summary ||
      ""
    ).trim();
    if (queryText.length < 10) continue;

    // Extract a distinctive keyword (first meaningful word/tool name)
    const keywords = queryText
      .split(/\s+/)
      .filter((w: string) => w.length > 3)
      .slice(0, 3)
      .join(" ");
    if (!keywords) continue;

    // Keyword recall: ILIKE match
    const { rows: kwResults } = await pool.query(
      `SELECT id FROM observations
       WHERE (tool_input_summary ILIKE $1 OR tool_output_summary ILIKE $1)
         AND id != $2
       ORDER BY importance DESC, created_at DESC
       LIMIT 10`,
      [`%${keywords}%`, sample.id],
    );
    const kwIdx = kwResults.findIndex((r: any) => r.id === sample.id);
    if (kwIdx === 0) kHits1++;
    if (kwIdx >= 0 && kwIdx < 5) kHits5++;
    if (kwIdx >= 0) kHits10++;
    if (kwIdx >= 0) kScore += 1 - kwIdx / 10;

    // Semantic recall: get embedding for this observation
    // (Using stored embedding — for true eval, would re-embed queryText)
    const embResult = await pool.query(
      `SELECT embedding FROM observations WHERE id = $1 AND embedding IS NOT NULL`,
      [sample.id],
    );
    if (embResult.rows.length === 0) continue;
    const vector = embResult.rows[0].embedding as number[];
    const vectorLit = `[${vector.join(",")}]`;

    const { rows: semResults } = await pool.query(
      `SELECT id, 1 - (embedding <=> $1::vector) AS similarity
       FROM observations
       WHERE id != $2 AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT 10`,
      [vectorLit, sample.id],
    );
    const semIdx = semResults.findIndex((r: any) => r.id === sample.id);
    if (semIdx === 0) sHits1++;
    if (semIdx >= 0 && semIdx < 5) sHits5++;
    if (semIdx >= 0) sHits10++;
    if (semIdx >= 0) sScore += semResults[semIdx]?.similarity || 0;
  }

  const n = samples.length;
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    keyword: {
      total: n,
      recallAt1: round((kHits1 / n) * 100),
      recallAt5: round((kHits5 / n) * 100),
      recallAt10: round((kHits10 / n) * 100),
      avgScore: round((kScore / n) * 100),
    },
    semantic: {
      total: n,
      recallAt1: round((sHits1 / n) * 100),
      recallAt5: round((sHits5 / n) * 100),
      recallAt10: round((sHits10 / n) * 100),
      avgScore: round((sScore / n) * 100),
    },
  };
}
