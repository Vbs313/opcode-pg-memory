import { Pool, PoolClient } from "pg";
import pgvector from "pgvector";
import { createLogger } from "../services/logger";
import { getConfig } from "../config";

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean | object;
  maxConnections?: number;
}

export const DEFAULT_DB_CONFIG: DatabaseConfig = {
  host: "localhost",
  port: 5432,
  database: "PGOMO",
  user: "opencode",
  password: "",
  ssl: false,
  maxConnections: 20,
};

export class DatabaseInitializer {
  private pool: Pool | null = null;
  private config: DatabaseConfig;
  private logger = createLogger("init-db");

  constructor(config: Partial<DatabaseConfig> = {}) {
    this.config = { ...DEFAULT_DB_CONFIG, ...config };
  }

  async initialize(): Promise<Pool> {
    if (this.pool) {
      return this.pool;
    }

    this.pool = new Pool({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      ssl: this.config.ssl,
      max: this.config.maxConnections,
    });

    // 注册 pgvector 类型
    // @ts-ignore - pgvector types may vary
    pgvector.registerTypes?.(this.pool);

    // 测试连接
    await this.testConnection();

    // 初始化数据库结构
    await this.setupDatabase();

    return this.pool;
  }

  private async testConnection(): Promise<void> {
    try {
      const client = await this.pool!.connect();
      const result = await client.query("SELECT NOW() as now");
      client.release();
      this.logger.info("Database connected:", result.rows[0].now);
    } catch (error) {
      this.logger.error("Database connection failed:", error);
      throw new Error(`Failed to connect to PostgreSQL: ${error}`);
    }
  }

  private async setupDatabase(): Promise<void> {
    const client = await this.pool!.connect();
    try {
      await client.query("BEGIN");

      // 1. 启用 pgvector 扩展
      await this.createExtensions(client);

      // 2. 创建枚举类型
      await this.createEnums(client);

      // 3. 创建表
      await this.createTables(client);

      // 4. 迁移旧列名（session_id → session_map_id）
      await this.migrateLegacyColumnNames(client);

      // 5. 迁移 observations 表新增列
      await this.migrateObservationsSource(client);

      // 6. 创建索引（必须在列迁移之后）
      await this.createIndexes(client);

      // 7. 迁移旧 sessions 数据到 session_map
      await this.migrateSessionsData(client);

      // 8. 初始化 OmO 适配 Schema（如果启用）
      await this.initializeOmOSchema(client);

      await client.query("COMMIT");
      this.logger.info("Database schema initialized successfully");
    } catch (error) {
      await client.query("ROLLBACK");
      this.logger.error("Database setup failed:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  private async createExtensions(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    `);
    this.logger.info("Extensions created");
  }

  private async createEnums(client: PoolClient): Promise<void> {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'entity_tier') THEN
          CREATE TYPE entity_tier AS ENUM ('permanent', 'project', 'session');
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'relation_type') THEN
          CREATE TYPE relation_type AS ENUM ('belongs_to', 'depends_on', 'references', 'implements', 'uses', 'custom');
        END IF;
      END $$;
    `);
    this.logger.info("Enums created");
  }

  private async createTables(client: PoolClient): Promise<void> {
    // ── session_map 表（替代旧 sessions 表，旧表保留为历史数据） ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS session_map (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        opencode_session_id VARCHAR(255) UNIQUE NOT NULL,
        omo_task_id VARCHAR(255),
        project_id VARCHAR(255),
        model_context_limit INTEGER NOT NULL DEFAULT 128000,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_active_at TIMESTAMPTZ DEFAULT NOW(),
        metadata JSONB DEFAULT '{}'
      );
    `);

    // ── topic_segments 表（NEW：会话内话题分段） ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS topic_segments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_map_id UUID NOT NULL REFERENCES session_map(id) ON DELETE CASCADE,
        segment_index INTEGER NOT NULL,
        summary TEXT,
        embedding vector(1536),
        start_message_external_id VARCHAR(255),
        end_message_external_id VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        closed_at TIMESTAMPTZ,
        observation_count INTEGER DEFAULT 0,
        metadata JSONB DEFAULT '{}',
        UNIQUE(session_map_id, segment_index)
      );
    `);

    // ── entities 表 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS entities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_map_id UUID REFERENCES session_map(id) ON DELETE CASCADE,
        topic_segment_id UUID REFERENCES topic_segments(id) ON DELETE SET NULL,
        name VARCHAR(500) NOT NULL,
        type VARCHAR(100) NOT NULL,
        tier entity_tier DEFAULT 'session',
        weight FLOAT DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 10),
        description TEXT,
        embedding vector(1536),
        first_seen_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ DEFAULT NOW(),
        confidence FLOAT DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
        metadata JSONB DEFAULT '{}'
      );
    `);

    // ── relations 表 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS relations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
        target_entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
        relation_type relation_type NOT NULL,
        confidence FLOAT DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        session_map_id UUID REFERENCES session_map(id) ON DELETE CASCADE,
        topic_segment_id UUID REFERENCES topic_segments(id) ON DELETE SET NULL,
        CONSTRAINT chk_different_entities CHECK (source_entity_id != target_entity_id)
      );
    `);

    // ── session_summaries 表（跨平台会话摘要：参考 claude-mem session_summaries） ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        opencode_session_id VARCHAR(255) NOT NULL,
        project_id VARCHAR(255),
        platform_source VARCHAR(50) NOT NULL DEFAULT 'opencode',
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        summary_embedding vector(1536),
        token_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_summaries_session
        ON session_summaries(opencode_session_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_summaries_project
        ON session_summaries(project_id);
    `);

    // ── observations 表 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS observations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_map_id UUID REFERENCES session_map(id) ON DELETE CASCADE,
        topic_segment_id UUID REFERENCES topic_segments(id) ON DELETE SET NULL,
        tool_name VARCHAR(255),
        tool_input_summary TEXT,
        tool_output_summary TEXT,
        embedding vector(1536),
        importance INTEGER DEFAULT 3 CHECK (importance >= 1 AND importance <= 5),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        message_id VARCHAR(255),
        metadata JSONB DEFAULT '{}',
        source VARCHAR(512),
        source_hash VARCHAR(64),
        platform_source VARCHAR(50) DEFAULT 'opencode',
        agent_id VARCHAR(100),
        causal_chain_id UUID,
        causal_role VARCHAR(10) CHECK (causal_role IN ('cause', 'fix'))
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_observations_platform_source
        ON observations(platform_source);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_observations_causal_chain
        ON observations(causal_chain_id);
    `);
    // platform_source 索引在 createIndexes 中创建（必须在列迁移之后）

    // ── reflections 表 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS reflections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_map_id UUID REFERENCES session_map(id) ON DELETE CASCADE,
        topic_segment_id UUID REFERENCES topic_segments(id) ON DELETE SET NULL,
        summary TEXT NOT NULL,
        source_observation_ids UUID[],
        confidence FLOAT DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
        pattern_type VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        embedding vector(1536),
        metadata JSONB DEFAULT '{}'
      );
    `);

    // ── reflection_errors 表 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS reflection_errors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_map_id UUID REFERENCES session_map(id) ON DELETE CASCADE,
        error_message TEXT NOT NULL,
        error_stack TEXT,
        observation_count INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        retry_count INTEGER DEFAULT 0
      );
    `);

    // ── semantic_cache 表 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS semantic_cache (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        query_hash VARCHAR(64) UNIQUE NOT NULL,
        query_text TEXT NOT NULL,
        query_embedding vector(1536) NOT NULL,
        response_text TEXT NOT NULL,
        hit_count INTEGER DEFAULT 1,
        last_hit_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        similarity_threshold FLOAT DEFAULT 0.92,
        is_pruned BOOLEAN DEFAULT FALSE,
        session_map_id UUID REFERENCES session_map(id) ON DELETE SET NULL,
        topic_segment_id UUID REFERENCES topic_segments(id) ON DELETE SET NULL
      );
    `);

    // ── token_usage_log 表 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS token_usage_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_map_id UUID REFERENCES session_map(id) ON DELETE CASCADE,
        operation_type VARCHAR(100) NOT NULL,
        tokens_used INTEGER NOT NULL,
        model_name VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        metadata JSONB DEFAULT '{}'
      );
    `);

    // ── cache_threshold_log 表 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS cache_threshold_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        threshold_value FLOAT NOT NULL,
        hit_rate FLOAT,
        query_count INTEGER,
        adjustment_reason VARCHAR(50),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── token_economics 表（会话级别 Token 经济统计） ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS token_economics (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_map_id UUID REFERENCES session_map(id) ON DELETE CASCADE,
        total_observations INTEGER DEFAULT 0,
        avg_importance FLOAT DEFAULT 0,
        estimated_read_tokens INTEGER DEFAULT 0,
        estimated_discovery_tokens INTEGER DEFAULT 0,
        savings_estimate INTEGER DEFAULT 0,
        calculated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(session_map_id)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_token_economics_calculated
        ON token_economics(calculated_at DESC);
    `);

    this.logger.info("Tables created");
  }

  private async createIndexes(client: PoolClient): Promise<void> {
    // ── session_map 表索引 ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_map_opencode_id ON session_map(opencode_session_id);
      CREATE INDEX IF NOT EXISTS idx_session_map_omo_task_id ON session_map(omo_task_id);
      CREATE INDEX IF NOT EXISTS idx_session_map_project_id ON session_map(project_id);
    `);

    // ── topic_segments 表索引 ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_topic_segments_session ON topic_segments(session_map_id);
    `);

    // HNSW 索引 for topic_segments
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_topic_segments_embedding ON topic_segments 
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
    `);

    // ── entities 表索引 ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_entities_session_map_type ON entities(session_map_id, type);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_entities_tier_weight ON entities(tier, weight DESC) WHERE weight >= 0.3;
      CREATE INDEX IF NOT EXISTS idx_entities_topic_segment ON entities(topic_segment_id);
    `);

    // HNSW 索引 for entities
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_entities_embedding ON entities 
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
    `);

    // ── relations 表索引 ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity_id);
      CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity_id);
      CREATE INDEX IF NOT EXISTS idx_relations_session_map ON relations(session_map_id);
      CREATE INDEX IF NOT EXISTS idx_relations_confidence ON relations(confidence) WHERE confidence >= 0.5;
      CREATE INDEX IF NOT EXISTS idx_relations_topic_segment ON relations(topic_segment_id);
    `);

    // ── observations 表索引 ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_observations_session_map ON observations(session_map_id);
      CREATE INDEX IF NOT EXISTS idx_observations_importance ON observations(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_observations_created_at ON observations(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_observations_topic_segment ON observations(topic_segment_id);
    `);

    // 查找索引 for observations.source + platform_source
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_observations_source ON observations(source);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_observations_platform_source ON observations(platform_source);
    `);

    // HNSW 索引 for observations
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_observations_embedding ON observations 
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
    `);

    // ── reflections 表索引 ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reflections_session_map ON reflections(session_map_id);
      CREATE INDEX IF NOT EXISTS idx_reflections_pattern ON reflections(pattern_type);
      CREATE INDEX IF NOT EXISTS idx_reflections_confidence ON reflections(confidence) WHERE confidence >= 0.6;
      CREATE INDEX IF NOT EXISTS idx_reflections_topic_segment ON reflections(topic_segment_id);
    `);

    // HNSW 索引 for reflections
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reflections_embedding ON reflections 
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
    `);

    // ── reflection_errors 表索引 ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reflection_errors_session_map ON reflection_errors(session_map_id);
      CREATE INDEX IF NOT EXISTS idx_reflection_errors_created_at ON reflection_errors(created_at DESC);
    `);

    // ── semantic_cache 表索引 ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_semantic_cache_hash ON semantic_cache(query_hash);
      CREATE INDEX IF NOT EXISTS idx_semantic_cache_hit_count ON semantic_cache(hit_count DESC);
      CREATE INDEX IF NOT EXISTS idx_semantic_cache_last_hit ON semantic_cache(last_hit_at DESC);
      CREATE INDEX IF NOT EXISTS idx_semantic_cache_pruned ON semantic_cache(is_pruned) WHERE is_pruned = FALSE;
      CREATE INDEX IF NOT EXISTS idx_semantic_cache_session_map ON semantic_cache(session_map_id);
      CREATE INDEX IF NOT EXISTS idx_semantic_cache_topic_segment ON semantic_cache(topic_segment_id);
    `);

    // HNSW 索引 for semantic_cache
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_semantic_cache_embedding ON semantic_cache 
      USING hnsw (query_embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
    `);

    // ── token_usage_log 表索引 ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_token_usage_session_map ON token_usage_log(session_map_id);
      CREATE INDEX IF NOT EXISTS idx_token_usage_operation ON token_usage_log(operation_type);
      CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage_log(created_at DESC);
    `);

    // ── cache_threshold_log 表索引 ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cache_threshold_created_at ON cache_threshold_log(created_at DESC);
    `);

    // ── 移除旧 sessions 表索引（如果存在） ──
    // 旧 sessions 表保留为历史数据；新系统使用 session_map
    await client.query(`
      DROP INDEX IF EXISTS idx_sessions_external_id;
      DROP INDEX IF EXISTS idx_sessions_project_id;
      DROP INDEX IF EXISTS idx_sessions_reflection_last_at;
    `);

    // 移除旧子表 session_id 索引（如果存在）
    await client.query(`
      DROP INDEX IF EXISTS idx_entities_session_type;
      DROP INDEX IF EXISTS idx_relations_session;
      DROP INDEX IF EXISTS idx_observations_session;
      DROP INDEX IF EXISTS idx_reflections_session;
      DROP INDEX IF EXISTS idx_reflection_errors_session;
      DROP INDEX IF EXISTS idx_token_usage_session;
    `);

    this.logger.info("Indexes created");
  }

  /**
   * 迁移旧列名 session_id → session_map_id
   *
   * 兼容从 v1.x 升级的场景：旧 schema 中 entities/observations 等子表
   * 使用 session_id 列名，但新 schema 使用 session_map_id。
   * 重命名是 PostgreSQL 元数据操作，不重写数据行，FK 关联自动继承新列名。
   */
  private async migrateLegacyColumnNames(client: PoolClient): Promise<void> {
    const tables = [
      "entities",
      "observations",
      "relations",
      "reflections",
      "semantic_cache",
      "token_usage_log",
      "reflection_errors",
    ];

    for (const table of tables) {
      try {
        // 检查表是否存在且包含旧列名 session_id 但不含 session_map_id
        const hasOld = await client.query(
          `
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'session_id'
        `,
          [table],
        );
        const hasNew = await client.query(
          `
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'session_map_id'
        `,
          [table],
        );

        if (hasOld.rows.length > 0 && hasNew.rows.length === 0) {
          await client.query(`
            ALTER TABLE "${table}" RENAME COLUMN session_id TO session_map_id
          `);
          this.logger.info(`Renamed ${table}.session_id → session_map_id`);
        }
      } catch (err) {
        // 某些表可能没有旧列名（新安装），静默跳过
        this.logger.info(`Skipped column rename for ${table}: ${err}`);
      }
    }
    this.logger.info("Legacy column migration complete");
  }

  /**
   * 将旧 sessions 表的数据迁移到新的 session_map 表。
   * 旧 sessions 表保留不删除（_legacy），仅复制元数据映射。
   * 注意：子表（entities/observations 等）的 session_map_id 不会自动填充，
   * 需要单独的迁移脚本处理 FK 重映射。
   */
  private async migrateSessionsData(client: PoolClient): Promise<void> {
    try {
      const exists = await client.query(`
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'sessions'
      `);

      if (exists.rows.length === 0) {
        this.logger.info("No legacy sessions table found, skipping migration");
        return;
      }

      // 注释旧表为 legacy 标记
      await client.query(`
        COMMENT ON TABLE sessions IS '_legacy: replaced by session_map. Retained for data safety.';
      `);

      await client.query(`
        INSERT INTO session_map (opencode_session_id, project_id, model_context_limit, created_at, last_active_at, metadata)
        SELECT external_id, project_id, model_context_limit, created_at, updated_at, metadata
        FROM sessions
        ON CONFLICT (opencode_session_id) DO NOTHING;
      `);

      this.logger.info("Legacy sessions data migrated to session_map");
    } catch (error) {
      this.logger.warn("Sessions migration warning (non-fatal):", error);
    }
  }

  /**
   * 迁移 observations 表新增列 source (VARCHAR 512) 和 source_hash (VARCHAR 64)。
   * 用于支持 import_document MCP 工具的增量更新 + 向量去重。
   * 兼容从 v2.3.x 升级的场景，ADD COLUMN IF NOT EXISTS 确保幂等。
   */
  private async migrateObservationsSource(client: PoolClient): Promise<void> {
    try {
      const tableExists = await client.query(`
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'observations'
      `);
      if (tableExists.rows.length === 0) {
        this.logger.info(
          "observations table not found, skipping source migration",
        );
        return;
      }

      await client.query(`
        ALTER TABLE observations
        ADD COLUMN IF NOT EXISTS source VARCHAR(512),
        ADD COLUMN IF NOT EXISTS source_hash VARCHAR(64),
        ADD COLUMN IF NOT EXISTS platform_source VARCHAR(50) DEFAULT 'opencode',
        ADD COLUMN IF NOT EXISTS agent_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS causal_chain_id UUID,
        ADD COLUMN IF NOT EXISTS causal_role VARCHAR(10)
      `);

      // 索引在 createIndexes 中已创建，无需重复
      this.logger.info(
        "observations columns migrated (source, platform_source, agent_id)",
      );
    } catch (error) {
      this.logger.warn(
        "Observations source migration warning (non-fatal):",
        error,
      );
    }
  }

  private async initializeOmOSchema(client: PoolClient): Promise<void> {
    // 检查是否需要 OmO 支持
    const omOEnabled = getConfig().omoEnabled;

    if (!omOEnabled) {
      this.logger.info("OmO integration not enabled, skipping OmO schema");
      return;
    }

    this.logger.info("Initializing OmO schema...");

    // 1. 添加 source_agent 字段到相关表
    const tablesWithAgent = [
      "observations",
      "semantic_cache",
      "entities",
      "reflections",
    ];

    for (const table of tablesWithAgent) {
      try {
        await client.query(`
          ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS source_agent VARCHAR(255),
          ADD COLUMN IF NOT EXISTS agent_task_id VARCHAR(255)
        `);

        // 创建索引
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_${table}_source_agent ON ${table}(source_agent)
        `);

        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_${table}_agent_task ON ${table}(agent_task_id)
        `);
      } catch (error) {
        this.logger.warn(`Schema update warning for ${table}:`, error);
      }
    }

    // 2. 创建 OmO 协调表（使用 session_map_id 引用）
    await client.query(`
      CREATE TABLE IF NOT EXISTS omo_coordination (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_map_id UUID REFERENCES session_map(id) ON DELETE CASCADE,
        agent_id VARCHAR(255),
        coordination_type VARCHAR(100) NOT NULL,
        coordination_data JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_omo_coordination_session_map ON omo_coordination(session_map_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_omo_coordination_agent ON omo_coordination(agent_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_omo_coordination_type ON omo_coordination(coordination_type)
    `);

    // 3. 创建 OmO Wisdom 表（用于与 OmO Wisdom Accumulation 同步）
    await client.query(`
      CREATE TABLE IF NOT EXISTS omo_wisdom (
        id VARCHAR(255) PRIMARY KEY,
        type VARCHAR(100) NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        agent_id VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_omo_wisdom_agent ON omo_wisdom(agent_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_omo_wisdom_type ON omo_wisdom(type)
    `);

    this.logger.info("OmO schema initialized");
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.logger.info("Database connection closed");
    }
  }

  getPool(): Pool {
    if (!this.pool) {
      throw new Error("Database not initialized. Call initialize() first.");
    }
    return this.pool;
  }
}

// 单例导出
let initializer: DatabaseInitializer | null = null;

export function getDatabaseInitializer(
  config?: Partial<DatabaseConfig>,
): DatabaseInitializer {
  if (!initializer) {
    initializer = new DatabaseInitializer(config);
  }
  return initializer;
}

export async function initializeDatabase(
  config?: Partial<DatabaseConfig>,
): Promise<Pool> {
  const init = getDatabaseInitializer(config);
  return init.initialize();
}

export async function closeDatabase(): Promise<void> {
  if (initializer) {
    await initializer.close();
    initializer = null;
  }
}
