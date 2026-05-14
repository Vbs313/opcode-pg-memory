import { createLogger } from "../services/logger";
import { InternalFact, RecallMemoryInput, DecayConfig } from "../types";

const logger = createLogger("retrieval-fusion");

// ============================================================
// Step 4: Merge & deduplicate
// ============================================================

export function mergeAndDeduplicate(
  strategyResults: Map<string, InternalFact[]>,
): InternalFact[] {
  const seen = new Set<string>();
  const merged: InternalFact[] = [];

  for (const [, facts] of strategyResults) {
    for (const fact of facts) {
      const key = `${fact.type}:${fact.id || fact.metadata.id || ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(fact);
      } else {
        const existing = merged.find(
          (f) => `${f.type}:${f.id || f.metadata.id || ""}` === key,
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

const DEFAULT_DECAY_CONFIG: DecayConfig = {
  enabled: true,
  factor: 0.99,
  maxAgeDays: 365,
};

export function calculateMultiDimensionalScores(
  facts: InternalFact[],
  _queryEmbedding: number[],
  weights: { semantic: number; recency: number; importance: number },
  decayConfig: DecayConfig = DEFAULT_DECAY_CONFIG,
): InternalFact[] {
  const now = new Date();

  let results = facts
    .map((fact) => {
      const semanticScore = fact.relevanceScore;

      // Recency decay
      const createdAt = new Date(
        fact.metadata.createdAt || fact._timestamp || Date.now(),
      );
      const daysAgo =
        (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
      const recencyScore = 1.0 / (1 + daysAgo);

      // Importance (normalize to 0-1)
      const importance = fact.metadata.importance || fact.metadata.weight || 3;
      const importanceScore = Math.min(1, importance / 5.0);

      const finalScore =
        weights.semantic * semanticScore +
        weights.recency * recencyScore +
        weights.importance * importanceScore;

      let relevanceScore = Math.round(finalScore * 1000) / 1000;

      // ── Apply time-based entity weight decay ──
      if (decayConfig.enabled) {
        const metadata = fact.metadata || {};
        const lastSeen = metadata.createdAt || fact._timestamp || Date.now();
        const daysSinceLastSeen =
          (Date.now() - new Date(lastSeen).getTime()) / 86400000;

        if (metadata.tier !== "permanent") {
          const decayedWeight =
            relevanceScore * Math.pow(decayConfig.factor, daysSinceLastSeen);
          relevanceScore = Math.max(0.01, decayedWeight);

          if (
            daysSinceLastSeen > decayConfig.maxAgeDays &&
            relevanceScore < 0.1
          ) {
            relevanceScore = 0;
          }
        }
      }

      return { ...fact, relevanceScore };
    })
    .filter((r) => r.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore);

  return results;
}

// ============================================================
// Step 6: Apply filters (post-retrieval)
// ============================================================

export function applyFilters(
  facts: InternalFact[],
  filters?: RecallMemoryInput["filters"],
): InternalFact[] {
  if (!filters) return facts;

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
      if (conf !== undefined && conf !== null && conf < filters.min_confidence)
        return false;
    }

    // min_importance
    if (filters.min_importance !== undefined) {
      const imp = fact.metadata.importance;
      if (imp !== undefined && imp !== null && imp < filters.min_importance)
        return false;
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
    if (
      filters.exclude_topic_segment_ids &&
      filters.exclude_topic_segment_ids.length > 0
    ) {
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
// Step 6.5: Aggregate similar consecutive observations
// ============================================================

export function aggregateConsecutiveSimilar(
  facts: InternalFact[],
): InternalFact[] {
  if (facts.length === 0) return facts;

  const result: InternalFact[] = [];
  let i = 0;

  while (i < facts.length) {
    const current = facts[i];

    if (
      current.type === "observation" &&
      current.metadata?.source &&
      current.metadata?.toolName &&
      current.content
    ) {
      const toolName = current.metadata.toolName;

      let j = i + 1;
      while (
        j < facts.length &&
        facts[j].type === "observation" &&
        facts[j].metadata?.toolName === toolName
      ) {
        j++;
      }

      const count = j - i;

      if (count >= 2) {
        const last = facts[j - 1];
        const firstContent =
          current.content.length > 80
            ? current.content.substring(0, 80) + "..."
            : current.content;
        const lastContent =
          last.content.length > 80
            ? last.content.substring(0, 80) + "..."
            : last.content;

        result.push({
          ...last,
          content: `[${toolName} ×${count}] ${lastContent}`,
          relevanceScore: Math.max(current.relevanceScore, last.relevanceScore),
          metadata: {
            ...last.metadata,
            aggregated: true,
            aggregateCount: count,
            aggregateRange: `${firstContent} ... ${lastContent}`,
          },
        });

        i = j;
        continue;
      }
    }

    result.push(current);
    i++;
  }

  return result;
}

// ============================================================
// Step 7: Cross-encoder rerank (simplified)
// ============================================================

export async function crossEncoderRerank(
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

    const overlapScore =
      queryWords.length > 0 ? overlap / queryWords.length : 0;
    const adjustedScore = fact.relevanceScore * 0.7 + overlapScore * 0.3;

    return {
      ...fact,
      relevanceScore: Math.round(adjustedScore * 1000) / 1000,
    };
  });

  return reranked.sort((a, b) => b.relevanceScore - a.relevanceScore);
}
