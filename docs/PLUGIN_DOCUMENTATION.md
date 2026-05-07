# opcode-pg-memory 插件完全指南

> OpenCode PostgreSQL + pgvector 记忆插件 - 四层记忆架构实现

## 目录

1. [架构概览](#1-架构概览)
2. [核心概念](#2-核心概念)
3. [数据库设计](#3-数据库设计)
4. [钩子系统](#4-钩子系统)
5. [MCP 工具](#5-mcp-工具)
6. [工作流程](#6-工作流程)
7. [配置详解](#7-配置详解)
8. [对比内置功能](#8-对比内置功能)
9. [最佳实践](#9-最佳实践)

---

## 1. 架构概览

### 1.1 插件定位

```
┌─────────────────────────────────────────────────────────────┐
│                      OpenCode 核心                          │
├─────────────────────────────────────────────────────────────┤
│                    opcode-pg-memory 插件                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │
│  │  钩子系统    │  │  MCP 工具   │  │  缓存管理器      │   │
│  │(8个钩子)    │  │(2个工具)    │  │  (语义缓存)     │   │
│  └─────────────┘  └─────────────┘  └─────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│                   PostgreSQL + pgvector                     │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐  │
│  │Sessions│ │Entities│ │Relations│ │Observations││Reflections│ │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘  │
│  ┌─────────────┐  ┌─────────────┐                         │
│  │semantic_cache│  │token_usage_log│                        │
│  └─────────────┘  └─────────────┘                         │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 四层记忆架构

| 层级 | 存储内容 | 生命周期 | 检索优先级 |
|------|----------|----------|------------|
| **Retain** (存储) | 原始消息、工具输出、实体 | Session 周期 | - |
| **Recall** (检索) | 向量化数据、语义搜索 | 按需 | - |
| **Reflect** (反思) | 经验模式、洞察 |  Session 完成时 | - |
| **Cache** (缓存) | 常见问题响应 | 动态阈值 | 最高 |

### 1.3 与 OpenCode 内置关系

```
OpenCode 内置 SQLite                         opcode-pg-memory
┌──────────────────────┐                   ┌──────────────────────┐
│ session 持久化       │                   │ 向量化记忆增强        │
│ Session 分支/Undo    │                   │ 跨 Session 语义检索   │
│ 上下文压缩           │                   │ 四层记忆架构          │
│ Session 分享/导出    │                   │ MCP 工具调用          │
└──────────────────────┘                   └──────────────────────┘
         │                                          │
         └───────────── 数据同步? ─────────────────┘
                        (未实现，需要手动/事件驱动)
```

---

## 2. 核心概念

### 2.1 Entity (实体)

从对话中提取的命名实体：

```typescript
interface Entity {
  id: string;                    // UUID
  session_id: string;            // 关联的 session
  name: string;                 // 实体名称
  type: string;                 // 类型: file, function, variable, concept 等
  tier: 'permanent' | 'project' | 'session';  // 层级
  weight: number;               // 权重 (0-10)
  description?: string;         // 描述
  embedding?: number[];         // 向量嵌入 (1536维)
  confidence: number;           // 置信度 (0-1)
  first_seen_at: Date;          // 首次出现
  last_seen_at: Date;           // 最后出现
}
```

**tier 层级说明**:
- `permanent`: 永久记忆，跨项目通用 (如编程范式、技术概念)
- `project`: 项目记忆，当前项目内共享 (如项目结构、架构决策)
- `session`: 会话记忆，仅当前会话有效 (如具体实现细节)

### 2.2 Relation (关系)

实体之间的关系：

```typescript
interface Relation {
  id: string;
  source_entity_id: string;     // 源实体
  target_entity_id: string;    // 目标实体
  relation_type: 'belongs_to' | 'depends_on' | 'references' | 'implements' | 'uses' | 'custom';
  confidence: number;           // 置信度
  description?: string;
  session_id: string;
}
```

### 2.3 Observation (观察)

工具执行结果的记录：

```typescript
interface Observation {
  id: string;
  session_id: string;
  tool_name?: string;           // 工具名称
  tool_input_summary?: string;  // 输入摘要
  tool_output_summary?: string; // 输出摘要
  embedding?: number[];         // 向量嵌入
  importance: number;           // 重要性 (1-5)
  message_id?: string;         // 关联的消息 ID
}
```

### 2.4 Reflection (反思)

从观察中归纳的经验模式：

```typescript
interface Reflection {
  id: string;
  session_id: string;
  summary: string;              // 反思摘要
  source_observation_ids: string[];  // 源观察 IDs
  confidence: number;           // 置信度 (0-1)
  pattern_type?: string;        // 模式类型
  embedding?: number[];         // 向量嵌入
}
```

### 2.5 Semantic Cache (语义缓存)

相似查询的响应缓存：

```typescript
interface SemanticCache {
  id: string;
  query_hash: string;          // 查询哈希
  query_text: string;          // 查询文本
  query_embedding: number[];   // 查询向量
  response_text: string;       // 响应文本
  hit_count: number;           // 命中次数
  similarity_threshold: number; // 相似度阈值
  is_pruned: boolean;          // 是否被压缩标记
  session_id?: string;         // 可选的会话关联
}
```

---

## 3. 数据库设计

### 3.1 表结构总览

```
┌─────────────────┐     ┌─────────────────┐
│    sessions     │     │   messages      │
├─────────────────┤     ├─────────────────┤
│ id (PK)         │     │ id (PK)         │
│ external_id     │◄────│ session_id (FK) │
│ project_id      │     │ role            │
│ model_context.. │     │ content         │
│ metadata (JSON) │     │ tokens          │
└────────┬────────┘     └─────────────────┘
         │
    ┌────┴────┬────────────┬────────────┐
    ▼         ▼            ▼            ▼
┌─────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐
│entities │ │relations │ │observa.. │ │reflections│
├─────────┤ ├──────────┤ ├──────────┤ ├───────────┤
│ id      │ │ id       │ │ id       │ │ id        │
│ session_│◄┤source_id │◄┤session_id│◄┤session_id│
│ name    │ │target_id │ │tool_name │ │summary    │
│ type    │ │rel_type  │ │importance│ │confidence │
│ tier    │ │confidence│ │embedding │ │pattern...│
│ weight  │ └──────────┘ └──────────┘ └───────────┘
│ embed.. │
└─────────┘
         │
    ┌────┴──────────────────────────┐
    ▼                                ▼
┌─────────────────────┐  ┌────────────────────┐
│   semantic_cache    │  │  token_usage_log   │
├─────────────────────┤  ├────────────────────┤
│ id                  │  │ id                 │
│ query_hash          │  │ session_id (FK)   │
│ query_text          │  │ operation_type     │
│ query_embedding     │  │ tokens_used        │
│ response_text       │  │ metadata (JSON)    │
│ hit_count           │  └────────────────────┘
│ similarity_threshold│
│ is_pruned           │
└─────────────────────┘
```

### 3.2 核心表详解

#### sessions 表

```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id VARCHAR(255) UNIQUE NOT NULL,  -- OpenCode Session ID
  project_id VARCHAR(255),                    -- 项目 ID
  model_context_limit INTEGER NOT NULL DEFAULT 128000,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  reflection_last_at TIMESTAMPTZ,            -- 上次反思时间
  metadata JSONB DEFAULT '{}'                 -- 扩展元数据
);
```

#### entities 表 (带向量索引)

```sql
CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  name VARCHAR(500) NOT NULL,
  type VARCHAR(100) NOT NULL,
  tier entity_tier DEFAULT 'session',         -- permanent/project/session
  weight FLOAT DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 10),
  description TEXT,
  embedding vector(1536),                    -- pgvector 1536维
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  confidence FLOAT DEFAULT 0.8,
  metadata JSONB DEFAULT '{}'
);

-- HNSW 向量索引 (加速相似度搜索)
CREATE INDEX idx_entities_embedding ON entities 
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

#### observations 表 (带向量索引)

```sql
CREATE TABLE observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name VARCHAR(255),
  tool_input_summary TEXT,
  tool_output_summary TEXT,
  embedding vector(1536),
  importance INTEGER DEFAULT 3 CHECK (importance >= 1 AND importance <= 5),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  message_id VARCHAR(255),
  metadata JSONB DEFAULT '{}'
);

-- HNSW 向量索引
CREATE INDEX idx_observations_embedding ON observations 
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

### 3.3 索引策略

| 表名 | 索引类型 | 用途 |
|------|----------|------|
| entities | HNSW (embedding) | 向量语义检索 |
| entities | BTree (tier, weight) | 分层权重过滤 |
| observations | HNSW (embedding) | 向量语义检索 |
| observations | BTree (importance) | 重要性排序 |
| relations | BTree (source/target) | 关系查询 |
| semantic_cache | HNSW (query_embedding) | 缓存命中 |
| sessions | BTree (external_id) | 会话查找 |

---

## 4. 钩子系统

### 4.1 钩子列表

| 钩子名称 | 触发时机 | 主要功能 |
|----------|----------|----------|
| `session.created` | 新会话创建时 | 记忆检索注入 |
| `tool.execute.before` | 工具执行前 | 参数增强/缓存检查 |
| `tool.execute.after` | 工具执行后 | 结果存储/实体提取 |
| `message.updated` | 消息更新时 | 元数据同步 |
| `message.part.updated` | 消息部分更新 | 流式输出处理 |
| `experimental.session.compacting` | 上下文压缩前 | 标记高价值消息 |
| `session.compacted` | 上下文压缩后 | 清理缓存标记 |
| `session.completed` | 会话完成时 | 触发反思 |

### 4.2 钩子签名规范

所有钩子遵循统一签名：
```typescript
(input: InputType, output: OutputType) => Promise<void>
```

**关键点**：通过突变 `output` 参数影响行为，而非返回值。

### 4.3 钩子详解

#### session.created

```typescript
// 输入
interface SessionCreatedInput {
  session: {
    id: string;                    // OpenCode Session ID
    projectId?: string;
    model: { id: string; contextLimit: number; name: string };
    messages: OpenCodeMessage[];
  };
}

// 输出 - 注入记忆到 context
interface SessionCreatedOutput {
  context?: {
    memories?: string[];           // 注入的记忆内容
    facts?: string[];             // 事实列表
  };
}

// 工作流程:
1. upsertSession() - 创建/更新 session 记录
2. calculateTokenBudget() - 计算注入预算 (contextLimit × 5%)
3. retrieveFactsForInjection() - 检索记忆
   - 优先级: permanent (50%) > project (30%) > session (20%)
4. formatEntity() - 格式化实体为可读文本
5. output.context.memories = facts.map(f => f.content)
```

#### tool.execute.before

```typescript
// 输入
interface ToolExecuteBeforeInput {
  session: { id: string };
  tool: { name: string; parameters: Record<string, any> };
  messageId: string;
}

// 输出
interface ToolExecuteBeforeOutput {
  parameters?: Record<string, any>;  // 可修改工具参数
}

// 工作流程:
1. checkCache() - 检查语义缓存
2. 如果命中: 返回缓存结果，绕过工具执行
3. 如果未命中: 传递原始参数
```

#### tool.execute.after

```typescript
// 输入
interface ToolExecuteAfterInput {
  session: { id: string };
  tool: { name: string; parameters: Record<string, any> };
  result: { success: boolean; data?: any; error?: string };
  messageId: string;
  executionTimeMs: number;
}

// 工作流程:
1. storeMessage() - 存储工具调用消息
2. extractEntities() - 从输出中提取实体
3. generateEmbedding() - 生成向量嵌入
4. createObservation() - 创建观察记录
5. analyzeRelations() - 分析实体关系
6. if (config.cache.enabled) storeCache() - 存储语义缓存
```

#### message.part.updated

```typescript
// 输入
interface MessagePartUpdatedInput {
  session: { id: string };
  message: {
    id: string;
    partIndex: number;
    content: string;
    isComplete: boolean;
  };
}

// 工作流程:
1. 流式处理: 累积不完整的输出片段
2. 完整时: 触发实体提取和嵌入生成
3. 清理: 定期清理过期的累积器 (默认5分钟)
```

#### session.completed

```typescript
// 输入
interface SessionCompletedInput {
  session: {
    id: string;
    projectId?: string;
    messageCount: number;
    durationMs: number;
  };
  summary?: string;
}

// 工作流程:
1. updateSession() - 更新会话元数据
2. calculateImportance() - 计算观察重要性
3. if (observationCount >= threshold) triggerReflection()
4. scheduleOffPeakReflection() - 低峰期反思调度
```

#### experimental.session.compacting

```typescript
// 输入
interface SessionCompactingInput {
  session: { id: string };
  messagesToCompact: string[];    // 将被压缩的消息 IDs
  compactionStrategy: 'prune' | 'summarize' | 'archive';
}

// 输出
interface SessionCompactingOutput {
  preserveMessageIds?: string[];  // 强制保留的高价值消息
}

// 工作流程:
1. markCacheEntriesAsPruned() - 标记缓存为已压缩
2. determineMessagesToPreserve() - 找出高重要性观察
3. logTokenUsage() - 记录压缩事件
4. output.preserveMessageIds = preserveMessageIds
```

---

## 5. MCP 工具

### 5.1 recall_memory

语义检索工具 - 从长期记忆中检索相关内容。

```typescript
// 工具定义
{
  name: "recall_memory",
  description: "从长期记忆中检索相关事实、实体、观察和反思"
}

// 输入参数
interface RecallMemoryInput {
  query: string;                                    // 必填: 检索查询
  session_id?: string;                             // 可选: 限制会话
  retrieval_strategies?: string[];                // 可选: 检索策略
  max_results?: number;                            // 可选: 返回数量
  filters?: {
    min_confidence?: number;
    min_importance?: number;
    tier?: 'permanent' | 'project' | 'session';
    entity_types?: string[];
  };
}

// 检索策略
type RetrievalStrategy = 'semantic' | 'bm25' | 'graph' | 'keyword';

// 多维评分公式
Relevance = 0.5 × SemSim + 0.3 × Recency + 0.2 × Importance
```

**检索流程**:
```
1. 生成查询向量 (embedding)
2. 并行执行多策略检索:
   - semantic: 向量余弦相似度
   - bm25: 关键词权重排序
   - graph: 关系路径遍历
3. 交叉编码器重排序 (可选)
4. 应用权重合并结果
5. 过滤低置信度/重要性
6. 返回 top-k 结果
```

### 5.2 hindsight_reflect

反思工具 - 对会话观察进行模式归纳。

```typescript
// 工具定义
{
  name: "hindsight_reflect",
  description: "对会话观察进行反思，归纳经验模式"
}

// 输入参数
interface HindsightReflectInput {
  session_id: string;                               // 必填: 会话 ID
  trigger_type?: 'manual' | 'threshold' | 'scheduled' | 'auto';
  observation_threshold?: number;                  // 可选: 触发阈值
  model_size?: '7b' | '14b' | 'full';             // 可选: 模型规模
}

// 输出
interface HindsightReflectOutput {
  reflections: Array<{
    id: string;
    summary: string;
    confidence: number;
    pattern_type: string;
    source_observation_count: number;
  }>;
  token_usage: number;
  duration_ms: number;
}
```

**反思流程**:
```
1. 收集会话中的所有观察记录
2. 按重要性/时间排序
3. 分批聚合 (每批 10 条)
4. 调用 LLM 提取模式:
   - 识别重复出现的模式
   - 归纳技术洞察
   - 总结决策依据
5. 生成反思摘要和嵌入
6. 存储到 reflections 表
7. 更新 session.reflection_last_at
```

---

## 6. 工作流程

### 6.1 完整生命周期

```
┌──────────────────────────────────────────────────────────────┐
│                        OpenCode 启动                          │
└─────────────────────────────┬────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                    1. 插件初始化                              │
│  - 连接 PostgreSQL                                           │
│  - 初始化数据库 schema (表/索引/扩展)                          │
│  - 创建缓存管理器                                              │
│  - 启动定期清理任务                                            │
└─────────────────────────────┬────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│ 新会话创建    │      │ 工具执行      │      │ 会话完成     │
│ session.created│     │tool.execute │      │session.completed│
└──────────────┘      └──────────────┘      └──────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│ 检索记忆注入  │      │ 提取实体/    │      │ 触发反思     │
│              │      │ 观察记录     │      │              │
└──────────────┘      └──────────────┘      └──────────────┘
        │                     │                     │
        └─────────────────────┴─────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                      PostgreSQL 持久化                        │
│  sessions | entities | relations | observations | reflections │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 消息处理流程

```
用户消息 → OpenCode 处理
      │
      ├─→ tool.execute.before (检查缓存)
      │         │
      │         ├─命中→返回缓存→跳过工具执行
      │         └未命中→继续执行工具
      │
      ├─→ 工具执行
      │
      └─→ tool.execute.after (存储结果)
                │
                ├─→ 存储消息记录
                ├─→ 提取实体 (NER)
                ├─→ 生成嵌入
                ├─→ 创建观察
                ├─→ 分析关系
                └─→ 存入语义缓存
```

### 6.3 上下文压缩流程

```
Session 上下文即将耗尽
        │
        ▼
experimental.session.compacting 钩子触发
        │
        ├─→ 标记相关缓存为 pruned
        ├─→ 识别高重要性观察 (importance >= 4)
        ├─→ 输出 preserveMessageIds
        └─→ 记录 token 使用
                │
                ▼
session.compacted 钩子触发
        │
        └─→ 清理 pruned 标记的缓存
```

---

## 7. 配置详解

### 7.1 默认配置

```typescript
const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  // 数据库连接
  database: {
    host: 'localhost',
    port: 5432,
    database: 'PGOMO',
    user: 'opencode',
    password: '123456',
    ssl: false
  },

  // 向量嵌入配置
  embedding: {
    model: 'text-embedding-3-small',  // 或 ollama/qwen3-embedding:0.6b
    dimensions: 1536,                    // 向量维度
    batchSize: 100                       // 批量嵌入大小
  },

  // 语义缓存配置
  cache: {
    initialThreshold: 0.92,             // 初始相似度阈值
    adjustmentStep: 0.02,               // 调整步长
    minThreshold: 0.85,                 // 最小阈值
    maxThreshold: 0.97,                 // 最大阈值
    enabled: true                       // 是否启用
  },

  // 反思配置
  reflection: {
    observationThreshold: 30,           // 触发反思的观察数量
    modelSize: '7b',                    // 反思使用的模型大小
    offPeakHours: [1, 2, 3, 4, 5],      // 低峰期小时 (UTC)
    enabled: true                       // 是否启用
  },

  // Token 预算配置
  tokenBudget: {
    contextLimitRatio: 0.05,            // context 5% 作为预算
    minTokens: 500,                     // 最小注入 token
    maxTokens: 4000                     // 最大注入 token
  },

  // 检索配置
  retrieval: {
    defaultStrategies: ['semantic', 'bm25', 'graph'],
    rerankEnabled: true,                // 启用交叉编码器重排序
    maxResults: 10,                    // 最大返回结果
    weights: {
      semantic: 0.5,                   // 向量相似度权重
      recency: 0.3,                    // 时效性权重
      importance: 0.2                  // 重要性权重
    }
  }
};
```

### 7.2 环境变量

```bash
# PostgreSQL
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=PGOMO
PG_USER=opencode
PG_PASSWORD=123456
PG_SSL=false

# 嵌入配置
EMBEDDING_PROVIDER=ollama  # 或 deepseek, openai
EMBEDDING_MODEL=qwen3-embedding:0.6b
EMBEDDING_DIMENSIONS=1024
EMBEDDING_BATCH_SIZE=10

# DeepSeek (如果使用)
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

### 7.3 OpenCode 配置

```json
{
  "plugin": [
    "opcode-pg-memory"
  ],
  "mcp": {
    "pg-memory": {
      "type": "local",
      "command": ["bun", "path/to/dist/mcp-server.js"],
      "enabled": true,
      "environment": {
        "PG_HOST": "localhost",
        "PG_PORT": "5432",
        "PG_DATABASE": "PGOMO",
        "PG_USER": "opencode",
        "PG_PASSWORD": "123456",
        "EMBEDDING_PROVIDER": "ollama",
        "EMBEDDING_MODEL": "qwen3-embedding:0.6b"
      }
    }
  }
}
```

---

## 8. 对比内置功能

### 8.1 OpenCode 内置能力 vs 插件能力

| 功能 | OpenCode 内置 | 插件实现 | 备注 |
|------|---------------|----------|------|
| Session 持久化 | ✅ SQLite | ✅ PostgreSQL | 重复功能 |
| Session 分支 | ✅ | ❌ | - |
| Undo/Redo | ✅ | ❌ | - |
| 上下文压缩 | ✅ 自动+手动 | ✅ 钩子增强 | 互补 |
| Session 分享 | ✅ | ❌ | - |
| 导出/导入 | ✅ | ❌ | - |
| 向量检索 | ❌ | ✅ | 独特价值 |
| 跨 Session 记忆 | ❌ | ✅ | 独特价值 |
| MCP 工具 | ❌ | ✅ | 手动检索 |
| 四层记忆架构 | ❌ | ✅ | 独特价值 |

### 8.2 数据流问题

```
当前问题:
┌─────────────────┐      手动/事件触发      ┌─────────────────┐
│ OpenCode SQLite │ ─────────────────────► │ PostgreSQL      │
│ (内置持久化)    │                          │ (插件存储)      │
└─────────────────┘                          └─────────────────┘
        │                                           ▲
        │             未同步                          │
        └───────────────────────────────────────────┘
                        
解决方案建议:
1. 事件监听同步: 监听 OpenCode 事件流，实时同步到 PostgreSQL
2. 批量导入工具: 提供一次性导入历史会话的 CLI 工具
3. 增强层模式: 只做向量检索增强，不做基础存储
```

---

## 9. 最佳实践

### 9.1 推荐使用场景

| 场景 | 推荐配置 |
|------|----------|
| 语义搜索代码库 | embedding: deepseek, maxResults: 20 |
| 个人知识管理 | tier: permanent 权重高, reflection: auto |
| 项目技术债务分析 | 定期运行 hindsight_reflect |
| 团队知识共享 | tier: project, 关闭 session 级记忆 |

### 9.2 性能优化

```sql
-- 定期清理低价值缓存
DELETE FROM semantic_cache 
WHERE hit_count < 3 
  AND created_at < NOW() - INTERVAL '30 days';

-- 清理已压缩会话的观察记录
DELETE FROM observations 
WHERE session_id IN (
  SELECT id FROM sessions 
  WHERE updated_at < NOW() - INTERVAL '90 days'
);

-- 分析查询性能
EXPLAIN ANALYZE 
SELECT * FROM entities 
ORDER BY embedding <=> $1::vector 
LIMIT 10;
```

### 9.3 监控指标

```sql
-- 会话统计
SELECT 
  COUNT(*) as total_sessions,
  COUNT(DISTINCT project_id) as total_projects,
  MAX(updated_at) as last_activity
FROM sessions;

-- 实体分布
SELECT tier, COUNT(*), AVG(weight) 
FROM entities 
GROUP BY tier;

-- 缓存命中率
SELECT 
  COUNT(*) FILTER (WHERE hit_count > 1) as cache_hits,
  COUNT(*) as total_entries,
  ROUND(COUNT(*) FILTER (WHERE hit_count > 1)::numeric / COUNT(*), 2) as hit_rate
FROM semantic_cache;

-- Token 使用趋势
SELECT 
  DATE(created_at) as date,
  SUM(tokens_used) as daily_tokens,
  COUNT(*) as operations
FROM token_usage_log
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at)
ORDER BY date;
```

### 9.4 故障排查

```powershell
# PostgreSQL 连接问题
Get-Service -Name "postgresql*"
Test-NetConnection -ComputerName localhost -Port 5432

# pgvector 扩展问题
& "E:\PostgreSQL\18\bin\psql.exe" -U opencode -d PGOMO -c "SELECT * FROM pg_extension WHERE extname = 'vector';"

# 插件初始化日志
opencode --print-logs --log-level DEBUG
```

---

## 附录

### A. 文件结构

```
opcode-pg-memory/
├── src/
│   ├── index.ts                    # 插件入口 & 工厂函数
│   ├── types.ts                    # TypeScript 类型定义
│   ├── db/
│   │   └── init-db.ts              # 数据库初始化 (表/索引/扩展)
│   ├── hooks/
│   │   ├── session-created.ts      # 会话创建钩子
│   │   ├── session-completed.ts    # 会话完成钩子
│   │   ├── session-compacting.ts   # 上下文压缩钩子
│   │   ├── tool-execute.ts         # 工具执行钩子
│   │   ├── message-updated.ts      # 消息更新钩子
│   │   └── message-part-updated.ts # 消息部分更新钩子
│   ├── mcp/
│   │   ├── recall-memory.ts        # 语义检索 MCP 工具
│   │   ├── recall-memory-omo.ts    # OmO 兼容版本
│   │   ├── hindsight-reflect.ts   # 反思 MCP 工具
│   │   └── hindsight-reflect-omo.ts
│   ├── cache/
│   │   └── semantic-cache.ts       # 语义缓存管理器
│   ├── utils/
│   │   ├── embedding.ts            # 向量嵌入工具
│   │   └── token-budget.ts         # Token 预算计算
│   └── omo/
│       ├── adapter.ts              # OmO 适配器
│       └── types.ts                # OmO 类型
├── dist/                           # 编译输出
├── scripts/                       # 安装脚本
├── tests/                         # 测试
├── package.json
├── tsconfig.json
└── PLUGIN_DOCUMENTATION.md        # 本文档
```

### B. 依赖项

```json
{
  "dependencies": {
    "pg": "^8.11.0",
    "pgvector": "^0.2.0",
    "@ai-sdk/openai": "^1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/pg": "^8.10.0"
  }
}
```

### C. 相关文档

- [README.md](./README.md) - 快速开始
- [POSTGRESQL_WINDOWS_SETUP.md](./POSTGRESQL_WINDOWS_SETUP.md) - PostgreSQL 安装
- [OMO_INTEGRATION.md](./OMO_INTEGRATION.md) - Oh My OpenAgent 集成
- [spec.md](./spec.md) - 技术规格

---

**文档版本**: 1.0  
**最后更新**: 2026-05-06  
**插件版本**: 1.0.0