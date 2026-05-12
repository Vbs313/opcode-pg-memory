import { Pool } from "pg";
import { createLogger } from "../services/logger";
import type { Reflection } from "../types";

const logger = createLogger("hindsight-reflect");

// ============================================================
// Public input / output interfaces
// ============================================================

export interface HindsightReflectInput {
  session_id?: string;
  omo_task_id?: string;
  topic_segment_id?: string;
  trigger_type?: "manual" | "threshold" | "scheduled";
  model_size?: "7b" | "14b" | "full";
  aggregate?: boolean;
  /** @deprecated Backward compat — threshold is now in HindsightReflectConfig */
  observation_threshold?: number;
}

export interface HindsightReflectOutput {
  generated_reflections: Reflection[];
  token_usage: {
    input: number;
    output: number;
    total: number;
  };
  duration_ms: number;
}

// ============================================================
// Local config types (not in types.ts — runtime tuning knobs)
// ============================================================

export interface HindsightReflectConfig {
  observationThreshold: number;
  segmentThreshold: number;
  minThreshold: number;
  maxThreshold: number;
  modelSize: "7b" | "14b" | "full";
  offPeakHours: number[];
  minConfidence: number;
  /** Max observations to fetch per segment */
  maxObservationsPerSegment: number;
  /** Max observations to fetch in aggregate mode */
  maxObservationsAggregate: number;
  /** Batch size for LLM reflection calls */
  reflectionBatchSize: number;
  /** Prompts used for LLM reflection — configurable to avoid hardcoding */
  prompts: {
    systemPrompt: string;
    perSegmentUserPrompt: string;
    aggregateUserPrompt: string;
  };
}

// ============================================================
// Configurable prompts (not hardcoded — passed via config)
// Must be declared BEFORE DEFAULT_CONFIG which references them
// ============================================================

export const DEFAULT_REFLECTION_SYSTEM_PROMPT = `You are a reflection engine that analyzes coding session observations to extract reusable patterns and insights.

## Task
Analyze the provided observations from a coding session and generate structured reflections that capture:
1. Error patterns and their root causes
2. Successful approaches and best practices
3. User preferences and coding style
4. Technical stack patterns
5. Cross-session applicable insights

## Input Format
Observations will be provided as a JSON array with fields:
- id: Observation identifier
- tool_name: The tool that was used
- tool_input_summary: Summary of inputs
- tool_output_summary: Summary of outputs
- importance: Importance rating (1-5)
- created_at: Timestamp
- metadata: Additional metadata

## Output Format
Respond with a JSON object containing:
{
  "summary": "High-level summary of the session insights (2-3 sentences)",
  "patterns": [
    {
      "pattern_type": "error_pattern|success_pattern|preference|technical_stack|workflow|tool_preference|insight|session_overview",
      "description": "Detailed description of the pattern (1-2 sentences)",
      "confidence": 0.0-1.0,
      "source_observation_ids": ["id1", "id2"],
      "applicability": "When this pattern applies"
    }
  ],
  "recommendations": [
    "Actionable recommendation based on patterns"
  ],
  "technical_stack": {
    "languages": ["detected languages"],
    "frameworks": ["detected frameworks"],
    "tools": ["frequently used tools"]
  }
}

## Rules
- Only include patterns with confidence >= 0.6
- Focus on cross-session applicable insights
- Be specific about technical details (file names, function names, etc.)
- Avoid generic advice like "write clean code"
- Consider the sequence of observations for causal relationships
- Identify recurring errors and their solutions
- Note user preferences (indentation style, naming conventions, etc.)

## Pattern Types
- error_pattern: Recurring errors and how they were resolved
- success_pattern: Approaches that worked well
- preference: User's coding style and preferences
- technical_stack: Technologies and tools used
- workflow: Development workflow patterns
- tool_preference: Frequently used tools and preferences
- insight: Notable technical discoveries or lessons`;

export const DEFAULT_PER_SEGMENT_USER_PROMPT = `You are a technical retrospective assistant. Analyze the following tool execution records from topic: "{topic_summary}", and summarize:
1. Recurring patterns or workflows
2. Notable technical discoveries or lessons
3. Recommendations for future similar tasks

Session context: {session_context}

Observations:
{observations_json}`;

export const DEFAULT_AGGREGATE_USER_PROMPT = `You are a technical retrospective assistant. Analyze the following tool execution records across multiple topics and sessions, and summarize:
1. Cross-topic recurring patterns or workflows
2. Notable technical discoveries or lessons that span topics
3. Recommendations for future similar tasks

Topics covered: {topics_summary}

Observations:
{observations_json}`;

const DEFAULT_CONFIG: HindsightReflectConfig = {
  observationThreshold: 30,
  segmentThreshold: 10,
  minThreshold: 30,
  maxThreshold: 50,
  modelSize: "7b",
  offPeakHours: [1, 2, 3, 4, 5],
  minConfidence: 0.6,
  maxObservationsPerSegment: 100,
  maxObservationsAggregate: 200,
  reflectionBatchSize: 10,
  prompts: {
    systemPrompt: DEFAULT_REFLECTION_SYSTEM_PROMPT,
    perSegmentUserPrompt: DEFAULT_PER_SEGMENT_USER_PROMPT,
    aggregateUserPrompt: DEFAULT_AGGREGATE_USER_PROMPT,
  },
};

// ============================================================
// MCP Tool: hindsight_reflect
// ============================================================

/**
 * Enhanced hindsight_reflect with topic_segment-based reflection,
 * omo_task_id support, and aggregate mode.
 *
 * Scope resolution:
 * 1. topic_segment_id → reflect on that single segment
 * 2. session_id + aggregate=false → group by topic_segment, reflect per segment
 * 3. session_id + aggregate=true → reflect on all observations across all segments
 * 4. omo_task_id → find all session_map entries for this task, reflect across their segments
 *
 * Backward compatible: session_id-only input falls back to legacy path
 * (sessions table + session-scoped reflection).
 */
export async function hindsightReflect(
  input: HindsightReflectInput,
  pool: Pool,
  config: Partial<HindsightReflectConfig> = {},
): Promise<HindsightReflectOutput> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();
  let totalTokens = { input: 0, output: 0, total: 0 };

  logger.info(
    `hindsight_reflect called: session=${input.session_id || "none"}, ` +
      `omo_task=${input.omo_task_id || "none"}, ` +
      `topic_segment=${input.topic_segment_id || "none"}, ` +
      `aggregate=${input.aggregate ?? false}`,
  );

  try {
    // ── Step 1: Resolve target scope ──────────────────────────────────
    const scope = await resolveScope(input, pool);

    if (!scope.observable) {
      logger.info("hindsight_reflect: no observations available for scope");
      return {
        generated_reflections: [],
        token_usage: totalTokens,
        duration_ms: Date.now() - startTime,
      };
    }

    // ── Step 2: Collect observations ──────────────────────────────────
    const observations = await collectObservations(
      input,
      scope,
      mergedConfig,
      pool,
    );

    if (observations.length === 0) {
      logger.info("hindsight_reflect: zero observations collected");
      return {
        generated_reflections: [],
        token_usage: totalTokens,
        duration_ms: Date.now() - startTime,
      };
    }

    logger.info(`Fetched ${observations.length} observations for reflection`);

    // ── Threshold check (skip if below threshold and not manual) ──────
    const threshold = mergedConfig.observationThreshold;
    if (observations.length < threshold && input.trigger_type !== "manual") {
      logger.info(
        `hindsight_reflect: observation count (${observations.length}) ` +
          `below threshold (${threshold}), skipping`,
      );
      return {
        generated_reflections: [],
        token_usage: totalTokens,
        duration_ms: Date.now() - startTime,
      };
    }

    // ── Step 3: Group observations by topic_segment ───────────────────
    const shouldAggregate =
      input.aggregate === true ||
      (!!input.omo_task_id && input.aggregate !== false); // omo_task_id defaults to aggregate

    const segments = groupObservationsBySegment(observations, shouldAggregate);

    logger.info(
      `Grouped into ${segments.length} segment(s) ` +
        `(aggregate=${shouldAggregate})`,
    );

    // ── Step 4: Reflect on each segment group ─────────────────────────
    const generatedReflections: Reflection[] = [];

    for (const segment of segments) {
      const segmentReflections = await reflectOnSegment(
        segment,
        scope,
        input,
        mergedConfig,
        pool,
      );
      generatedReflections.push(...segmentReflections);

      // Track token usage (approximate from LLM call within reflectOnSegment)
      // The actual token counts would come from the LLM API response
      totalTokens.input += segment.observations.length * 50; // rough estimate
      totalTokens.output += segmentReflections.length * 100; // rough estimate
    }

    // ── Step 7: Update session_map.reflection_last_at ─────────────────
    await updateReflectionTimestamp(scope, pool);

    const elapsed = Date.now() - startTime;
    logger.info(
      `hindsight_reflect completed: ` +
        `${generatedReflections.length} reflections in ${elapsed}ms`,
    );

    return {
      generated_reflections: generatedReflections,
      token_usage: totalTokens,
      duration_ms: elapsed,
    };
  } catch (error) {
    const elapsed = Date.now() - startTime;
    logger.error("hindsight_reflect error:", error);

    // Record error in reflection_errors table
    await logReflectionError(input, error, pool);

    return {
      generated_reflections: [],
      token_usage: totalTokens,
      duration_ms: elapsed,
    };
  }
}

// ============================================================
// Step 1: Scope resolution
// ============================================================

interface ReflectionScope {
  /** Whether there are observable entities to reflect on */
  observable: boolean;
  /** Legacy session internal IDs (for backward compat) */
  sessionInternalIds: string[];
  /** New-architecture session_map IDs */
  sessionMapIds: string[];
  /** opencode session external IDs */
  opencodeSessionIds: string[];
  /** Specific topic_segment_id if targeted */
  topicSegmentId: string | null;
  /** Whether using new schema (session_map + topic_segments) */
  usesNewSchema: boolean;
  /** The omo_task_id if cross-session reflection */
  omoTaskId: string | null;
}

async function resolveScope(
  input: HindsightReflectInput,
  pool: Pool,
): Promise<ReflectionScope> {
  const scope: ReflectionScope = {
    observable: false,
    sessionInternalIds: [],
    sessionMapIds: [],
    opencodeSessionIds: [],
    topicSegmentId: input.topic_segment_id || null,
    usesNewSchema: false,
    omoTaskId: input.omo_task_id || null,
  };

  // Check if session_map table exists (new schema detection)
  const hasSessionMap = await tableExists(pool, "session_map");
  const hasTopicSegments = await tableExists(pool, "topic_segments");

  // session_map 存在即启用新 schema（topic_segments 可选）
  scope.usesNewSchema = hasSessionMap;

  // ── Path A: omo_task_id → find all session_map entries ──────────
  if (input.omo_task_id && scope.usesNewSchema) {
    const smResult = await pool.query(
      `SELECT id, opencode_session_id FROM session_map WHERE omo_task_id = $1`,
      [input.omo_task_id],
    );
    if (smResult.rows.length > 0) {
      scope.sessionMapIds = smResult.rows.map((r: any) => r.id);
      scope.opencodeSessionIds = smResult.rows.map(
        (r: any) => r.opencode_session_id,
      );
      scope.observable = true;
    }
    return scope;
  }

  // ── Path B: session_id (backward compat or new schema) ─────────
  if (input.session_id) {
    if (scope.usesNewSchema) {
      // Look up in session_map
      const smResult = await pool.query(
        `SELECT id, opencode_session_id FROM session_map WHERE opencode_session_id = $1`,
        [input.session_id],
      );
      if (smResult.rows.length > 0) {
        scope.sessionMapIds = smResult.rows.map((r: any) => r.id);
        scope.opencodeSessionIds = [input.session_id];
        scope.observable = true;
        return scope;
      }
    }

    // Legacy fallback: look up in sessions table
    const sessResult = await pool.query(
      `SELECT id FROM sessions WHERE external_id = $1`,
      [input.session_id],
    );
    if (sessResult.rows.length > 0) {
      scope.sessionInternalIds = sessResult.rows.map((r: any) => r.id);
      scope.opencodeSessionIds = [input.session_id];
      scope.usesNewSchema = false;
      scope.observable = true;
      return scope;
    }
  }

  // ── Path C: topic_segment_id only ──────────────────────────────
  if (input.topic_segment_id && scope.usesNewSchema) {
    // Verify the segment exists
    const tsResult = await pool.query(
      `SELECT id, session_map_id FROM topic_segments WHERE id = $1`,
      [input.topic_segment_id],
    );
    if (tsResult.rows.length > 0) {
      scope.sessionMapIds = [tsResult.rows[0].session_map_id];
      scope.topicSegmentId = input.topic_segment_id;
      scope.observable = true;
    }
    return scope;
  }

  return scope;
}

// ============================================================
// Step 2: Collect observations
// ============================================================

interface EnrichedObservation {
  id: string;
  tool_name: string;
  tool_input_summary: string;
  tool_output_summary: string;
  importance: number;
  created_at: Date;
  metadata: Record<string, any>;
  /** topic_segment_id from new schema */
  segment_id?: string;
  /** topic_segment summary for context in prompts */
  topic_summary?: string;
  /** opencode session ID for cross-session context */
  opencode_session_id?: string;
  /** session_map_id for storage */
  session_map_id?: string;
}

async function collectObservations(
  input: HindsightReflectInput,
  scope: ReflectionScope,
  config: HindsightReflectConfig,
  pool: Pool,
): Promise<EnrichedObservation[]> {
  // ── Path A: Single topic_segment ────────────────────────────────
  if (scope.topicSegmentId && scope.usesNewSchema) {
    try {
      return await collectObservationsForSegment(
        scope.topicSegmentId,
        config,
        pool,
      );
    } catch (err) {
      logger.warn("New-schema segment collection failed, falling back:", err);
    }
  }

  // ── Path B: omo_task_id across multiple session_maps ────────────
  if (
    scope.omoTaskId &&
    scope.usesNewSchema &&
    scope.sessionMapIds.length > 0
  ) {
    try {
      return await collectObservationsForOmoTask(scope.omoTaskId, config, pool);
    } catch (err) {
      logger.warn("New-schema omo_task collection failed, falling back:", err);
    }
  }

  // ── Path C: session_map(s) with topic_segments ─────────────────
  if (scope.usesNewSchema && scope.sessionMapIds.length > 0) {
    try {
      return await collectObservationsForSessionMaps(
        scope.sessionMapIds,
        config,
        pool,
      );
    } catch (err) {
      logger.warn(
        "New-schema session_map collection failed, falling back:",
        err,
      );
    }
  }

  // ── Path D: Legacy sessions table ──────────────────────────────
  return collectObservationsLegacy(scope.sessionInternalIds, config, pool);
}

/** Collect observations for a single topic_segment */
async function collectObservationsForSegment(
  topicSegmentId: string,
  config: HindsightReflectConfig,
  pool: Pool,
): Promise<EnrichedObservation[]> {
  const result = await pool.query(
    `SELECT o.*, ts.id as segment_id, ts.summary as topic_summary
     FROM observations o
     JOIN topic_segments ts ON o.topic_segment_id = ts.id
     WHERE o.topic_segment_id = $1
     ORDER BY o.importance DESC, o.created_at DESC
     LIMIT $2`,
    [topicSegmentId, config.maxObservationsPerSegment],
  );

  return result.rows.map(mapEnrichedObservation);
}

/** Collect observations for an omo_task_id across all session_maps */
async function collectObservationsForOmoTask(
  omoTaskId: string,
  config: HindsightReflectConfig,
  pool: Pool,
): Promise<EnrichedObservation[]> {
  const result = await pool.query(
    `SELECT o.*, ts.id as segment_id, ts.summary as topic_summary,
            sm.opencode_session_id
     FROM observations o
     JOIN session_map sm ON o.session_map_id = sm.id
     JOIN topic_segments ts ON o.topic_segment_id = ts.id
     WHERE sm.omo_task_id = $1
     ORDER BY o.importance DESC
     LIMIT $2`,
    [omoTaskId, config.maxObservationsAggregate],
  );

  return result.rows.map(mapEnrichedObservation);
}

/** Collect observations for specific session_map IDs (new schema) */
async function collectObservationsForSessionMaps(
  sessionMapIds: string[],
  config: HindsightReflectConfig,
  pool: Pool,
): Promise<EnrichedObservation[]> {
  const result = await pool.query(
    `SELECT o.*, ts.id as segment_id, ts.summary as topic_summary,
            sm.opencode_session_id, sm.id as sm_id
     FROM observations o
     JOIN session_map sm ON o.session_map_id = sm.id
     LEFT JOIN topic_segments ts ON o.topic_segment_id = ts.id
     WHERE o.session_map_id = ANY($1::uuid[])
     ORDER BY o.importance DESC, o.created_at DESC
     LIMIT $2`,
    [sessionMapIds, config.maxObservationsAggregate],
  );

  return result.rows.map((row: any) => ({
    ...mapEnrichedObservation(row),
    session_map_id: row.sm_id || row.session_map_id,
  }));
}

/** Legacy path: observations from sessions table (no topic_segments) */
async function collectObservationsLegacy(
  sessionInternalIds: string[],
  config: HindsightReflectConfig,
  pool: Pool,
): Promise<EnrichedObservation[]> {
  const query = `
    SELECT id, tool_name, tool_input_summary, tool_output_summary,
           importance, created_at, metadata
    FROM observations
    WHERE session_id = ANY($1::uuid[])
    ORDER BY importance DESC, created_at DESC
    LIMIT $2
  `;

  const result = await pool.query(query, [
    sessionInternalIds,
    config.maxObservationsAggregate,
  ]);

  return result.rows.map((row: any) => ({
    id: row.id,
    tool_name: row.tool_name || "",
    tool_input_summary: row.tool_input_summary || "",
    tool_output_summary: row.tool_output_summary || "",
    importance: row.importance,
    created_at: row.created_at,
    metadata: row.metadata || {},
  }));
}

function mapEnrichedObservation(row: any): EnrichedObservation {
  return {
    id: row.id,
    tool_name: row.tool_name || "",
    tool_input_summary: row.tool_input_summary || "",
    tool_output_summary: row.tool_output_summary || "",
    importance: row.importance ?? 3,
    created_at: row.created_at,
    metadata: row.metadata || {},
    segment_id: row.segment_id,
    topic_summary: row.topic_summary,
    opencode_session_id: row.opencode_session_id,
    session_map_id: row.session_map_id,
  };
}

// ============================================================
// Step 3: Group observations by segment
// ============================================================

interface SegmentGroup {
  /** Unique segment ID; '__aggregate__' when aggregate=true */
  segmentId: string;
  /** Topic summary for the segment */
  topicSummary: string;
  /** Observations in this group */
  observations: EnrichedObservation[];
  /** opencode session IDs contributing to this group */
  opencodeSessionIds: string[];
  /** session_map_ids for storage */
  sessionMapIds: string[];
}

function groupObservationsBySegment(
  observations: EnrichedObservation[],
  aggregate: boolean,
): SegmentGroup[] {
  if (aggregate || observations.length === 0) {
    // Single aggregate group spanning all segments
    return [
      {
        segmentId: "__aggregate__",
        topicSummary: collectAllTopicSummaries(observations),
        observations,
        opencodeSessionIds: dedupe(
          observations
            .map((o) => o.opencode_session_id)
            .filter(Boolean) as string[],
        ),
        sessionMapIds: dedupe(
          observations.map((o) => o.session_map_id).filter(Boolean) as string[],
        ),
      },
    ];
  }

  // Group by segment_id; fallback to a single unnamed group if no segments
  const groups = new Map<string, EnrichedObservation[]>();
  for (const obs of observations) {
    const key = obs.segment_id || "__no_segment__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(obs);
  }

  const result: SegmentGroup[] = [];
  for (const [segmentId, obs] of groups) {
    result.push({
      segmentId,
      topicSummary:
        obs[0]?.topic_summary ||
        (segmentId === "__no_segment__"
          ? "Unsegmented observations"
          : `Segment ${segmentId}`),
      observations: obs,
      opencodeSessionIds: dedupe(
        obs.map((o) => o.opencode_session_id).filter(Boolean) as string[],
      ),
      sessionMapIds: dedupe(
        obs.map((o) => o.session_map_id).filter(Boolean) as string[],
      ),
    });
  }

  return result;
}

function collectAllTopicSummaries(observations: EnrichedObservation[]): string {
  const summaries = dedupe(
    observations.map((o) => o.topic_summary).filter(Boolean) as string[],
  );
  return summaries.length > 0 ? summaries.join("; ") : "Cross-topic aggregate";
}

// ============================================================
// Step 4: Reflect on each segment
// ============================================================

async function reflectOnSegment(
  segment: SegmentGroup,
  scope: ReflectionScope,
  input: HindsightReflectInput,
  config: HindsightReflectConfig,
  pool: Pool,
): Promise<Reflection[]> {
  const reflections: Reflection[] = [];

  // Sort by importance, take top N
  const sorted = [...segment.observations]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, config.maxObservationsPerSegment);

  // Batch into groups of reflectionBatchSize
  const batches: EnrichedObservation[][] = [];
  for (let i = 0; i < sorted.length; i += config.reflectionBatchSize) {
    batches.push(sorted.slice(i, i + config.reflectionBatchSize));
  }

  for (const batch of batches) {
    // Build context-aware prompt (used when real LLM integration is active)
    const prompt = buildReflectionPrompt(segment, batch, config, input);

    // Call LLM (with heuristic fallback)
    const llmResult = await performReflectionWithLLM(
      batch,
      segment.topicSummary,
      config,
      prompt,
    );

    // Convert patterns to Reflection records and store
    for (const pattern of llmResult.patterns) {
      if (pattern.confidence >= config.minConfidence) {
        const reflection = await storeReflection(
          pattern,
          segment,
          scope,
          pool,
          config,
          input,
        );
        if (reflection) {
          reflections.push(reflection);
        }
      }
    }
  }

  return reflections;
}

/**
 * Build a reflection prompt with topic context.
 * Prompts are configurable via HindsightReflectConfig.prompts.
 */
function buildReflectionPrompt(
  segment: SegmentGroup,
  batch: EnrichedObservation[],
  config: HindsightReflectConfig,
  _input: HindsightReflectInput,
): string {
  const isAggregate = segment.segmentId === "__aggregate__";
  const template = isAggregate
    ? config.prompts.aggregateUserPrompt
    : config.prompts.perSegmentUserPrompt;

  const observationsJson = JSON.stringify(
    batch.map((o) => ({
      id: o.id,
      tool_name: o.tool_name,
      tool_input_summary: o.tool_input_summary,
      tool_output_summary: o.tool_output_summary,
      importance: o.importance,
      metadata: o.metadata,
    })),
  );

  const sessionContext =
    segment.opencodeSessionIds.length > 0
      ? segment.opencodeSessionIds.join(", ")
      : "unknown";

  return template
    .replace("{topic_summary}", segment.topicSummary)
    .replace("{session_context}", sessionContext)
    .replace("{topics_summary}", segment.topicSummary)
    .replace("{observations_json}", observationsJson);
}

// ============================================================
// LLM Reflection (with heuristic fallback)
// ============================================================

interface LLMReflectionResult {
  summary: string;
  patterns: Array<{
    pattern_type: string;
    description: string;
    confidence: number;
    source_observation_ids: string[];
    applicability?: string;
  }>;
  recommendations: string[];
  technical_stack?: {
    languages: string[];
    frameworks: string[];
    tools: string[];
  };
}

async function performReflectionWithLLM(
  observations: EnrichedObservation[],
  topicSummary: string,
  config: HindsightReflectConfig,
  prompt?: string,
): Promise<LLMReflectionResult> {
  logger.info(
    `Performing reflection with ${config.modelSize} model ` +
      `on ${observations.length} observations (topic: ${topicSummary})`,
  );

  // In production, this would call an LLM API (OpenAI, DeepSeek, etc.)
  // using the provided prompt built from configurable templates.
  // Example:
  //   const response = await openai.chat.completions.create({
  //     model: config.modelSize === '7b' ? 'gpt-4o-mini' : 'gpt-4o',
  //     messages: [
  //       { role: 'system', content: config.prompts.systemPrompt },
  //       { role: 'user', content: prompt },
  //     ],
  //     response_format: { type: 'json_object' },
  //   });
  //   return parseLLMResponse(response);
  //
  // For now, use heuristic rule-based reflection as fallback.
  void prompt; // used when LLM integration is activated
  return performHeuristicReflection(observations, topicSummary);
}

/**
 * Heuristic fallback when LLM is unavailable.
 * Detects basic patterns:
 * - error_pattern: observations with importance >= 4 or containing "error"
 * - tool_preference: frequently used tools (>= 5 uses)
 * - success_pattern: observations with "success" or "completed"
 */
function performHeuristicReflection(
  observations: EnrichedObservation[],
  topicSummary: string,
): LLMReflectionResult {
  const patterns: LLMReflectionResult["patterns"] = [];
  const recommendations: string[] = [];

  // 1. Session overview (always generated)
  const toolCount = observations.filter((o) => o.tool_name).length;
  const userMsgCount = observations.filter(
    (o) => o.tool_name === "user_message",
  ).length;
  patterns.push({
    pattern_type: "session_overview",
    description: `[${topicSummary}] Session had ${observations.length} observations (${toolCount} tool calls, ${userMsgCount} user messages).`,
    confidence: 0.9,
    source_observation_ids: observations.slice(0, 3).map((o) => o.id),
    applicability: "Session context understanding",
  });

  // 2. Error pattern detection
  const errorObs = observations.filter(
    (obs) =>
      obs.importance >= 3 ||
      obs.tool_output_summary?.toLowerCase().includes("error") ||
      obs.tool_output_summary?.toLowerCase().includes("exception") ||
      obs.tool_output_summary?.toLowerCase().includes("failed"),
  );

  if (errorObs.length >= 1) {
    patterns.push({
      pattern_type: "error_pattern",
      description: `[${topicSummary}] Encountered ${errorObs.length} error situations. Review error handling patterns.`,
      confidence: 0.75,
      source_observation_ids: errorObs.map((o) => o.id).slice(0, 5),
      applicability: "Future error-prone operations",
    });
    recommendations.push(
      `[${topicSummary}] Consider adding more robust error handling and validation.`,
    );
  }

  // 3. Tool preference detection (>= 3 uses)
  const toolUsage: Record<string, { count: number; ids: string[] }> = {};
  for (const obs of observations) {
    if (obs.tool_name && obs.tool_name !== "user_message") {
      if (!toolUsage[obs.tool_name]) {
        toolUsage[obs.tool_name] = { count: 0, ids: [] };
      }
      toolUsage[obs.tool_name].count++;
      toolUsage[obs.tool_name].ids.push(obs.id);
    }
  }

  const sortedTools = Object.entries(toolUsage)
    .filter(([, data]) => data.count >= 3)
    .sort((a, b) => b[1].count - a[1].count);

  for (const [toolName, data] of sortedTools) {
    const pct = Math.round((data.count / observations.length) * 100);
    patterns.push({
      pattern_type: data.count >= 5 ? "tool_preference" : "workflow",
      description: `[${topicSummary}] ${toolName} used ${data.count} times (${pct}% of session).`,
      confidence: Math.min(0.5 + data.count * 0.05, 0.95),
      source_observation_ids: data.ids.slice(0, 5),
      applicability: "Similar development tasks",
    });
  }

  // 4. Success pattern detection
  const successObs = observations.filter(
    (obs) =>
      obs.tool_output_summary?.toLowerCase().includes("success") ||
      obs.tool_output_summary?.toLowerCase().includes("completed") ||
      obs.tool_output_summary?.toLowerCase().includes("done"),
  );

  if (successObs.length >= 3) {
    patterns.push({
      pattern_type: "success_pattern",
      description: `[${topicSummary}] Session showed consistent successful execution patterns (${successObs.length} successes).`,
      confidence: 0.7,
      source_observation_ids: successObs.map((o) => o.id).slice(0, 5),
      applicability: "Similar task types",
    });
  }

  // 4. Technical stack detection
  const techStack = detectTechnicalStack(observations);
  if (techStack.languages.length > 0 || techStack.frameworks.length > 0) {
    patterns.push({
      pattern_type: "technical_stack",
      description: `[${topicSummary}] Primary technologies: ${[...techStack.languages, ...techStack.frameworks].join(", ")}`,
      confidence: 0.85,
      source_observation_ids: observations.slice(0, 5).map((o) => o.id),
      applicability: "Project-wide development",
    });
  }

  // Generate summary
  const summary = generateReflectionSummary(
    topicSummary,
    patterns,
    observations.length,
  );

  return {
    summary,
    patterns,
    recommendations,
    technical_stack: techStack,
  };
}

// ============================================================
// Step 5: Store reflection results
// ============================================================

async function storeReflection(
  pattern: {
    pattern_type: string;
    description: string;
    confidence: number;
    source_observation_ids: string[];
    applicability?: string;
  },
  segment: SegmentGroup,
  scope: ReflectionScope,
  pool: Pool,
  config: HindsightReflectConfig,
  input: HindsightReflectInput,
): Promise<Reflection | null> {
  try {
    const isAggregate = segment.segmentId === "__aggregate__";
    const topicSegmentId = isAggregate ? null : segment.segmentId || null;

    const metadata = {
      applicability: pattern.applicability,
      generatedAt: new Date().toISOString(),
      modelSize: config.modelSize,
      observationCount: segment.observations.length,
      triggerType: input.trigger_type || "threshold",
      topicSummary: segment.topicSummary,
      isAggregate,
    };

    let insertResult: any;

    // Try new-schema INSERT first (with session_map_id, topic_segment_id)
    if (scope.usesNewSchema && segment.sessionMapIds.length > 0) {
      try {
        insertResult = await pool.query(
          `INSERT INTO reflections (
             session_id, session_map_id, topic_segment_id,
             summary, source_observation_ids,
             confidence, pattern_type, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            scope.opencodeSessionIds[0] || null,
            segment.sessionMapIds[0],
            topicSegmentId,
            pattern.description,
            pattern.source_observation_ids,
            pattern.confidence,
            pattern.pattern_type,
            JSON.stringify(metadata),
          ],
        );
      } catch {
        // New columns may not exist yet — fall through to legacy INSERT
        logger.warn("New schema INSERT failed, falling back to legacy");
      }
    }

    // Legacy fallback: store with session_id only
    if (!insertResult && scope.sessionInternalIds.length > 0) {
      insertResult = await pool.query(
        `INSERT INTO reflections (
           session_id, summary, source_observation_ids,
           confidence, pattern_type, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          scope.sessionInternalIds[0],
          pattern.description,
          pattern.source_observation_ids,
          pattern.confidence,
          pattern.pattern_type,
          JSON.stringify(metadata),
        ],
      );
    }

    if (!insertResult) {
      logger.warn("No valid session reference to store reflection");
      return null;
    }

    return {
      id: insertResult.rows[0].id,
      session_id:
        scope.opencodeSessionIds[0] || scope.sessionInternalIds[0] || "",
      topic_segment_id: topicSegmentId || undefined,
      summary: pattern.description,
      source_observation_ids: pattern.source_observation_ids,
      confidence: pattern.confidence,
      pattern_type: pattern.pattern_type,
      created_at: new Date(),
      metadata,
    };
  } catch (error) {
    logger.error("Failed to store reflection:", error);
    return null;
  }
}

// ============================================================
// Step 6: Update reflection timestamp
// ============================================================

async function updateReflectionTimestamp(
  scope: ReflectionScope,
  pool: Pool,
): Promise<void> {
  try {
    if (scope.usesNewSchema && scope.sessionMapIds.length > 0) {
      // Update session_map reflection timestamp
      // Use a dynamic ALTER-safe approach — try UPDATE, ignore if column missing
      for (const smId of scope.sessionMapIds) {
        try {
          await pool.query(
            `UPDATE session_map SET metadata = 
               jsonb_set(COALESCE(metadata, '{}'), '{reflection_last_at}', $2::jsonb)
             WHERE id = $1`,
            [smId, JSON.stringify(new Date().toISOString())],
          );
        } catch {
          // Column or table might not support this yet — non-critical
        }

        // Also try direct column update if it exists
        try {
          await pool.query(
            `UPDATE session_map SET last_active_at = NOW() WHERE id = $1`,
            [smId],
          );
        } catch {
          // Ignore
        }
      }
    }

    // Legacy: update sessions.reflection_last_at
    for (const internalId of scope.sessionInternalIds) {
      await pool.query(
        `UPDATE sessions SET reflection_last_at = NOW(), 
                metadata = metadata - 'pendingReflection'
         WHERE id = $1`,
        [internalId],
      );
    }
  } catch (error) {
    logger.warn("Failed to update reflection timestamp:", error);
  }
}

// ============================================================
// Error logging
// ============================================================

async function logReflectionError(
  input: HindsightReflectInput,
  error: unknown,
  pool: Pool,
): Promise<void> {
  try {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    const errorStack = error instanceof Error ? error.stack : "";

    // Try to resolve session_id for the error record
    let sessionId: string | null = null;
    if (input.session_id) {
      const sessResult = await pool.query(
        `SELECT id FROM sessions WHERE external_id = $1`,
        [input.session_id],
      );
      if (sessResult.rows.length > 0) {
        sessionId = sessResult.rows[0].id;
      }
    }

    await pool.query(
      `INSERT INTO reflection_errors (
         session_id, error_message, error_stack,
         observation_count, retry_count
       ) VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, errorMessage, errorStack, 0, 0],
    );
  } catch (logError) {
    logger.error("Failed to log reflection error:", logError);
  }
}

// ============================================================
// Utility functions
// ============================================================

/** Check if a table exists in the database */
async function tableExists(pool: Pool, tableName: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) as exists`,
      [tableName],
    );
    return result.rows[0]?.exists === true;
  } catch {
    return false;
  }
}

/** Deduplicate string array */
function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

/**
 * 检测技术栈
 */
function detectTechnicalStack(
  observations: Array<{ tool_output_summary: string; tool_name: string }>,
): {
  languages: string[];
  frameworks: string[];
  tools: string[];
} {
  const allText = [
    ...observations.map((o) => o.tool_output_summary),
    ...observations.map((o) => o.tool_name),
  ]
    .join(" ")
    .toLowerCase();

  const languages: string[] = [];
  const frameworks: string[] = [];
  const tools: string[] = [];

  const langPatterns = [
    { name: "TypeScript", pattern: /typescript|\.ts\b/ },
    { name: "JavaScript", pattern: /javascript|\.js\b/ },
    { name: "Python", pattern: /python|\.py\b/ },
    { name: "Rust", pattern: /rust|\.rs\b/ },
    { name: "Go", pattern: /\bgo\b|golang|\.go\b/ },
    { name: "Java", pattern: /\bjava\b|\.java\b/ },
  ];

  for (const { name, pattern } of langPatterns) {
    if (pattern.test(allText)) languages.push(name);
  }

  const frameworkPatterns = [
    { name: "React", pattern: /react/ },
    { name: "Vue", pattern: /vue/ },
    { name: "Angular", pattern: /angular/ },
    { name: "Express", pattern: /express/ },
    { name: "FastAPI", pattern: /fastapi/ },
    { name: "Django", pattern: /django/ },
  ];

  for (const { name, pattern } of frameworkPatterns) {
    if (pattern.test(allText)) frameworks.push(name);
  }

  const toolPatterns = [
    { name: "Git", pattern: /git\b/ },
    { name: "Docker", pattern: /docker/ },
    { name: "npm", pattern: /\bnpm\b/ },
    { name: "yarn", pattern: /\byarn\b/ },
    { name: "webpack", pattern: /webpack/ },
    { name: "vite", pattern: /\bvite\b/ },
  ];

  for (const { name, pattern } of toolPatterns) {
    if (pattern.test(allText)) tools.push(name);
  }

  return { languages, frameworks, tools };
}

/**
 * 生成反思总结
 */
function generateReflectionSummary(
  topicSummary: string,
  patterns: Array<{ pattern_type: string; description: string }>,
  observationCount: number,
): string {
  if (patterns.length === 0) {
    return `[${topicSummary}] Analyzed ${observationCount} observations. No significant patterns detected.`;
  }

  const patternTypes = patterns.map((p) => p.pattern_type).join(", ");

  return `[${topicSummary}] Analyzed ${observationCount} observations and identified ${patterns.length} patterns: ${patternTypes}. Key insights available for future sessions.`;
}

/**
 * 检查是否是低峰期
 */
export function isOffPeakHour(config?: { offPeakHours: number[] }): boolean {
  const hour = new Date().getHours();
  const offPeakHours = config?.offPeakHours || [1, 2, 3, 4, 5];
  return offPeakHours.includes(hour);
}

/**
 * 获取反思统计
 */
export async function getReflectionStats(
  sessionId: string,
  pool: Pool,
): Promise<{
  totalReflections: number;
  patternTypes: Record<string, number>;
  averageConfidence: number;
  lastReflectionAt: Date | null;
}> {
  const sessionResult = await pool.query(
    "SELECT id, reflection_last_at FROM sessions WHERE external_id = $1",
    [sessionId],
  );

  if (sessionResult.rows.length === 0) {
    return {
      totalReflections: 0,
      patternTypes: {},
      averageConfidence: 0,
      lastReflectionAt: null,
    };
  }

  const internalId = sessionResult.rows[0].id;

  const [countResult, patternResult, confidenceResult] = await Promise.all([
    pool.query(
      "SELECT COUNT(*) as count FROM reflections WHERE session_id = $1",
      [internalId],
    ),
    pool.query(
      `SELECT pattern_type, COUNT(*) as count
       FROM reflections
       WHERE session_id = $1 AND pattern_type IS NOT NULL
       GROUP BY pattern_type`,
      [internalId],
    ),
    pool.query(
      "SELECT AVG(confidence) as avg FROM reflections WHERE session_id = $1",
      [internalId],
    ),
  ]);

  const patternTypes: Record<string, number> = {};
  for (const row of patternResult.rows) {
    patternTypes[row.pattern_type] = parseInt(row.count, 10);
  }

  return {
    totalReflections: parseInt(countResult.rows[0].count, 10),
    patternTypes,
    averageConfidence: parseFloat(confidenceResult.rows[0]?.avg || 0),
    lastReflectionAt: sessionResult.rows[0].reflection_last_at,
  };
}
