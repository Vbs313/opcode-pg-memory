import { Pool } from "pg";
import { initializeDatabase, closeDatabase } from "./db/init-db";
import {
  createCacheManager,
  SemanticCacheManager,
} from "./cache/semantic-cache";
import { cleanupExpiredAccumulators } from "./hooks/message-part-updated";
import { createLogger } from "./services/logger";
import { PluginConfig } from "./types";
import { initializeServices } from "./services/plugin-initializer";
import { buildHooks, HookBuilderContext } from "./services/hook-builder";
import { buildTools, PluginState } from "./services/tool-registry";

const logger = createLogger("plugin");

// NOTE: We define our own simplified Plugin type because the SDK's
// PluginInput has deps on @opencode-ai/sdk types not available at compile time.
interface PluginInput {
  client: any;
  project: any;
  directory: string;
  worktree?: string;
}
type Plugin = (ctx: PluginInput) => Promise<Record<string, any>>;

// Default Configuration
const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  database: {
    host: process.env.PG_HOST || "localhost",
    port: parseInt(process.env.PG_PORT || "5432", 10),
    database: process.env.PG_DATABASE || "opencode_memory",
    user: process.env.PG_USER || "opencode",
    password: process.env.PG_PASSWORD || "",
    ssl: process.env.PG_SSL === "true",
  },
  embedding: {
    model: "text-embedding-3-small",
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
    modelSize: "7b",
    offPeakHours: [1, 2, 3, 4, 5],
    enabled: true,
  },
  tokenBudget: {
    contextLimitRatio: 0.05,
    minTokens: 500,
    maxTokens: 4000,
  },
  retrieval: {
    defaultStrategies: ["semantic", "bm25", "graph"],
    rerankEnabled: true,
    maxResults: 10,
    weights: { semantic: 0.5, recency: 0.3, importance: 0.2 },
  },
};
// Internal Plugin State
class OpenCodePGMemoryPlugin {
  pool: Pool | null = null;
  config: PluginConfig;
  cacheManager: SemanticCacheManager | null = null;
  initialized: boolean = false;
  private cleanupIntervals: ReturnType<typeof setInterval>[] = [];

  constructor(config: Partial<PluginConfig> = {}) {
    this.config = this.mergeConfig(config);
  }

  private mergeConfig(u: Partial<PluginConfig>): PluginConfig {
    return {
      ...DEFAULT_PLUGIN_CONFIG,
      ...u,
      database: { ...DEFAULT_PLUGIN_CONFIG.database, ...u.database },
      embedding: { ...DEFAULT_PLUGIN_CONFIG.embedding, ...u.embedding },
      cache: { ...DEFAULT_PLUGIN_CONFIG.cache, ...u.cache },
      reflection: { ...DEFAULT_PLUGIN_CONFIG.reflection, ...u.reflection },
      tokenBudget: { ...DEFAULT_PLUGIN_CONFIG.tokenBudget, ...u.tokenBudget },
      retrieval: { ...DEFAULT_PLUGIN_CONFIG.retrieval, ...u.retrieval },
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    logger.info("Initializing plugin...");
    try {
      this.pool = await initializeDatabase(this.config.database);
      if (this.config.cache.enabled) {
        this.cacheManager = createCacheManager(this.pool, this.config.cache);
      }
      this.startCleanupTasks();
      this.initialized = true;
      logger.info("Plugin initialized successfully");
    } catch (error) {
      logger.error("Plugin initialization failed:", error);
      throw error;
    }
  }
  async close(): Promise<void> {
    if (!this.initialized) return;
    logger.info("Closing plugin...");
    for (const interval of this.cleanupIntervals) {
      clearInterval(interval);
    }
    this.cleanupIntervals = [];
    await closeDatabase();
    this.pool = null;
    this.cacheManager = null;
    this.initialized = false;
    logger.info("Plugin closed");
  }
  private startCleanupTasks(): void {
    this.cleanupIntervals.push(
      setInterval(() => cleanupExpiredAccumulators(300000), 300000),
    );
    this.cleanupIntervals.push(
      setInterval(
        async () => {
          if (this.cacheManager) {
            await this.cacheManager.cleanupExpiredCache(30);
          }
        },
        24 * 60 * 60 * 1000,
      ),
    );
  }
  getPool(): Pool {
    if (!this.pool) {
      throw new Error("Plugin not initialized. Call initialize() first.");
    }
    return this.pool;
  }
  getCacheManager(): SemanticCacheManager | null {
    return this.cacheManager;
  }
}

// Plugin Export
export const OpenCodePGMemory: Plugin = async (ctx: PluginInput) => {
  const config = buildConfigFromEnv();
  const plugin = new OpenCodePGMemoryPlugin(config);
  await plugin.initialize();
  const pool = plugin.getPool();
  // Init async embedder, cleanup handlers, memory buffer
  initializeServices(pool, () => plugin.close());
  const state: PluginState = { pool, config: plugin.config };
  const hookCtx: HookBuilderContext = {
    client: ctx.client,
    project: ctx.project,
  };
  const hooks = buildHooks(state, hookCtx);
  const tools = buildTools(state);
  return { ...hooks, tool: tools };
};

// Helpers
function buildConfigFromEnv(): Partial<PluginConfig> {
  return {
    database: {
      host: process.env.PG_HOST || "localhost",
      port: parseInt(process.env.PG_PORT || "5432", 10),
      database: process.env.PG_DATABASE || "opencode_memory",
      user: process.env.PG_USER || "opencode",
      password: process.env.PG_PASSWORD || "",
      ssl: process.env.PG_SSL === "true",
    },
    embedding: {
      model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
      dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || "1536", 10),
      batchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE || "100", 10),
    },
    cache: {
      enabled: process.env.CACHE_ENABLED !== "false",
      initialThreshold: parseFloat(
        process.env.CACHE_INITIAL_THRESHOLD || "0.92",
      ),
      adjustmentStep: parseFloat(process.env.CACHE_ADJUSTMENT_STEP || "0.02"),
      minThreshold: parseFloat(process.env.CACHE_MIN_THRESHOLD || "0.85"),
      maxThreshold: parseFloat(process.env.CACHE_MAX_THRESHOLD || "0.97"),
    },
    reflection: {
      enabled: process.env.REFLECTION_ENABLED !== "false",
      observationThreshold: parseInt(
        process.env.REFLECTION_OBSERVATION_THRESHOLD || "30",
        10,
      ),
      segmentThreshold: parseInt(
        process.env.REFLECTION_SEGMENT_THRESHOLD || "5",
        10,
      ),
      modelSize:
        (process.env.REFLECTION_MODEL_SIZE as "7b" | "14b" | "full") || "7b",
      offPeakHours: (process.env.REFLECTION_OFF_PEAK_HOURS || "1,2,3,4,5")
        .split(",")
        .map((n) => parseInt(n.trim(), 10))
        .filter((n) => !isNaN(n)),
    },
    tokenBudget: {
      contextLimitRatio: parseFloat(
        process.env.TOKEN_CONTEXT_LIMIT_RATIO || "0.05",
      ),
      minTokens: parseInt(process.env.TOKEN_MIN_TOKENS || "500", 10),
      maxTokens: parseInt(process.env.TOKEN_MAX_TOKENS || "4000", 10),
    },
    retrieval: {
      defaultStrategies: (
        process.env.RETRIEVAL_STRATEGIES || "semantic,bm25,graph"
      )
        .split(",")
        .map((s) => s.trim()),
      rerankEnabled: process.env.RETRIEVAL_RERANK !== "false",
      maxResults: parseInt(process.env.RETRIEVAL_MAX_RESULTS || "10", 10),
      weights: {
        semantic: parseFloat(process.env.RETRIEVAL_WEIGHT_SEMANTIC || "0.5"),
        recency: parseFloat(process.env.RETRIEVAL_WEIGHT_RECENCY || "0.3"),
        importance: parseFloat(
          process.env.RETRIEVAL_WEIGHT_IMPORTANCE || "0.2",
        ),
      },
    },
  };
}

// Re-exports
export * from "./types";
export * from "./db/init-db";
export * from "./utils/token-budget";
export * from "./cache/semantic-cache";
export { recallMemory } from "./mcp/recall-memory";
export { hindsightReflect } from "./mcp/hindsight-reflect";
export default OpenCodePGMemory;
