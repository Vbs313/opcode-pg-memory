// pg-memory plugin types
// Refactored architecture: session_map replaces sessions, new topic_segments + caller_context
// SDK types used for OpenCode primitives (no more OpenCodeSession/OpenCodeMessage/OpenCodeMessagePart)

// ============================================================
// Type aliases
// ============================================================

export type EntityTier = 'permanent' | 'project' | 'session';
export type RelationType = 'belongs_to' | 'depends_on' | 'references' | 'implements' | 'uses' | 'custom';

export type PluginEventType =
  | 'session.created' | 'session.completed' | 'session.deleted'
  | 'message.updated' | 'tool.execute.before' | 'tool.execute.after'
  | 'session.compacted' | 'session.idle';

export type SyncMode = 'event-only' | 'poll-only' | 'hybrid';

export interface PluginEvent {
  id: string;           // `${type}:${sessionId}:${timestamp}`
  type: PluginEventType;
  sessionId: string;
  timestamp: number;
  version: number;
  source: 'hook' | 'poll';
  data: Record<string, any>;
}

export interface VersionedRow {
  id: string;
  version: number;
}

// ============================================================
// Core database entities (with topic_segment_id added)
// ============================================================

export interface Entity {
  id: string;
  session_id: string;
  topic_segment_id?: string;
  name: string;
  type: string;
  tier: EntityTier;
  weight: number;
  description?: string;
  embedding?: number[];
  first_seen_at: Date;
  last_seen_at: Date;
  confidence: number;
  metadata: Record<string, any>;
}

export interface Relation {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: RelationType;
  confidence: number;
  description?: string;
  created_at: Date;
  session_id: string;
  topic_segment_id?: string;
}

export interface Observation {
  id: string;
  session_id: string;
  topic_segment_id?: string;
  tool_name?: string;
  tool_input_summary?: string;
  tool_output_summary?: string;
  embedding?: number[];
  importance: number;
  created_at: Date;
  message_id?: string;
  metadata: Record<string, any>;
}

export interface Reflection {
  id: string;
  session_id: string;
  topic_segment_id?: string;
  summary: string;
  source_observation_ids: string[];
  confidence: number;
  pattern_type?: string;
  created_at: Date;
  embedding?: number[];
  metadata: Record<string, any>;
}

export interface SemanticCache {
  id: string;
  query_hash: string;
  query_text: string;
  query_embedding: number[];
  response_text: string;
  hit_count: number;
  last_hit_at: Date;
  created_at: Date;
  similarity_threshold: number;
  is_pruned: boolean;
  session_id?: string;
}

// ============================================================
// New tables: session_map, topic_segments
// ============================================================

export interface SessionMap {
  id: string;
  opencode_session_id: string;
  omo_task_id?: string;
  project_id?: string;
  model_context_limit: number;
  created_at: Date;
  last_active_at: Date;
  metadata: Record<string, any>;
}

export interface TopicSegment {
  id: string;
  session_map_id: string;
  segment_index: number;
  summary?: string;
  embedding?: number[];
  start_message_external_id?: string;
  end_message_external_id?: string;
  created_at: Date;
  closed_at?: Date;
  observation_count: number;
  metadata: Record<string, any>;
}

// Internal (camelCase) version for in-memory use
export interface TopicSegmentInfo {
  id: string;
  sessionMapId: string;
  index: number;
  summary?: string;
  embedding?: number[];
  startMessageId?: string;
  endMessageId?: string;
  observationCount: number;
}

// ============================================================
// Caller context
// ============================================================

export interface CallerContext {
  type: 'user' | 'omo_agent';
  current_goal?: string;
  current_session_id?: string;
}

// ============================================================
// Plugin configuration
// ============================================================

export interface EventSynchronizerConfig {
  mode: SyncMode;
  pollingIntervalMs: number;
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  eventDedupWindowMs: number;
}

export interface TopicConfig {
  mutationThreshold: number;
  windowSize: number;
  enableSummaryGeneration: boolean;
}

export interface PluginConfig {
  database: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl?: boolean;
  };
  embedding: {
    model: string;
    dimensions: number;
    batchSize: number;
  };
  cache: {
    initialThreshold: number;
    adjustmentStep: number;
    minThreshold: number;
    maxThreshold: number;
    enabled: boolean;
  };
  reflection: {
    observationThreshold: number;
    segmentThreshold: number;
    modelSize: '7b' | '14b' | 'full';
    offPeakHours: number[];
    enabled: boolean;
  };
  tokenBudget: {
    contextLimitRatio: number;
    minTokens: number;
    maxTokens: number;
  };
  retrieval: {
    defaultStrategies: string[];
    rerankEnabled: boolean;
    maxResults: number;
    weights: {
      semantic: number;
      recency: number;
      importance: number;
    };
  };
  topic?: TopicConfig;
  eventSynchronizer?: EventSynchronizerConfig;
}

// ============================================================
// Official OpenCode Plugin API hook signatures (flat format)
// ============================================================
// These match the real OpenCode Plugin hooks object:
//   "tool.execute.before": (input: { tool, sessionID, callID }, output: { args }) => ...
//   "tool.execute.after":  (input: { tool, sessionID, callID, args }, output: { title, output, metadata }) => ...
//   "experimental.session.compacting": (input: { sessionID }, output: { context, prompt? }) => ...
//   event: (input: { event: { type, properties } }) => ...

export interface ToolExecuteBeforeHookInput {
  tool: string;
  sessionID: string;
  callID: string;
}

export interface ToolExecuteBeforeHookOutput {
  args: any;
}

export interface ToolExecuteAfterHookInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: any;
}

export interface ToolExecuteAfterHookOutput {
  title: string;
  output: string;
  metadata: any;
}

export interface SessionCompactingHookInput {
  sessionID: string;
}

export interface SessionCompactingHookOutput {
  context: string[];
  prompt?: string;
}

export interface SessionCreatedEvent {
  sessionID: string;
}

export interface SessionCompletedEvent {
  sessionID: string;
}

export type StandardEvent =
  | { type: 'session.created'; sessionID: string }
  | { type: 'tool.execute.after'; tool: string; sessionID: string; callID: string; args: any }
  | { type: 'message.updated'; sessionID: string; messageID: string }
  | { type: 'session.compacting'; sessionID: string }
  | { type: 'session.completed'; sessionID: string };

// ============================================================
// Legacy hook types (used by hook handler functions)
// ============================================================
// The hook handler functions in src/hooks/ were written against
// these nested-structure types. They continue to use them
// internally; the plugin entrypoint adapts between flat hook
// signatures and these nested types.

export interface OpenCodeSession {
  id: string;
  projectId?: string;
  model: {
    id: string;
    contextLimit: number;
    name: string;
  };
  messages: OpenCodeMessage[];
}

export interface OpenCodeMessage {
  id: string;
  parentID?: string;
  role: 'user' | 'assistant' | 'tool';
  mode?: string;
  agent?: string;
  path?: { cwd: string; root: string };
  cost?: number;
  tokens?: {
    total: number;
    input: number;
    output: number;
    reasoning: number;
    cache: { write: number; read: number };
  };
  modelID?: string;
  providerID?: string;
  time?: { created: number; completed?: number };
  finish?: string;
  content?: string;
  summary?: { diffs: any[] };
  parts?: OpenCodeMessagePart[];
  message_id?: string;
  reasoning?: string;
  tool_calls?: OpenCodeToolCall[];
}

export interface OpenCodeMessagePart {
  type: 'reasoning' | 'text' | 'tool' | 'image' | 'audio';
  text?: string;
  time?: { start: number; end?: number };
  id: string;
  sessionID: string;
  messageID: string;
  tool?: {
    name: string;
    callID: string;
    state: {
      status: 'pending' | 'completed' | 'failed';
      input: Record<string, any>;
      output?: any;
      filepath?: string;
    };
  };
}

export interface OpenCodeToolCall {
  type: string;
  tool: string;
  callID: string;
  input: Record<string, any>;
  output?: any;
  status: string;
  filepath?: string;
  exists?: boolean;
  truncated?: boolean;
}

export interface SessionCreatedInput {
  session: OpenCodeSession;
}

export interface SessionCreatedOutput {
  context?: { memories?: string[]; facts?: string[] };
}

export interface ToolExecuteBeforeInput {
  session: { id: string };
  tool: { name: string; parameters: Record<string, any> };
  messageId: string;
}

export interface ToolExecuteBeforeOutput {
  parameters?: Record<string, any>;
}

export interface ToolExecuteAfterInput {
  session: { id: string };
  tool: { name: string; parameters: Record<string, any> };
  result: { success: boolean; data?: any; error?: string };
  messageId: string;
  executionTimeMs: number;
}

export interface ToolExecuteAfterOutput {
  // no output
}

export interface MessageUpdatedInput {
  session: { id: string };
  message: OpenCodeMessage;
}

export interface MessageUpdatedOutput {
  // no output
}

export interface MessagePartUpdatedInput {
  session: { id: string };
  message: {
    id: string;
    partIndex: number;
    content: string;
    isComplete: boolean;
  };
}

export interface MessagePartUpdatedOutput {
  // no output
}

export interface SessionCompactingInput {
  session: { id: string };
  messagesToCompact: string[];
  compactionStrategy: 'prune' | 'summarize' | 'archive';
}

export interface SessionCompactingOutput {
  preserveMessageIds?: string[];
}

export interface SessionCompletedInput {
  session: {
    id: string;
    projectId?: string;
    messageCount: number;
    durationMs: number;
  };
  summary?: string;
}

export interface SessionCompletedOutput {
  // no output
}

// ============================================================
// Retrieval & Reflection types
// ============================================================

export interface RetrievedFact {
  id?: string;
  type: 'entity' | 'observation' | 'reflection' | 'relation' | 'message';
  content: string;
  tier?: EntityTier;
  tokens: number;
  relevanceScore: number;
  metadata: Record<string, any>;
}

export interface CacheResult {
  hit: boolean;
  response?: string;
  similarity?: number;
}

// ------------------------------------------------------------------
// Hindsight Reflect I/O (used by mcp/hindsight-reflect)
// ------------------------------------------------------------------

export interface HindsightReflectInput {
  session_id?: string;
  omo_task_id?: string;
  topic_segment_id?: string;
  trigger_type?: 'threshold' | 'scheduled' | 'manual';
  observation_threshold?: number;
  model_size?: '7b' | '14b' | 'full';
  aggregate?: boolean;
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

// NOTE: RecallMemoryInput / RecallMemoryOutput are defined in
// src/mcp/recall-memory.ts (self-contained module).
