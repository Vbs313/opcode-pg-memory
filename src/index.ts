import { Pool } from 'pg';
import { initializeDatabase, closeDatabase, DatabaseConfig } from './db/init-db';
import { handleSessionCreated } from './hooks/session-created';
import { handleToolExecuteBefore, handleToolExecuteAfter } from './hooks/tool-execute';
import { handleMessageUpdated } from './hooks/message-updated';
import { cleanupExpiredAccumulators } from './hooks/message-part-updated';
import { handleSessionCompacting, handleSessionCompacted } from './hooks/session-compacting';
import { handleSessionCompleted } from './hooks/session-completed';
import { recallMemory, RecallMemoryInput } from './mcp/recall-memory';
import { hindsightReflect } from './mcp/hindsight-reflect';
import { createCacheManager, SemanticCacheManager } from './cache/semantic-cache';
import { createLogger } from './services/logger';
import { PluginConfig, HindsightReflectInput, RetrievedFact } from './types';
import { calculateTokenBudget } from './utils/token-budget';
import { detectMemoryKeyword, MEMORY_NUDGE_MESSAGE } from './services/keyword';

// ============================================================================
// Plugin Type Definitions (matches official OpenCode Plugin API)
// ============================================================================

interface PluginContext {
  /** OpenCode SDK client */
  client: any;
  /** Project metadata */
  project: any;
  /** Working directory */
  directory: string;
}

/** Official Plugin export signature */
type Plugin = (ctx: PluginContext) => Promise<PluginHooks>;

interface PluginHooks {
  /** Unified event hook - receives ALL bus events */
  event?: (input: { event: { type: string; properties: Record<string, any> } }) => Promise<void>;
  /** Tool execute before - args mutation */
  'tool.execute.before'?: (input: { tool: string; sessionID: string; callID: string }, output: { args: any }) => Promise<void>;
  /** Tool execute after - title/output mutation */
  'tool.execute.after'?: (input: { tool: string; sessionID: string; callID: string; args: any }, output: { title: string; output: string; metadata: any }) => Promise<void>;
  /** Session compacting hook */
  'experimental.session.compacting'?: (input: { sessionID: string }, output: { context: string[]; prompt?: string }) => Promise<void>;
  /** Custom MCP tools */
  tool?: Record<string, PluginTool>;
  [key: string]: any;
}

interface PluginTool {
  description: string;
  args: Record<string, any>;
  execute: (args: any, context: { client: any; sessionID?: string }) => Promise<any>;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  database: {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    database: process.env.PG_DATABASE || 'opencode_memory',
    user: process.env.PG_USER || 'opencode',
    password: process.env.PG_PASSWORD || '',
    ssl: process.env.PG_SSL === 'true',
  },
  embedding: {
    model: 'text-embedding-3-small',
    dimensions: 1536,
    batchSize: 100,
  },
  cache: {
    initialThreshold: 0.92,
    adjustmentStep: 0.02,
    minThreshold: 0.85,
    maxThreshold: 0.97,
    enabled: true,
  },
  reflection: {
    observationThreshold: 30,
    segmentThreshold: 5,
    modelSize: '7b',
    offPeakHours: [1, 2, 3, 4, 5],
    enabled: true,
  },
  tokenBudget: {
    contextLimitRatio: 0.05,
    minTokens: 500,
    maxTokens: 4000,
  },
  retrieval: {
    defaultStrategies: ['semantic', 'bm25', 'graph'],
    rerankEnabled: true,
    maxResults: 10,
    weights: {
      semantic: 0.5,
      recency: 0.3,
      importance: 0.2,
    },
  },
};

// ============================================================================
// Internal Plugin State (NOT exported)
// ============================================================================

class OpenCodePGMemoryPlugin {
  pool: Pool | null = null;
  config: PluginConfig;
  cacheManager: SemanticCacheManager | null = null;
  initialized: boolean = false;
  private cleanupIntervals: ReturnType<typeof setInterval>[] = [];

  constructor(config: Partial<PluginConfig> = {}) {
    this.config = this.mergeConfig(config);
  }

  private mergeConfig(userConfig: Partial<PluginConfig>): PluginConfig {
    return {
      ...DEFAULT_PLUGIN_CONFIG,
      ...userConfig,
      database: { ...DEFAULT_PLUGIN_CONFIG.database, ...userConfig.database },
      embedding: { ...DEFAULT_PLUGIN_CONFIG.embedding, ...userConfig.embedding },
      cache: { ...DEFAULT_PLUGIN_CONFIG.cache, ...userConfig.cache },
      reflection: { ...DEFAULT_PLUGIN_CONFIG.reflection, ...userConfig.reflection },
      tokenBudget: { ...DEFAULT_PLUGIN_CONFIG.tokenBudget, ...userConfig.tokenBudget },
      retrieval: { ...DEFAULT_PLUGIN_CONFIG.retrieval, ...userConfig.retrieval },
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log('[PG Memory] Initializing plugin...');

    try {
      this.pool = await initializeDatabase(this.config.database);

      if (this.config.cache.enabled) {
        this.cacheManager = createCacheManager(this.pool, this.config.cache);
      }

      this.startCleanupTasks();
      this.initialized = true;
      console.log('[PG Memory] Plugin initialized successfully');
    } catch (error) {
      console.error('[PG Memory] Plugin initialization failed:', error);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.initialized) return;

    console.log('[PG Memory] Closing plugin...');

    for (const interval of this.cleanupIntervals) {
      clearInterval(interval);
    }
    this.cleanupIntervals = [];

    await closeDatabase();
    this.pool = null;
    this.cacheManager = null;
    this.initialized = false;

    console.log('[PG Memory] Plugin closed');
  }

  private startCleanupTasks(): void {
    // Clean up expired message part accumulators every 5 minutes
    this.cleanupIntervals.push(
      setInterval(() => {
        cleanupExpiredAccumulators(300000);
      }, 300000)
    );

    // Clean up expired cache entries daily
    this.cleanupIntervals.push(
      setInterval(async () => {
        if (this.cacheManager) {
          await this.cacheManager.cleanupExpiredCache(30);
        }
      }, 24 * 60 * 60 * 1000)
    );
  }

  getPool(): Pool {
    if (!this.pool) {
      throw new Error('Plugin not initialized. Call initialize() first.');
    }
    return this.pool;
  }

  getCacheManager(): SemanticCacheManager | null {
    return this.cacheManager;
  }
}

// ============================================================================
// Plugin Export - Official OpenCode Plugin API format
// ============================================================================

export const OpenCodePGMemory: Plugin = async (ctx: PluginContext) => {
  // Read config from environment
  const config = buildConfigFromEnv();

  // Create internal state
  const plugin = new OpenCodePGMemoryPlugin(config);
  await plugin.initialize();

  // Cleanup on process exit
  const cleanup = () => {
    plugin.close().catch((err) => console.error('[PG Memory] Cleanup error:', err));
  };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const pool = plugin.getPool();
  const cacheManager = plugin.getCacheManager();
  const logger = createLogger('plugin');

  // Track sessions that have received memory injection
  const injectedSessions = new Set<string>();
  const injectedSystemPrompt = new Set<string>();

  // ==========================================================================
  // Return hooks object
  // ==========================================================================

  return {
    // -----------------------------------------------------------------------
    // Unified event hook - receives ALL bus events
    // -----------------------------------------------------------------------
    event: async (input: { event: { type: string; properties: Record<string, any> } }) => {
      const { type, properties } = input.event;

      try {
        switch (type) {
          // --- session.created: ensure session_map entry, inject memories ---
          case 'session.created': {
            const sessionData = properties.session || properties;
            const output: { context?: { memories?: string[]; facts?: string[] } } = {};

            await handleSessionCreated(
              { session: normalizeSessionData(sessionData) },
              output as any,
              pool,
              {
                contextLimitRatio: plugin.config.tokenBudget.contextLimitRatio,
                minTokens: plugin.config.tokenBudget.minTokens,
                maxTokens: plugin.config.tokenBudget.maxTokens,
              }
            );

            // Attempt to inject memories via client if available
            if (output.context?.memories?.length && ctx.client?.experimental?.chat?.system?.transform) {
              try {
                for (const memory of output.context.memories) {
                  await ctx.client.experimental.chat.system.transform(memory);
                }
              } catch (err) {
                console.warn('[PG Memory] Failed to inject memories via client:', err);
              }
            }
            break;
          }

          // --- session.compacted: mark cache entries as pruned ---
          case 'session.compacted': {
            const sid = properties.sessionID || properties.session?.id;
            if (sid) {
              await handleSessionCompacted(
                {
                  session: { id: sid },
                  messagesToCompact: properties.messagesToCompact || [],
                  compactionStrategy: properties.compactionStrategy || 'prune',
                },
                {} as any,
                pool
              );

              // Also mark cache entries as pruned via cache manager
              if (cacheManager && properties.messagesToCompact?.length) {
                try {
                  const obsResult = await pool.query(
                    'SELECT id FROM observations WHERE session_id = (SELECT id FROM sessions WHERE external_id = $1) AND message_id = ANY($2)',
                    [sid, properties.messagesToCompact]
                  );
                  if (obsResult.rows.length > 0) {
                    await cacheManager.markMultipleAsPruned(obsResult.rows.map((r: any) => r.id));
                  }
                } catch (err) {
                  console.warn('[PG Memory] Failed to mark cache pruned:', err);
                }
              }

              // Save compaction summary as reflection
              const summaryText = properties.summary || properties.compactionSummary;
              if (summaryText && String(summaryText).length >= 100) {
                try {
                  const sessionResult = await pool.query(
                    'SELECT id FROM sessions WHERE external_id = $1',
                    [sid]
                  );
                  if (sessionResult.rows.length > 0) {
                    await pool.query(`
                      INSERT INTO reflections (session_id, summary, source_observation_ids, confidence, pattern_type, metadata)
                      VALUES ($1, $2, $3, $4, $5, $6)
                    `, [
                      sessionResult.rows[0].id,
                      `[Session Summary] ${String(summaryText)}`,
                      properties.messageIds || [],
                      0.8,
                      'session_summary',
                      JSON.stringify({ savedAt: new Date().toISOString() }),
                    ]);
                    logger.info('Saved session summary as reflection', { sessionID: sid });
                  }
                } catch (err) {
                  logger.warn('Failed to save session summary', err);
                }
              }
            }
            break;
          }

          // --- session.deleted: cleanup related data ---
          case 'session.deleted': {
            const sid = properties.sessionID || properties.session?.id;
            if (sid) {
              try {
                const sessionResult = await pool.query(
                  'SELECT id FROM sessions WHERE external_id = $1',
                  [sid]
                );
                if (sessionResult.rows.length > 0) {
                  const internalId = sessionResult.rows[0].id;
                  // CASCADE deletes handle observations, entities, relations, reflections, token_logs
                  await pool.query('DELETE FROM sessions WHERE id = $1', [internalId]);
                  console.log(`[PG Memory] Cleaned up deleted session: ${sid}`);
                }
              } catch (err) {
                console.error('[PG Memory] Error cleaning up deleted session:', err);
              }
            }
            break;
          }

          // --- session.idle / session.completed: trigger reflection ---
          case 'session.idle':
          case 'session.completed': {
            const sid = properties.sessionID || properties.session?.id;
            const sessionInfo = properties.session || {};
            if (sid) {
              await handleSessionCompleted(
                {
                  session: {
                    id: sid,
                    projectId: sessionInfo.projectId,
                    messageCount: properties.messageCount || sessionInfo.messageCount || 0,
                    durationMs: properties.durationMs || sessionInfo.durationMs || 0,
                  },
                  summary: properties.summary,
                },
                {} as any,
                pool,
                {
                  minObservationThreshold: plugin.config.reflection.observationThreshold,
                  enableReflection: plugin.config.reflection.enabled,
                  offPeakHours: plugin.config.reflection.offPeakHours,
                }
              );
            }
            break;
          }

          // --- message.updated: extract entities (fire-and-forget, non-blocking) ---
          case 'message.updated': {
            const sid = properties.sessionID || properties.session?.id;
            if (sid && properties.message) {
              handleMessageUpdated(
                { session: { id: sid }, message: properties.message },
                {} as any,
                pool
              ).catch((err) => console.warn('[PG Memory] message.updated handler error:', err));
            }
            break;
          }

          // --- message.part.updated: accumulate tool output ---
          case 'message.part.updated': {
            // Handled by message-part-updated internals (accumulator),
            // we just ensure the session is tracked
            break;
          }

          // --- tool.execute.after (fallback if direct hook not used) ---
          case 'tool.execute.after': {
            const sid = properties.sessionID || properties.session?.id;
            if (sid) {
              const result = properties.result || {
                success: properties.success !== false,
                data: properties.output || properties.data,
                error: properties.error,
              };
              await handleToolExecuteAfter(
                {
                  session: { id: sid },
                  tool: {
                    name: properties.tool || properties.toolName || 'unknown',
                    parameters: properties.args || properties.parameters || {},
                  },
                  result,
                  messageId: properties.callID || properties.messageId || '',
                  executionTimeMs: properties.executionTimeMs || 0,
                },
                {} as any,
                pool
              );
            }
            break;
          }

          default:
            // Unknown event type - silently ignore
            break;
        }
      } catch (error) {
        console.error(`[PG Memory] Error handling event '${type}':`, error);
        // Never let hook errors propagate to OpenCode
      }
    },

    // -----------------------------------------------------------------------
    // chat.message - inject relevant memories on first message
    // -----------------------------------------------------------------------
    'chat.message': async (
      input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string }; messageID?: string; variant?: string },
      output: { message: any; parts: any[] }
    ) => {
      try {
        // Only inject on the first message of a session
        if (!injectedSessions.has(input.sessionID)) {
          injectedSessions.add(input.sessionID);

          logger.info('First message in session', { sessionID: input.sessionID });

          // Retrieve relevant facts for this session
          const contextLimit = 128000; // default model context limit
          const budget = calculateTokenBudget(contextLimit, config.tokenBudget || {});
          const facts = await retrieveFactsForInjection(
            input.sessionID,
            { maxTokens: typeof budget === 'number' ? budget : 2000 },
            pool,
            { minConfidence: 0.5, minWeight: 0.3 }
          );

          if (facts.length > 0) {
            // Format as context block
            const contextBlock = formatMemoryContext(facts);

            // Inject as synthetic part (visible to LLM, hidden in TUI)
            if (output.parts && Array.isArray(output.parts)) {
              output.parts.unshift({
                id: `prt_pgmemory-context-${Date.now()}`,
                sessionID: input.sessionID,
                messageID: output.message?.id || input.messageID || '',
                type: 'text',
                text: contextBlock,
                synthetic: true,
              });
              logger.info(`Injected ${facts.length} memories`, { sessionID: input.sessionID });
            }
          } else {
            logger.debug('No memories to inject');
          }
        }

        // Check for memory keywords AFTER first-message injection
        const userText = output.parts
          .filter((p: any) => p.type === 'text' && !p.synthetic)
          .map((p: any) => p.text || '')
          .join(' ');

        if (detectMemoryKeyword(userText)) {
          logger.info('Memory keyword detected', { sessionID: input.sessionID });
          output.parts.push({
            id: `prt_pgmemory-nudge-${Date.now()}`,
            sessionID: input.sessionID,
            messageID: output.message?.id || input.messageID || '',
            type: 'text',
            text: MEMORY_NUDGE_MESSAGE,
            synthetic: true,
          });
        }
      } catch (error) {
        logger.error('Failed to inject memories in chat.message', error);
        // Non-blocking: never crash the message flow
      }
    },

    // -----------------------------------------------------------------------
    // tool.execute.before - intercept before tool execution
    // -----------------------------------------------------------------------
    'tool.execute.before': async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: any }
    ) => {
      try {
        await handleToolExecuteBefore(
          {
            session: { id: input.sessionID },
            tool: { name: input.tool, parameters: output.args || {} },
            messageId: input.callID,
          },
          { parameters: output.args },
          pool
        );
      } catch (error) {
        console.error('[PG Memory] Error in tool.execute.before:', error);
      }
    },

    // -----------------------------------------------------------------------
    // tool.execute.after - intercept after tool execution
    // -----------------------------------------------------------------------
    'tool.execute.after': async (
      input: { tool: string; sessionID: string; callID: string; args: any },
      output: { title: string; output: string; metadata: any }
    ) => {
      try {
        const result = {
          success: !(output.output && output.output.toLowerCase().includes('error')),
          data: output.output,
          error: output.output && output.output.toLowerCase().includes('error') ? output.output : undefined,
        };

        await handleToolExecuteAfter(
          {
            session: { id: input.sessionID },
            tool: { name: input.tool, parameters: input.args || {} },
            result,
            messageId: input.callID,
            executionTimeMs: output.metadata?.executionTimeMs || 0,
          },
          {} as any,
          pool
        );
      } catch (error) {
        console.error('[PG Memory] Error in tool.execute.after:', error);
      }
    },

    // -----------------------------------------------------------------------
    // experimental.chat.system.transform - inject MCP tool usage instructions
    // -----------------------------------------------------------------------
    'experimental.chat.system.transform': async (
      input: { sessionID?: string; model: { id: string; contextLimit: number; name: string } },
      output: { system: string[] }
    ) => {
      try {
        const sessionId = input.sessionID || 'default';
        if (injectedSystemPrompt.has(sessionId)) return;
        injectedSystemPrompt.add(sessionId);

        output.system = output.system || [];
        output.system.push(`## PG Memory Tools Available

You have access to long-term memory via the pg-memory plugin. These tools help you reuse knowledge across sessions:

### recall_memory — search historical memories
Call this BEFORE starting any new task. It retrieves relevant entities, observations, and reflections from past sessions.
- Example: recall_memory({ query: "database connection pool tuning" })
- Best practice: always pass your current task goal as the query

### hindsight_reflect — reflect on session
Call this AFTER completing significant work to extract reusable patterns.
- Example: hindsight_reflect({ trigger_type: "manual" })
- Reflexions are automatically available in future sessions

### When to use
- Before diving into a new problem → recall_memory(query=<your goal>)
- After completing a major task → hindsight_reflect()
- When you need historical context about a specific topic → recall_memory(topic_segment_id=<id>)
`);
      } catch (error) {
        console.error('[PG Memory] Error in system.transform:', error);
      }
    },

    // -----------------------------------------------------------------------
    // experimental.session.compacting - session compaction hook
    // -----------------------------------------------------------------------
    'experimental.session.compacting': async (
      input: { sessionID: string },
      output: { context: string[]; prompt?: string }
    ) => {
      try {
        // Show compaction notification
        if (ctx.client?.tui?.showToast) {
          ctx.client.tui.showToast({
            body: {
              title: 'PG Memory Compaction',
              message: 'Compacting with pg-memory context...',
              variant: 'warning',
              duration: 3000,
            },
          }).catch(() => {});
        }

        await handleSessionCompacting(
          {
            session: { id: input.sessionID },
            messagesToCompact: output.context || [],
            compactionStrategy: 'prune',
          },
          { preserveMessageIds: [] },
          pool
        );

        // Show success toast
        if (ctx.client?.tui?.showToast) {
          setTimeout(() => {
            ctx.client.tui.showToast({
              body: {
                title: 'Compaction Complete',
                message: 'PG Memory preserved high-value observations',
                variant: 'success',
                duration: 2000,
              },
            }).catch(() => {});
          }, 500);
        }
      } catch (error) {
        console.error('[PG Memory] Error in experimental.session.compacting:', error);
      }
    },

    // -----------------------------------------------------------------------
    // Custom MCP Tools
    // -----------------------------------------------------------------------
    tool: {
      recall_memory: {
        description:
          '从长期记忆中检索相关事实、实体、观察和反思，支持多策略并行检索（语义+BM25+图遍历）。使用多维评分函数：Relevance = 0.5*SemSim + 0.3/(1+RecencyDays) + 0.2*Importance',
        args: {
          query: {
            type: 'string',
            description: '检索查询文本',
          },
          session_id: {
            type: 'string',
            description: '当前会话ID，用于上下文过滤',
          },
          retrieval_strategies: {
            type: 'array',
            items: { type: 'string', enum: ['semantic', 'bm25', 'graph', 'keyword'] },
            default: ['semantic', 'bm25', 'graph'],
            description: '检索策略组合',
          },
          max_results: {
            type: 'number',
            minimum: 1,
            maximum: 50,
            default: 10,
            description: '返回结果数量上限',
          },
          filters: {
            type: 'object',
            properties: {
              entity_types: {
                type: 'array',
                items: { type: 'string' },
                description: '实体类型过滤',
              },
              tier_levels: {
                type: 'array',
                items: { enum: ['permanent', 'project', 'session'] },
                description: '层级过滤',
              },
              min_confidence: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                default: 0.5,
                description: '最低置信度',
              },
              time_range_days: {
                type: 'number',
                description: '时间范围（天）',
              },
            },
          },
          rerank: {
            type: 'boolean',
            default: true,
            description: '是否使用交叉编码器重排序',
          },
        },
        execute: async (args: RecallMemoryInput, _context: { client: any; sessionID?: string }) => {
          return recallMemory(args, pool, {
            maxResults: plugin.config.retrieval.maxResults,
            rerankEnabled: plugin.config.retrieval.rerankEnabled,
            weights: plugin.config.retrieval.weights,
          });
        },
      },

      hindsight_reflect: {
        description:
          '对会话观察进行反思，归纳经验模式，生成可复用的反思记录。每30-50条经验触发一次，使用7B蒸馏模型在低峰期执行。',
        args: {
          session_id: {
            type: 'string',
            description: '要反思的会话ID',
          },
          trigger_type: {
            type: 'string',
            enum: ['threshold', 'scheduled', 'manual'],
            default: 'threshold',
            description: '触发类型',
          },
          observation_threshold: {
            type: 'number',
            minimum: 10,
            maximum: 100,
            default: 30,
            description: '触发反思的观察数量阈值',
          },
          model_size: {
            type: 'string',
            enum: ['7b', '14b', 'full'],
            default: '7b',
            description: '使用的模型规模',
          },
        },
        execute: async (args: HindsightReflectInput, _context: { client: any; sessionID?: string }) => {
          return hindsightReflect(args, pool, {
            observationThreshold: plugin.config.reflection.observationThreshold,
            modelSize: plugin.config.reflection.modelSize as '7b' | '14b' | 'full',
            offPeakHours: plugin.config.reflection.offPeakHours,
          });
        },
      },
    },
  };
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build plugin config from environment variables, with sensible defaults.
 */
function buildConfigFromEnv(): Partial<PluginConfig> {
  return {
    database: {
      host: process.env.PG_HOST || 'localhost',
      port: parseInt(process.env.PG_PORT || '5432', 10),
      database: process.env.PG_DATABASE || 'opencode_memory',
      user: process.env.PG_USER || 'opencode',
      password: process.env.PG_PASSWORD || '',
      ssl: process.env.PG_SSL === 'true',
    },
    embedding: {
      model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
      dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || '1536', 10),
      batchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE || '100', 10),
    },
    cache: {
      enabled: process.env.CACHE_ENABLED !== 'false',
      initialThreshold: parseFloat(process.env.CACHE_INITIAL_THRESHOLD || '0.92'),
      adjustmentStep: parseFloat(process.env.CACHE_ADJUSTMENT_STEP || '0.02'),
      minThreshold: parseFloat(process.env.CACHE_MIN_THRESHOLD || '0.85'),
      maxThreshold: parseFloat(process.env.CACHE_MAX_THRESHOLD || '0.97'),
    },
    reflection: {
      enabled: process.env.REFLECTION_ENABLED !== 'false',
      observationThreshold: parseInt(process.env.REFLECTION_OBSERVATION_THRESHOLD || '30', 10),
      segmentThreshold: parseInt(process.env.REFLECTION_SEGMENT_THRESHOLD || '5', 10),
      modelSize: (process.env.REFLECTION_MODEL_SIZE as '7b' | '14b' | 'full') || '7b',
      offPeakHours: (process.env.REFLECTION_OFF_PEAK_HOURS || '1,2,3,4,5')
        .split(',')
        .map((n) => parseInt(n.trim(), 10))
        .filter((n) => !isNaN(n)),
    },
    tokenBudget: {
      contextLimitRatio: parseFloat(process.env.TOKEN_CONTEXT_LIMIT_RATIO || '0.05'),
      minTokens: parseInt(process.env.TOKEN_MIN_TOKENS || '500', 10),
      maxTokens: parseInt(process.env.TOKEN_MAX_TOKENS || '4000', 10),
    },
    retrieval: {
      defaultStrategies: (process.env.RETRIEVAL_STRATEGIES || 'semantic,bm25,graph')
        .split(',')
        .map((s) => s.trim()),
      rerankEnabled: process.env.RETRIEVAL_RERANK !== 'false',
      maxResults: parseInt(process.env.RETRIEVAL_MAX_RESULTS || '10', 10),
      weights: {
        semantic: parseFloat(process.env.RETRIEVAL_WEIGHT_SEMANTIC || '0.5'),
        recency: parseFloat(process.env.RETRIEVAL_WEIGHT_RECENCY || '0.3'),
        importance: parseFloat(process.env.RETRIEVAL_WEIGHT_IMPORTANCE || '0.2'),
      },
    },
  };
}

/**
 * Normalize session data from various event formats into a consistent shape
 * compatible with the existing handler functions.
 */
function normalizeSessionData(data: any): {
  id: string;
  projectId?: string;
  model: { id: string; contextLimit: number; name: string };
  messages: any[];
} {
  return {
    id: data.id || data.external_id || '',
    projectId: data.projectId || data.project_id || undefined,
    model: {
      id: data.model?.id || data.modelID || data.model_id || 'unknown',
      contextLimit: data.model?.contextLimit || data.contextLimit || data.model_context_limit || 128000,
      name: data.model?.name || data.modelName || data.model_name || 'unknown',
    },
    messages: data.messages || [],
  };
}

// ============================================================================
// Chat Message Helpers
// ============================================================================

/**
 * Format memory facts into a context block for LLM consumption.
 */
function formatMemoryContext(facts: RetrievedFact[]): string {
  if (facts.length === 0) return '';
  const lines = ['[PG MEMORY]', 'Relevant context from previous sessions:', ''];
  for (const f of facts) {
    const typeLabel = f.type === 'reflection' ? 'REFLECTION'
      : f.type === 'observation' ? 'OBSERVATION'
      : f.type === 'entity' ? 'ENTITY'
      : f.type.toUpperCase();
    const tierLabel = f.tier ? ` [${f.tier}]` : '';
    const score = f.relevanceScore ? ` (${(f.relevanceScore * 100).toFixed(0)}%)` : '';
    lines.push(`- [${typeLabel}${tierLabel}] ${f.content.substring(0, 200)}${score}`);
  }
  lines.push('', 'Tip: Use recall_memory(query="...") to search more specific memories, or /pg-memory-reflect to summarize this session.');
  return lines.join('\n');
}

/**
 * Simplified inline memory retrieval for chat.message injection.
 * Queries entities with high weight directly from PG.
 */
async function retrieveFactsForInjection(
  sessionId: string,
  budget: { maxTokens: number },
  pool: any,
  config?: { minConfidence?: number; minWeight?: number }
): Promise<RetrievedFact[]> {
  const facts: RetrievedFact[] = [];
  const maxTokens = budget.maxTokens || 2000;
  let usedTokens = 0;

  try {
    const { rows } = await pool.query(`
      SELECT name, type, tier, weight, description, confidence,
             EXTRACT(EPOCH FROM (NOW() - last_seen_at)) / 86400.0 AS days_ago
      FROM entities
      WHERE weight >= $1 AND confidence >= $2
      ORDER BY tier = 'permanent' DESC, tier = 'project' DESC, weight DESC
      LIMIT 20
    `, [config?.minWeight || 0.5, config?.minConfidence || 0.5]);

    for (const row of rows) {
      const content = row.description
        ? `${row.name}: ${row.description.substring(0, 150)}`
        : `${row.name} (${row.type})`;
      const tokens = Math.ceil(content.length / 4);
      if (usedTokens + tokens > maxTokens) break;
      usedTokens += tokens;
      const recency = Math.max(0, 1 - (row.days_ago || 0) / 90);
      facts.push({
        type: 'entity',
        content,
        tier: row.tier,
        tokens,
        relevanceScore: (row.weight / 10) * 0.6 + recency * 0.4,
        metadata: { entityName: row.name, entityType: row.type, tier: row.tier },
      });
    }
  } catch (err) {
    // Non-blocking fallback - return empty
  }

  return facts;
}

// ============================================================================
// Re-exports (types and utilities for external consumers)
// NOTE: Selective exports to avoid ambiguity with ./types
// ============================================================================

export * from './types';
export * from './db/init-db';
export * from './utils/token-budget';
export * from './cache/semantic-cache';
export { recallMemory } from './mcp/recall-memory';
export { hindsightReflect } from './mcp/hindsight-reflect';
