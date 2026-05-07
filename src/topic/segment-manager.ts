import { Pool } from "pg";
import { getEmbeddingService, EmbeddingService } from "../utils/embedding";
import { createLogger } from "../services/logger";

const log = createLogger("segment-manager");

// ==================== Types ====================

/**
 * Represents a topic segment boundary within a session.
 * Segments partition a session into coherent topic units,
 * preventing entity contamination across different topics.
 */
export interface TopicSegmentInfo {
  id: string;
  sessionMapId: string;
  segmentIndex: number;
  startMessageExternalId: string;
  endMessageExternalId?: string;
  summary?: string;
  embedding?: number[];
  closedAt?: Date;
}

/**
 * Configuration for the TopicManager's sliding window
 * topic boundary detection algorithm.
 */
export interface TopicManagerConfig {
  /** Number of recent events to keep in the sliding window for comparison. Default: 3 */
  windowSize: number;
  /** Cosine similarity threshold below which a new topic segment is created. Default: 0.3 */
  mutationThreshold: number;
}

/**
 * Standard event shape accepted by classifyEvent().
 * Compatible with tool.execute.after, message.updated, and general events.
 */
export type StandardEvent = {
  type: string;
  session?: { id: string };
  messageId?: string;
  tool?: {
    name: string;
    parameters?: Record<string, any>;
  };
  result?: {
    success: boolean;
    data?: any;
    error?: string;
  };
  message?: {
    id: string;
    content?: string;
    role?: string;
  };
  [key: string]: any;
};

// ==================== Defaults ====================

const DEFAULT_CONFIG: TopicManagerConfig = {
  windowSize: 3,
  mutationThreshold: 0.3,
};

/** Minimum text length to consider for topic classification. Shorter messages are skipped. */
const MIN_TEXT_LENGTH = 10;

// ==================== Math Utilities ====================

/**
 * Compute cosine similarity between two embedding vectors.
 * cos(a,b) = (a·b) / (|a| * |b|)
 * Returns 0 if either vector is empty or has zero magnitude.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  const minLen = Math.min(a.length, b.length);

  for (let i = 0; i < minLen; i++) {
    dotProduct += a[i] * b[i];
  }
  for (let i = 0; i < a.length; i++) {
    normA += a[i] * a[i];
  }
  for (let i = 0; i < b.length; i++) {
    normB += b[i] * b[i];
  }

  const magnitudeA = Math.sqrt(normA);
  const magnitudeB = Math.sqrt(normB);

  if (magnitudeA === 0 || magnitudeB === 0) return 0;

  return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Normalize a vector to unit length (L2 norm = 1).
 * Returns a copy; does not mutate the input.
 */
function normalizeVector(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) return [...v];
  return v.map((x) => x / norm);
}

// ==================== TopicManager ====================

/**
 * Intra-session topic boundary detector using sliding window embedding similarity.
 *
 * How it works:
 * 1. Each incoming event is embedded (via the shared EmbeddingService).
 * 2. The embedding is added to a fixed-size window buffer.
 * 3. Average cosine similarity between window items and the current segment's
 *    centroid embedding is computed.
 * 4. If similarity drops below `mutationThreshold`, the current segment is closed
 *    and a new one begins. Otherwise, the segment centroid is updated via
 *    moving average (0.7 current + 0.3 new).
 *
 * This prevents entity contamination across different topics within the same
 * OpenCode session.
 */
export class TopicManager {
  /** Internal UUID from the sessions table (session_map_id). */
  private sessionMapId: string;

  /** External OpenCode session ID (as seen in event.session.id). */
  private opencodeSessionId: string;

  /** All topic segments for this session, ordered by segmentIndex. */
  private segments: TopicSegmentInfo[];

  /** The currently open (unclosed) segment, if any. */
  private currentSegment: TopicSegmentInfo | null;

  /**
   * Fixed-size sliding window of recent event embeddings.
   * Used to detect topic drift by comparing against the segment centroid.
   */
  private windowBuffer: Array<{ messageId: string; embedding: number[] }>;

  /** Maximum number of items in the window buffer. */
  private readonly windowSize: number;

  /** Cosine similarity threshold for topic boundary detection. */
  private readonly mutationThreshold: number;

  /** PostgreSQL connection pool. */
  private pool: Pool;

  constructor(
    pool: Pool,
    sessionMapId: string,
    opencodeSessionId: string,
    config?: Partial<TopicManagerConfig>,
  ) {
    this.pool = pool;
    this.sessionMapId = sessionMapId;
    this.opencodeSessionId = opencodeSessionId;
    this.segments = [];
    this.currentSegment = null;
    this.windowBuffer = [];
    this.windowSize = config?.windowSize ?? DEFAULT_CONFIG.windowSize;
    this.mutationThreshold =
      config?.mutationThreshold ?? DEFAULT_CONFIG.mutationThreshold;
  }

  // ==================== Public Core API ====================

  /**
   * Classify an incoming event: decide whether it belongs to the current
   * topic segment or triggers a new one.
   *
   * This is the primary entry point for the event handler.
   * Call this for every tool.execute.after and message.updated event.
   *
   * @returns The TopicSegmentInfo this event belongs to.
   */
  async classifyEvent(event: StandardEvent): Promise<TopicSegmentInfo> {
    const text = this.extractTextFromEvent(event);

    // ── Short text skip ──────────────────────────────────────────
    // Messages shorter than MIN_TEXT_LENGTH are not informative
    // enough to warrant topic boundary detection.
    if (!text || text.length < MIN_TEXT_LENGTH) {
      if (this.currentSegment) return this.currentSegment;
      // Create an initial segment even for short messages so we always have one.
      return this.createNewSegment(
        this.sessionMapId,
        this.segments.length,
        event.messageId || "auto",
      );
    }

    // ── Generate embedding ────────────────────────────────────────
    let embedding: number[] = [];
    const embService = getEmbeddingService();
    if (embService) {
      try {
        embedding = await embService.generateEmbedding(text);
      } catch (err) {
        console.warn(
          "[TopicManager] Embedding generation failed, using zero vector fallback:",
          err,
        );
        embedding = [];
      }
    } else {
      console.warn(
        "[TopicManager] EmbeddingService unavailable — topic detection disabled",
      );
    }

    // ── Create first segment if none exists ───────────────────────
    if (!this.currentSegment) {
      const seg = await this.createNewSegment(
        this.sessionMapId,
        this.segments.length,
        event.messageId || "auto",
      );
      this.currentSegment = seg;
      this.currentSegment.embedding = embedding;
      if (embedding.length > 0) {
        this.windowBuffer.push({
          messageId: event.messageId || "auto",
          embedding,
        });
      }
      return seg;
    }

    // ── No embedding available → stay in current segment ──────────
    if (embedding.length === 0) {
      return this.currentSegment;
    }

    // ── Sliding window management ─────────────────────────────────
    this.windowBuffer.push({ messageId: event.messageId || "auto", embedding });
    while (this.windowBuffer.length > this.windowSize) {
      this.windowBuffer.shift();
    }

    // ── Topic boundary detection ──────────────────────────────────
    const centroid = this.currentSegment.embedding;
    if (centroid && centroid.length > 0 && this.windowBuffer.length >= 2) {
      const similarities = this.windowBuffer.map((item) =>
        cosineSimilarity(item.embedding, centroid!),
      );
      const avgSimilarity =
        similarities.reduce((sum, s) => sum + s, 0) / similarities.length;

      if (avgSimilarity < this.mutationThreshold) {
        // Topic shift detected: close old segment, start new one.
        const boundaryMessageId =
          this.windowBuffer[0]?.messageId || event.messageId || "auto";
        await this.closeCurrentSegment(boundaryMessageId);

        const newSeg = await this.createNewSegment(
          this.sessionMapId,
          this.segments.length,
          event.messageId || "auto",
        );
        this.currentSegment = newSeg;
        this.currentSegment.embedding = embedding;

        // Reset window: only the current event belongs to the new segment.
        this.windowBuffer = [
          { messageId: event.messageId || "auto", embedding },
        ];

        console.log(
          `[TopicManager] Topic shift detected (similarity=${avgSimilarity.toFixed(3)} < ${this.mutationThreshold}), ` +
            `new segment #${newSeg.segmentIndex} created`,
        );
        return newSeg;
      }

      // ── No shift: update segment centroid via moving average ────
      this.currentSegment.embedding = this.updateSegmentEmbedding(
        centroid,
        embedding,
      );
    } else if (!centroid || centroid.length === 0) {
      // First meaningful embedding for this segment.
      this.currentSegment.embedding = embedding;
    }

    return this.currentSegment;
  }

  /**
   * Create a new topic segment in the database and track it in memory.
   */
  async createNewSegment(
    sessionMapId: string,
    index: number,
    startMessageId: string,
  ): Promise<TopicSegmentInfo> {
    const result = await this.pool.query(
      `INSERT INTO topic_segments (session_map_id, segment_index, start_message_external_id)
       VALUES ($1, $2, $3)
       RETURNING id, session_map_id, segment_index, start_message_external_id, created_at`,
      [sessionMapId, index, startMessageId],
    );

    const row = result.rows[0];
    const segment: TopicSegmentInfo = {
      id: row.id,
      sessionMapId: row.session_map_id,
      segmentIndex: row.segment_index,
      startMessageExternalId: row.start_message_external_id,
    };

    this.segments.push(segment);
    return segment;
  }

  /**
   * Close the current topic segment: generate a summary, compute its
   * embedding, and persist both to the database.
   *
   * After calling this, `currentSegment` is set to null.
   */
  async closeCurrentSegment(endMessageId: string): Promise<void> {
    if (!this.currentSegment) return;

    const seg = this.currentSegment;

    // ── Generate summary ────────────────────────────────────────
    let summary = "";
    try {
      summary = await this.retrieveSegmentSummary(seg.id);
    } catch (err) {
      console.warn("[TopicManager] Summary generation failed:", err);
      summary = `Segment #${seg.segmentIndex}`;
    }

    // ── Generate embedding for the summary ──────────────────────
    let summaryEmbedding: number[] = [];
    const embService = getEmbeddingService();
    if (embService && summary) {
      try {
        summaryEmbedding = await embService.generateEmbedding(summary);
      } catch (err) {
        console.warn(
          "[TopicManager] Summary embedding generation failed:",
          err,
        );
      }
    }

    // ── Persist closure to database ─────────────────────────────
    await this.pool.query(
      `UPDATE topic_segments
       SET summary = $1,
           embedding = $2,
           end_message_external_id = $3,
           closed_at = NOW()
       WHERE id = $4`,
      [
        summary || null,
        summaryEmbedding.length > 0 ? summaryEmbedding : null,
        endMessageId,
        seg.id,
      ],
    );

    // ── Update in-memory state ──────────────────────────────────
    seg.summary = summary;
    seg.embedding = summaryEmbedding.length > 0 ? summaryEmbedding : undefined;
    seg.endMessageExternalId = endMessageId;
    seg.closedAt = new Date();

    this.currentSegment = null;
    console.log(
      `[TopicManager] Closed segment #${seg.segmentIndex}: ${summary}`,
    );
  }

  /**
   * Close all currently open segments (should be called when the
   * OpenCode session ends or is compacted).
   *
   * Updates the session's last_active_at timestamp.
   */
  async closeAllPendingSegments(): Promise<void> {
    if (this.currentSegment) {
      await this.closeCurrentSegment("session-end");
    }

    // Update session timestamp (updated_at serves as last_active_at proxy).
    try {
      await this.pool.query(
        `UPDATE sessions SET updated_at = NOW() WHERE id = $1`,
        [this.sessionMapId],
      );
    } catch (err) {
      console.warn("[TopicManager] Failed to update session timestamp:", err);
    }

    this.windowBuffer = [];
  }

  /**
   * Generate a 1-sentence summary for a segment by inspecting its
   * observations and producing a heuristic or LLM-generated description.
   *
   * Uses a heuristic by default (tool name aggregation). The LLM path
   * can be wired in later for higher-quality summaries.
   */
  async retrieveSegmentSummary(segmentId: string): Promise<string> {
    // Retrieve observations that fall within this segment's time range.
    const result = await this.pool.query(
      `SELECT o.tool_name, o.tool_input_summary, o.tool_output_summary
       FROM observations o
       JOIN topic_segments ts ON ts.session_map_id = o.session_id
       WHERE ts.id = $1
         AND o.created_at >= ts.created_at
         AND (ts.closed_at IS NULL OR o.created_at <= ts.closed_at)
       ORDER BY o.created_at ASC
       LIMIT 50`,
      [segmentId],
    );

    if (result.rows.length === 0) {
      // Fallback: get recent observations for the session.
      const fallbackResult = await this.pool.query(
        `SELECT tool_name, tool_input_summary
         FROM observations
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [this.sessionMapId],
      );

      if (fallbackResult.rows.length === 0) {
        return "Empty segment";
      }

      const toolNames = [
        ...new Set(
          fallbackResult.rows.map((r: any) => r.tool_name).filter(Boolean),
        ),
      ];

      return (
        `Topic segment covering ${fallbackResult.rows.length} observations` +
        (toolNames.length > 0
          ? ` using tools: ${toolNames.slice(0, 5).join(", ")}`
          : "")
      );
    }

    const toolNames = [
      ...new Set(result.rows.map((r: any) => r.tool_name).filter(Boolean)),
    ];

    // Heuristic 1-sentence summary.
    let summary = `Topic segment with ${result.rows.length} observations`;

    if (toolNames.length > 0) {
      summary += ` covering: ${toolNames.slice(0, 5).join(", ")}`;
    }

    // Add a hint about the first tool's input for context.
    if (result.rows[0]?.tool_input_summary) {
      const firstInput = String(result.rows[0].tool_input_summary).substring(
        0,
        80,
      );
      summary += ` — starts with ${firstInput}`;
    }

    return summary;
  }

  // ==================== Static Factory ====================

  /**
   * Factory method: resolve the internal session_map_id from the
   * OpenCode session ID, load any existing segments, and return a
   * fully initialized TopicManager.
   *
   * Typical usage:
   *   const tm = await TopicManager.forSession(pool, event.session.id);
   */
  static async forSession(
    pool: Pool,
    opencodeSessionId: string,
    config?: Partial<TopicManagerConfig>,
  ): Promise<TopicManager> {
    // Resolve internal session UUID.
    const sessionResult = await pool.query(
      `SELECT id FROM sessions WHERE external_id = $1`,
      [opencodeSessionId],
    );

    if (sessionResult.rows.length === 0) {
      throw new Error(
        `[TopicManager] Session not found for OpenCode session ID: ${opencodeSessionId}. ` +
          `Ensure the session has been recorded before creating a TopicManager.`,
      );
    }

    const sessionMapId: string = sessionResult.rows[0].id;
    const manager = new TopicManager(
      pool,
      sessionMapId,
      opencodeSessionId,
      config,
    );

    // Load existing segments from DB.
    const segmentsResult = await pool.query(
      `SELECT id, session_map_id, segment_index,
              start_message_external_id, end_message_external_id,
              summary, embedding, closed_at, created_at
       FROM topic_segments
       WHERE session_map_id = $1
       ORDER BY segment_index ASC`,
      [sessionMapId],
    );

    manager.segments = segmentsResult.rows.map((row: any) => ({
      id: row.id,
      sessionMapId: row.session_map_id,
      segmentIndex: row.segment_index,
      startMessageExternalId: row.start_message_external_id,
      endMessageExternalId: row.end_message_external_id ?? undefined,
      summary: row.summary ?? undefined,
      embedding: row.embedding ?? undefined,
      closedAt: row.closed_at ?? undefined,
    }));

    // Restore currentSegment (the last unclosed segment, if any).
    const openSegment = manager.segments.find((s) => !s.closedAt);
    if (openSegment) {
      manager.currentSegment = openSegment;
    }

    return manager;
  }

  // ==================== Accessors ====================

  /** Returns the internal session UUID (session_map_id). */
  getSessionMapId(): string {
    return this.sessionMapId;
  }

  /** Returns the OpenCode external session ID. */
  getOpenCodeSessionId(): string {
    return this.opencodeSessionId;
  }

  /** Returns the current segment ID, or null if no segment is open. */
  getCurrentSegmentId(): string | null {
    return this.currentSegment?.id ?? null;
  }

  /** Returns the current segment, or null. */
  getCurrentSegment(): TopicSegmentInfo | null {
    return this.currentSegment;
  }

  /** Returns all segments for this session (including closed ones). */
  getSegments(): TopicSegmentInfo[] {
    return [...this.segments];
  }

  // ==================== Private Helpers ====================

  /**
   * Extract a representative text string from an event for embedding.
   *
   * - For tool.execute.after events: combines tool name with a snippet
   *   of the result output.
   * - For message events: uses the message content directly.
   * - For all others: falls back to the event type string.
   */
  private extractTextFromEvent(event: StandardEvent): string {
    // Tool result events (tool.execute.after).
    if (event.tool?.name && event.result) {
      const toolName = event.tool.name;
      let resultStr: string;

      if (!event.result.success) {
        resultStr = event.result.error || "error";
      } else if (
        event.result.data === undefined ||
        event.result.data === null
      ) {
        resultStr = "success";
      } else if (typeof event.result.data === "string") {
        resultStr = event.result.data.substring(0, 300);
      } else {
        try {
          resultStr = JSON.stringify(event.result.data).substring(0, 300);
        } catch {
          resultStr = "complex data";
        }
      }

      return `${toolName}: ${resultStr}`;
    }

    // Message events (message.updated).
    if (event.message?.content) {
      return event.message.content;
    }

    // Direct content field (some message variants).
    const eventRecord = event as Record<string, unknown>;
    if (typeof eventRecord.content === "string") {
      return eventRecord.content;
    }

    // Fallback: event type provides minimal context.
    return event.type || "unknown";
  }

  /**
   * Update a segment's centroid embedding using a moving average.
   *
   * Formula: 0.7 * current + 0.3 * new, then normalized to unit length.
   *
   * This ensures the centroid slowly tracks topic drift within a segment
   * while remaining anchored to the dominant theme.
   *
   * Gracefully handles mismatched vector lengths and null/empty inputs.
   */
  private updateSegmentEmbedding(
    current: number[],
    newEmb: number[],
  ): number[] {
    if (!current || current.length === 0) return [...newEmb];
    if (!newEmb || newEmb.length === 0) return [...current];

    const length = Math.min(current.length, newEmb.length);
    const result = new Array(length);

    for (let i = 0; i < length; i++) {
      result[i] = 0.7 * current[i] + 0.3 * newEmb[i];
    }

    return normalizeVector(result);
  }
}
