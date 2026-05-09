# opcode-pg-memory 完全参考手册

> 版本 3.5.3 | 2026-05 | PostgreSQL + pgvector 跨平台记忆系统

---

## 目录

1. [项目概览](#1-项目概览)
2. [架构总览](#2-架构总览)
3. [文件清单与职责](#3-文件清单与职责)
4. [配置体系](#4-配置体系)
5. [数据库设计](#5-数据库设计)
6. [钩子系统](#6-钩子系统)
7. [MCP 工具](#7-mcp-工具)
8. [注入引擎](#8-注入引擎)
9. [短时记忆](#9-短时记忆)
10. [韧性设计](#10-韧性设计)
11. [跨平台集成](#11-跨平台集成)
12. [开发指南](#12-开发指南)
13. [测试](#13-测试)
14. [发布流程](#14-发布流程)

---

## 1. 项目概览

### 1.1 是什么

一个 OpenCode 插件，为 LLM 提供跨会话的长期记忆能力。通过 `experimental.chat.system.transform` 钩子在每次 LLM 调用前自动注入相关历史记忆。

### 1.2 技术栈

| 层 | 技术 |
|---|------|
| 插件框架 | `@opencode-ai/plugin` SDK |
| MCP 协议 | `@modelcontextprotocol/sdk` 1.29 |
| 存储 | PostgreSQL 16+ / pgvector 0.8+ |
| 嵌入模型 | Ollama (qwen3-embedding:0.6b) / OpenAI / DeepSeek |
| 运行时 | Node.js 18+ / Bun 1.0+ |
| 构建 | TypeScript 5.3 / tsc / bun build |

### 1.3 关键指标

| 指标 | 值 |
|------|-----|
| 源文件 | 63 个 |
| 代码行 | ~12,000 |
| MCP 工具 | 19 个 |
| Agent 技能 | 3 个 (SKILL.md) |
| 测试 | 172 个, 15 suites |
| `strict: true` | 零类型错误 |
| 版本 | 3.5.3 (npm) |

---

## 2. 架构总览

### 2.1 分层架构

```
OpenCode 主进程
  │
  ├─ Plugin (同一进程)
  │   ├─ hooks/        ← 7 个生命周期钩子
  │   ├─ injection/    ← 注入引擎 + 压缩 + 评分
  │   ├─ services/     ← 短时记忆 + 内存缓冲 + 日志
  │   └─ shared/       ← 路径 + 凭证 + 配置 + 错误
  │
  ├─ MCP 子进程 (stdio/SSE)
  │   └─ mcp-server.ts ← 19 个 MCP 工具
  │
  └─ PostgreSQL :5432
      └─ 10 张表 + pgvector 索引
```

### 2.2 数据流

```
用户消息
  → message.updated
     ├─ noise 过滤 → isNoise() / calculateMessageImportance()
     ├─ INSERT INTO observations (tool_name='user_message')
     └─ addObservation() → 短时记忆 Map

LLM 调用工具
  → tool.execute.before → INSERT (pending)
  → tool.execute.after  → UPDATE (output) + addObservation() → 短时记忆
  → 若 PG 失败        → enqueueObservation() → 内存队列 (指数退避重试)

下次 LLM 调用
  → experimental.chat.system.transform
     ├─ 短时记忆有数据? → 直接注入 (零 PG 查询)
     └─ 短时记忆空? → 两路召回 (PG)
          ├─ 关键词: WHERE project=? ORDER BY importance DESC
          └─ 语义: pgvector ANN (3s 超时, 缓存在 5min TTL)
     → 缓存结果 (60s TTL)
     → 合并到 output.system[0]
```

---

## 3. 文件清单与职责

### 3.1 根目录

| 文件 | 职责 |
|------|------|
| `index.ts` | 插件导出入口，re-export `src/index.ts` |
| `mcp-server.ts` | MCP 服务器，19 个工具，stdio + SSE 双传输，`/health` 端点 |
| `package.json` | npm 包定义，依赖，构建脚本 |
| `tsconfig.json` | TypeScript 配置，`strict: true` |
| `jest.config.js` | Jest 测试配置 |
| `bun.lock` | Bun 锁文件 |
| `.env` | 本地凭证（gitignored） |
| `.env.example` | 凭证模板 |

### 3.2 src/index.ts

插件入口。职责：

- 初始化 PG 连接池
- 注册全部钩子
- 管理注入缓存（60s TTL Map）
- 写入短时记忆缓冲 (setPool)
- 启动定时 flush

**注册的钩子**：

| 钩子 | 触发时机 | 用途 |
|------|----------|------|
| `event` | 所有系统事件 | 分发到 EventSynchronizer + 写 session_summary |
| `chat.message` | 用户发消息 | 旧式注入（保留兼容）+ 关键词检测 |
| `tool.execute.before` | 工具执行前 | 记录入参 |
| `tool.execute.after` | 工具执行后 | 记录出参 |
| `experimental.chat.system.transform` | **每次 LLM 调用前** | **核心注入点** |
| `experimental.session.compacting` | 会话压缩 | 保留高价值 observation |

### 3.3 src/hooks/

```
hooks/
├── tool-execute.ts        tool.execute.before + after
│   ├── handleToolExecuteBefore()    — 记录入参到 PG
│   ├── handleToolExecuteAfter()     — 记录出参 + 短时记忆 + embedding 入队
│   ├── PG 失败 → enqueueObservation() → 内存队列
│   └── calculateImportance()        — 失败+1, 长耗时+1 → max 5
│
├── session-created.ts     session 创建
│   └── handleSessionCreated()       — 创建 session_map + 注入实体
│
├── session-completed.ts   session 完成
│   └── handleSessionCompleted()     — 触发反思
│
├── session-compacting.ts  会话压缩
│   └── handleSessionCompacting()    — 标记高价值 observation
│
├── message-updated.ts     消息更新
│   ├── 用户消息 → isNoise() 过滤
│   ├── calculateMessageImportance() → 1~5 分
│   ├── INSERT INTO observations (tool_name='user_message')
│   └── addObservation() → 短时记忆
│
└── message-part-updated.ts 消息片段更新
    └── cleanupExpiredAccumulators()
```

### 3.4 src/injection/

```
injection/
├── system-transform-injector.ts     核心注入引擎 (700 行)
│   ├── retrieveMemoriesForInjection()
│   │   ├─ 短时记忆有数据? → 直接返回 (无 PG)
│   │   ├─ 短时记忆空? → 两路召回
│   │   │   ├─ keywordRecall()      — project + importance
│   │   │   └─ semanticRecall()      — pgvector ANN
│   │   ├─ 混合评分: sim×0.5 + imp×0.3 + rec×0.2
│   │   ├─ content_hash 去重
│   │   ├─ TokenBudget 裁剪 (500~3000)
│   │   └─ 经济学 + 会话摘要
│   │
│   ├── formatInjectionBlock()       格式化注入块
│   │   ├─ ## Memory System 元认知
│   │   ├─ ### Session Summary
│   │   └─ ### Relevant Memories + 压缩
│   │
│   ├── compressObservation()        记忆压缩 (output-first 提炼)
│   ├── computeRecencyBoost()        recency = 2^(-age/halfLife)
│   ├── hybridScore()                混合评分公式
│   ├── hasUserContent()             冷启动检测
│   ├── generateQueryEmbedding()     embedding (3s 超时, 5min 缓存)
│   └── buildInjectionBlock()        对外接口
│
├── session-summary-writer.ts        会话摘要
│   ├── writeSessionSummary()        UPSERT session_summaries
│   └── buildAndWriteSessionSummary()自动写入
│
├── observation-scorer.ts            评分 + 经济学 + eval
│   ├── scoreSessionObservations()   质量分 = imp×0.4 + rec×0.3 + com×0.3
│   ├── calculateTokenEconomics()    Token 经济统计
│   ├── formatEconomicsDashboard()   仪表盘格式化
│   └── evalRecall()                 自评测 recall@1/5/10
│
└── observation-cleanup.ts           自动清理
    ├── cleanupLowValueObservations() importance≤2 + 7天
    └── getObservationStats()        统计
```

### 3.5 src/mcp/

```
mcp/                         19 个 MCP 工具
├── recall-memory.ts         多策略检索 (BM25 + 向量 + 图 + 关键词)
├── hindsight-reflect.ts     跨会话反思 (LLM 提炼模式)
├── import-document.ts       文档导入 (事务性 DELETE+INSERT + 语义分块)
├── backfill-embeddings.ts   向量回填
├── sync-health.ts           健康检查
├── get-memory.ts            单条记忆详情
├── delete-memory.ts         隐私删除
├── timeline.ts              时间线浏览 (anchor 前后)
├── knowledge-corpus.ts      知识语料库 (7 工具)
│   ├── buildCorpus        — 构建命名语料库
│   ├── queryCorpus        — 语料库内搜索
│   ├── listCorpora        — 列出所有语料库
│   ├── rebuildCorpus      — 重新构建 (刷新)
│   ├── deleteCorpus       — 删除语料库
│   ├── primeCorpus        — 注入语料库到会话
│   └── reprimeCorpus      — 重建 + 注入
│
└── session-logger.ts        会话日志 (4 工具)
    ├── startSession       — 开始日志会话
    ├── logMessage         — 记录消息
    ├── endSession         — 结束会话 + 摘要
    └── searchSessions     — 搜索会话
```

### 3.6 src/services/

```
services/
├── short-term-memory.ts      短时记忆层
│   ├── Map<sessionId, ShortTermSession>
│   ├── addObservation()      — 写入 (50 条/会话, 100 会话上限)
│   ├── getObservations()     — 读取 (30min TTL, 自动清理)
│   └── clearSession()        — session 删除时清理
│
├── memory-buffer.ts          内存缓冲队列
│   ├── enqueueObservation()  — PG 不可用时写入内存
│   ├── flushTimer            — 30s 指数退避重试, max 10 次
│   └── MAX_QUEUE_SIZE=500    — 防内存泄漏
│
├── agent-context.ts          Agent 上下文
│   └── AGENT_CAPABILITIES    — 11 个 Agent 的共享规则
│
├── async-embedder.ts         异步 embedding 队列
│   ├── cooldown=300s         — 防频繁写入
│   └── minImportance=3       — 低价值不嵌入
│
├── logger.ts                 日志
│   └── 格式: [PG Memory] [LEVEL] [module] message
│
├── event-synchronizer.ts     事件同步
├── db-polling.ts             SQLite 轮询同步
├── opencode-schema-adapter.ts OpenCode SQLite 结构
├── keyword.ts                关键词检测
└── privacy.ts                隐私过滤
```

### 3.7 src/shared/

```
shared/
├── paths.ts                  统一路径
│   ├── DATA_DIR           — ~/.opencode-pg-memory/
│   ├── ENV_FILE_PATH      — ~/.opencode-pg-memory/.env
│   └── SETTINGS_FILE_PATH — ~/.opencode-pg-memory/settings.json
│
├── env-manager.ts            凭证管理
│   ├── loadDotEnv()          — 从 .env 加载
│   ├── saveDotEnv()          — 仅写白名单字段
│   ├── buildIsolatedEnv()    — 子进程隔离环境
│   ├── BLOCKED_ENV_VARS      — 5 条 (API keys + PG_PASSWORD)
│   ├── resolveConfig()       — process.env → .env → fallback
│   └── resolveEmbeddingApiKey() — 按 provider 选 key
│
├── settings-defaults.ts      配置合并 (4 层)
│   ├── process.env → settings.json → pg-memory.jsonc → Zod 默认
│   └── SettingsSchema        26 个字段
│
└── errors.ts                 错误层次
    ├── PgMemoryError (基类)
    ├── ConnectionError        — PG 连接失败
    ├── QueryError             — SQL 错误
    ├── EmbeddingError         — 嵌入 API 失败
    ├── ConfigurationError     — 配置缺失
    ├── DataIntegrityError     — 约束违反
    └── ExternalServiceError   — 外部服务
```

### 3.8 src/utils/

```
utils/
├── embedding.ts              Embedding 服务
│   ├── EmbeddingService      — Ollama/OpenAI/DeepSeek 统一接口
│   ├── createEmbeddingService(params)  — 从配置创建
│   └── getEmbeddingService() — 单例 (从 config 读取)
│
├── error-classifier.ts       错误分类 (7 类 × 20+ 模式)
│   ├── classifyError()       — 字符串模式匹配
│   ├── guard()               — 异步包装
│   └── guardSync()           — 同步包装
│
└── token-budget.ts           Token 预算
    └── calculateTokenBudget() — clamp(ctx×5%, 500, 4000)
```

---

## 4. 配置体系

### 4.1 优先级 (由高到低)

```
① process.env          MCP environment 注入 (运行时时注入)
② ~/.opencode-pg-memory/.env  凭证 (DB 密码, API keys)
③ ~/.opencode-pg-memory/settings.json  数据目录配置
④ ~/.config/opencode/pg-memory.json[c]   OpenCode 全局覆盖
⑤ Zod 硬编码默认值         settings-defaults.ts
```

### 4.2 凭证 vs 配置分离

| 文件 | 存什么 | 路径 |
|------|--------|------|
| `.env` | `PG_PASSWORD`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` | `~/.opencode-pg-memory/.env` |
| `settings.json` | `logLevel`, `platform`, `cleanupEnabled` 等非敏感 | `~/.opencode-pg-memory/settings.json` |
| `pg-memory.jsonc` | 项目级覆盖 | `~/.config/opencode/pg-memory.jsonc` |

### 4.3 完整配置字段 (SettingsSchema)

```typescript
pgHost                string    默认 "localhost"
pgPort                number    默认 5432
pgDatabase            string    默认 "PGOMO"
pgUser                string    默认 "opencode"
pgPassword            string    默认 ""
embeddingProvider     enum      默认 "ollama" (ollama/openai/deepseek)
embeddingModel        string    默认 "qwen3-embedding:0.6b"
embeddingDimensions   number    默认 1024
embeddingBatchSize    number    默认 10
similarityThreshold   number    默认 0.6
maxMemories           number    默认 10
logLevel              enum      默认 "info" (debug/info/warn/error)
compactionThreshold   number    默认 0.8
syncMode              enum      默认 "hybrid" (hybrid/polling/event)
pollingIntervalMs     number    默认 5000
platform              string    默认 "opencode"
contextLimitRatio     number    默认 0.02
minInjectionTokens    number    默认 500
maxInjectionTokens    number    默认 3000
minObservationQuality number    默认 0.2
cleanupAgeDays        number    默认 7
cleanupMaxPerRun      number    默认 100
cleanupEnabled        boolean   默认 true
omoEnabled            boolean   默认 false
dataDir               string    (可选)
```

### 4.4 BLOCKED_ENV_VARS

子进程环境隔离，以下变量被过滤：

```
OPENAI_API_KEY        — 防止 shell 泄露
DEEPSEEK_API_KEY      — 同上
ANTHROPIC_API_KEY     — 同上
PG_PASSWORD           — 数据库密码
PG_MEMORY_DATA_DIR    — 防止递归
```

---

## 5. 数据库设计

### 5.1 表结构

#### session_map

| 列 | 类型 | 说明 |
|----|------|------|
| id | UUID PK | 内部 ID |
| opencode_session_id | VARCHAR(255) UNIQUE | OpenCode 会话 ID |
| omo_task_id | VARCHAR(255) | oh-my-openagent 任务 ID |
| project_id | VARCHAR(255) | 项目标识 |
| model_context_limit | INTEGER | 模型上下文上限 |
| created_at | TIMESTAMPTZ | 创建时间 |
| last_active_at | TIMESTAMPTZ | 最后活跃时间 |
| metadata | JSONB | 扩展元数据 |

#### observations （核心表）

| 列 | 类型 | 说明 |
|----|------|------|
| id | UUID PK | |
| session_map_id | UUID FK | 所属会话 |
| topic_segment_id | UUID FK | 所属话题段 |
| tool_name | VARCHAR(255) | 工具名 / `user_message` |
| tool_input_summary | TEXT | 输入摘要 |
| tool_output_summary | TEXT | 输出摘要 |
| embedding | vector(1536) | 向量嵌入 |
| importance | INTEGER (1-5) | 重要性 |
| created_at | TIMESTAMPTZ | |
| metadata | JSONB | |
| source | VARCHAR(512) | 文档来源 |
| source_hash | VARCHAR(64) | 去重哈希 |
| platform_source | VARCHAR(50) | 平台标识 |
| agent_id | VARCHAR(100) | Agent 标识 |

索引:
- `idx_observations_importance`: importance DESC
- `idx_observations_created_at`: created_at DESC
- `idx_observations_embedding`: HNSW (vector_cosine_ops)
- `idx_observations_source`: source
- `idx_observations_platform_source`: platform_source

#### entities

| 列 | 类型 | 说明 |
|----|------|------|
| id | UUID PK | |
| session_map_id | UUID FK | |
| name | VARCHAR(500) | 实体名 |
| type | VARCHAR(100) | 类型 |
| tier | entity_tier (permanent/project/session) | 层级 |
| weight | FLOAT (0-10) | 权重 |
| description | TEXT | 描述 |
| embedding | vector(1536) | |
| confidence | FLOAT (0-1) | 置信度 |

#### reflections

| 列 | 类型 | 说明 |
|----|------|------|
| id | UUID PK | |
| session_map_id | UUID FK | |
| summary | TEXT | 反思总结 |
| source_observation_ids | UUID[] | 来源观察 |
| confidence | FLOAT (0-1) | 置信度 |
| pattern_type | VARCHAR(100) | 模式类型 |
| embedding | vector(1536) | |

#### session_summaries

| 列 | 类型 | 说明 |
|----|------|------|
| id | UUID PK | |
| opencode_session_id | VARCHAR(255) | |
| project_id | VARCHAR(255) | |
| platform_source | VARCHAR(50) | |
| request | TEXT | 请求 |
| investigated | TEXT | 调查过程 |
| learned | TEXT | 学到什么 |
| completed | TEXT | 完成什么 |
| next_steps | TEXT | 下一步 |

#### token_economics

| 列 | 类型 | 说明 |
|----|------|------|
| id | UUID PK | |
| session_map_id | UUID FK UNIQUE | |
| total_observations | INTEGER | |
| avg_importance | FLOAT | |
| estimated_read_tokens | INTEGER | |
| estimated_discovery_tokens | INTEGER | |
| savings_estimate | INTEGER | |

#### corpus_meta + corpus_entries

知识语料库存储。`corpus_meta` 存语料库定义，`corpus_entries` 存条目。

#### 其他

`relations`、`topic_segments`、`semantic_cache`、`token_usage_log`、`cache_threshold_log`、`reflection_errors`

### 5.2 重要性分级

| 值 | 来源 | 清理策略 |
|----|------|----------|
| 5 | 失败 + 长耗时工具调用 | 永久保留 |
| 4 | 失败的工具调用 / 长耗时 | 永久保留 |
| 3 | 普通工具调用 (默认) | 长期保留 |
| 2 | 用户消息 (基准) | 7 天后 cleanup |
| 1 | 无内容 observation | 7 天后 cleanup |
| 跳过 | 噪声消息 / 问候语 | 不入库 |

---

## 6. 钩子系统

### 6.1 注册的钩子

OpenCode 插件通过 `@opencode-ai/plugin` SDK 注册以下钩子：

```
export const OpenCodePGMemory: Plugin = async (ctx) => {
  return {
    event:                       所有事件分发
    "chat.message":              旧式注入 (保留兼容)
    "tool.execute.before":       记录入参
    "tool.execute.after":        记录出参 + 短时记忆
    "experimental.chat.system.transform":  核心注入 (每次 LLM 调用)
    "experimental.session.compacting":     压缩保护
    tool:                        MCP 工具注册
  };
}
```

### 6.2 event 事件处理

| 事件 | 处理 |
|------|------|
| session.created | → EventSynchronizer |
| message.updated | → EventSynchronizer |
| tool.execute.before/after | → EventSynchronizer |
| session.compacted | → 写 session_summary |
| session.deleted | → clearSession() |
| session.status | → EventSynchronizer |

### 6.3 钩子执行顺序 (单次 LLM 调用)

```
1. chat.message (仅首次)
2. experimental.chat.system.transform  ← 注入记忆
3. tool.execute.before
4. tool.execute.after
5. 重复 3-4 多次 (多工具调用)
6. experimental.chat.system.transform  ← 再次注入记忆
7. loop...
```

---

## 7. MCP 工具

### 7.1 完整列表 (19 个)

| 工具 | 分类 | 说明 |
|------|------|------|
| `recall_memory` | 检索 | 多策略语义检索 |
| `get_memory` | 检索 | 单条详情 |
| `timeline` | 检索 | 时间线浏览 |
| `search_sessions` | 检索 | 会话搜索 |
| `hindsight_reflect` | 反思 | LLM 提炼模式 |
| `import_document` | 知识 | 文档导入 |
| `build_corpus` | 语料库 | 构建命名语料库 |
| `query_corpus` | 语料库 | 语料库搜索 |
| `list_corpora` | 语料库 | 列出语料库 |
| `rebuild_corpus` | 语料库 | 重建语料库 |
| `delete_corpus` | 语料库 | 删除语料库 |
| `prime_corpus` | 语料库 | 注入语料库到会话 |
| `reprime_corpus` | 语料库 | 重建 + 注入 |
| `start_session` | 会话日志 | 开始日志 |
| `log_message` | 会话日志 | 记录消息 |
| `end_session` | 会话日志 | 结束日志 |
| `delete_memory` | 管理 | 隐私删除 |
| `sync_health` | 管理 | 健康检查 |
| `backfill_embeddings` | 管理 | 向量回填 |

### 7.2 传输模式

```bash
# stdio (默认，内嵌到 OpenCode/Cursor 等)
node dist/mcp-server.js

# SSE (独立进程，多客户端)
node dist/mcp-server.js --transport sse --port 37777
```

### 7.3 SSE 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/sse` | GET | 建立 SSE 流 |
| `/sse/message/{sessionId}` | POST | JSON-RPC 消息 |
| `/health` | GET | 健康检查 |

### 7.4 健康检查响应

```json
{
  "status": "healthy",
  "db": "connected",
  "uptime": 3600,
  "transports": 2
}
```

---

## 8. 注入引擎

### 8.1 注入格式

```xml
<pg_memory>
## Memory System
Context from previous sessions is injected below. Use it as reference,
not authority — project constraints may have changed.
Guidelines:
- >= 80%: high confidence, treat as confirmed knowledge
- 60-79%: moderate confidence, cross-check before acting
- < 60%: low confidence, treat as hint, verify independently
project: my-project
economics: 42 obs · 65% saved

### Session Summary
request: Fix database connection pool
learned: Pool size should be based on max_connections

### Relevant Memories
- [OBSERVATION] (85%) max_connections=100
- [REFLECTION] (72%) pattern: connection-pool-tuning
</pg_memory>
```

### 8.2 注入流程

```
experimental.chat.system.transform
  │
  ├─ 注入缓存命中? (60s TTL, system hash)
  │     → 直接拼接上次 block, 返回
  │
  ├─ 短时记忆有数据?
  │     → MemoryResult[] = getObservations(sessionId)
  │     → 返回 (零 PG 查询)
  │
  ├─ 路径 A: keywordRecall (无条件)
  │     SELECT ... WHERE project=? AND importance>=2
  │     AND created_at > NOW() - INTERVAL '90 days'
  │     ORDER BY importance DESC, created_at DESC
  │
  ├─ 路径 B: semanticRecall (需 embedding)
  │     → hasUserContent(systemPrompt)?
  │     → generateQueryEmbedding() (缓存 5min / 超时 3s)
  │     → pgvector ANN, LIMIT 20
  │
  ├─ 混合评分: sim×0.5 + imp×0.3 + rec×0.2
  ├─ content_prefix 去重
  ├─ TokenBudget (500~3000)
  ├─ formatInjectionBlock()  → 记忆压缩 + 经济学 + 元认知
  └─ output.system[0] = systemContent + "\n\n" + block
```

### 8.3 记忆压缩 (compressObservation)

```
原始:
  "[bash] input: psql -c \"SHOW max_connections\"
   output: max_connections=100"

压缩后:
  "max_connections=100"
```

策略:
1. 优先提取 `output:` 后的内容 (结果)
2. 降级到 `input:` 后的内容 (命令)
3. 取最后一个有意义的部分

### 8.4 混合评分公式

```
score = vectorSimilarity × 0.5
      + (importance / 5) × 0.3
      + recencyBoost(age, halfLife=2days) × 0.2

recencyBoost = 2^(-ageDays / halfLifeDays)
```

### 8.5 冷启动检测

```typescript
function hasUserContent(systemPrompt: string): boolean {
  if (systemPrompt.includes("<pg_memory>")) return true;  // 已有注入
  if (systemPrompt.length > 2000) return true;            // 足够长
  return false;  // 冷启动 → 跳过语义搜索
}
```

---

## 9. 短时记忆

### 9.1 设计

```
src/services/short-term-memory.ts

Map<sessionId, ShortTermSession>
  └─ ShortTermSession
       ├─ observations: ShortTermObservation[]
       └─ lastAccess: Date
```

### 9.2 参数

| 参数 | 值 | 说明 |
|------|-----|------|
| MAX_OBS_PER_SESSION | 50 | 防单会话内存泄漏 |
| MAX_SESSIONS | 100 | 总会话数上限 |
| SESSION_TTL_MS | 30min | 无访问自动过期 |
| 清理周期 | 60s | 后台定时器 |

### 9.3 写入时机

| 触发点 | 写入内容 |
|--------|----------|
| `message.updated` (用户消息) | addObservation(sessionId, {toolName:"user_message", ...}) |
| `tool.execute.after` | addObservation(sessionId, {toolName:"bash", ...}) |
| `session.deleted` | clearSession(sessionId) |

### 9.4 读取时机

| 触发点 | 行为 |
|--------|------|
| `system.transform` | getObservations(sessionId) → 有数据则返回，不查 PG |
| 短时记忆空 | 降级到两路召回 (PG) |

---

## 10. 韧性设计

### 10.1 PG 不可用

```
                   ┌──────────────┐
                   │  PG 宕机      │
                   └──────┬───────┘
                          │
           ┌──────────────┼──────────────┐
           │              │              │
     MCP 服务器       tool-execute     system.transform
           │              │              │
   返回 Database       enqueue() →     短时记忆有 → 注入
   Unavailable        内存队列          短时记忆无 → 空 (无 PG 检索)
           │              │
                    30s 定时 flush
                    指数退避, max 10 次
                    超限 → 丢弃
```

### 10.2 Embedding 不可用

```
generateQueryEmbedding()
  ├─ 缓存命中 (5min TTL) → 直接用
  ├─ 3s 超时 → 降级为 keyword-only
  └─ API Key 不存在 → 降级为 keyword-only
```

### 10.3 LLM 调用失败 (system.transform)

```
try/catch 包裹:
  └─ logger.error  → 不影响主流程
  └─ output.system[0] 保持原样
```

---

## 11. 跨平台集成

### 11.1 支持的平台

| 平台 | 方式 | 配置文件 |
|------|------|----------|
| OpenCode | Plugin SDK + MCP | `opencode.jsonc` |
| Claude Code | MCP (stdin/CLAUDE.md) | `platform-templates/claude-code-mcp.md` |
| Cursor | MCP (.cursor/mcp.json) | `platform-templates/cursor-mcp.json` |
| Windsurf | MCP (.windsurf/mcp.json) | `platform-templates/windsurf-mcp.json` |
| Continue.dev | MCP (config.json) | `platform-templates/continue-config.json` |

### 11.2 Platform source 标记

每个 observation 记录来源平台:

| 值 | 平台 |
|----|------|
| `opencode` | OpenCode |
| `claude-code` | Claude Code |
| `cursor` | Cursor |
| `windsurf` | Windsurf |
| `continue` | Continue.dev |

---

## 12. 开发指南

### 12.1 环境准备

```bash
git clone https://github.com/Vbs313/opcode-pg-memory.git
cd opcode-pg-memory
cp .env.example ~/.opencode-pg-memory/.env
# 编辑 ~/.opencode-pg-memory/.env，填入 PG 凭证
bun install
bun run build
```

### 12.2 可用命令

```bash
bun run build         # 完整构建 (tsc + bun bundle)
bun run typecheck     # 类型检查 (strict: true)
bun run test          # 运行测试 (jest)
bun run test:coverage # 测试覆盖报告
bun run clean         # 清理 dist
```

### 12.3 构建产物

```
dist/
├── index.js           # 插件入口 (re-export)
├── mcp-server.js      # MCP 服务器 (bundle: 1.5MB)
├── cli.js             # CLI 工具 (bundle: 171KB)
└── src/               # 编译后的源文件 + .d.ts
```

### 12.4 代码规范

- `strict: true` — 零 `as any`，零隐式 `any`
- 所有 `process.env` 通过 `env-manager.ts` 集中读取
- 所有日志通过 `logger`，不用 `console.log`
- 所有钩子非阻塞：`try/catch` 包裹
- Zod schema 作为配置单一事实来源
- Error 类型通过 `instanceof` 区分

### 12.5 新增 MCP 工具步骤

1. 在 `src/mcp/` 中创建工具实现文件
2. 在 `mcp-server.ts` 的 `TOOLS` 数组添加定义
3. 在 `mcp-server.ts` 的 `TOOL_HANDLERS` 添加处理函数
4. 编写测试
5. `bun run build` 验证 bundle

---

## 13. 测试

### 13.1 测试文件 (15 suites, 172 tests)

```
tests/
├── system-transform-injector.test.ts    58 tests  — 注入引擎纯函数
├── settings-defaults.test.ts             20 tests  — 配置合并
├── token-budget.test.ts                   — Token 预算
├── config.test.ts                         6 tests  — 构建配置
├── env-manager.test.ts                    7 tests  — 环境变量
├── error-classifier.test.ts               — 错误分类
├── observation-scorer.test.ts             2 tests  — 评分格式化
├── observation-cleanup.test.ts            4 tests  — 配置验证
├── session-summary-writer.test.ts         2 tests  — 模块导出
├── semantic-cache.test.ts                 — 语义缓存
├── hooks.test.ts                          — 钩子单元测试
├── event-sync.test.ts                     — 事件同步
├── mcp-tools.test.ts                      — MCP 工具
├── aggregate-similar.test.ts              — 聚合去重
└── integration.test.ts                    — 集成测试 (mock PG)
```

### 13.2 运行

```bash
bun run test                 # 全部测试
npx jest tests/integration   # 指定文件
npx jest --coverage          # 覆盖报告
```

---

## 14. 发布流程

### 14.1 完整发布

```bash
# 1. 确保测试通过
bun run test

# 2. 构建
bun run build

# 3. 更新版本
npm version <major|minor|patch> --no-git-tag-version

# 4. 提交
git add -A
git commit -m "vX.Y.Z: ..."
git push origin main

# 5. 发布
npm publish
```

### 14.2 版本历史

| 版本 | 说明 |
|------|------|
| 3.5.3 | 消息重要性评分 |
| 3.5.2 | 噪声过滤 |
| 3.5.1 | 用户消息捕获 |
| 3.5.0 | 短时记忆层 |
| 3.4.1 | SQLite→内存队列 |
| 3.4.0 | 写缓冲 + 元认知 + eval |
| 3.3.0 | 上下文压缩 + 优雅降级 |
| 3.2.0 | prime/reprime 语料库 |
| 3.1.0 | MCP SDK v1.29 |
| 3.0.1 | 17 工具 + 3 技能 |
| 3.0.0 | 两路召回 + strict 迁移 |
