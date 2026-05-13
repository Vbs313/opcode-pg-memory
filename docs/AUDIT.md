# opcode-pg-memory 完整审计报告

> 生成日期: 2026-05-12 | 版本: v3.10.0 | 审计范围: 全部 39 个源文件 + 数据库 + 集成

---

## 目录

1. [项目脉络概览](#1-项目脉络概览)
2. [数据流全景](#2-数据流全景)
3. [钩子系统审计](#3-钩子系统审计)
4. [MCP 工具审计](#4-mcp-工具审计)
5. [数据库 Schema 与迁移审计](#5-数据库-schema-与迁移审计)
6. [内存状态审计](#6-内存状态审计)
7. [边界问题清单](#7-边界问题清单)
   - [P0 — 可能引起崩溃或数据丢失](#p0--可能引起崩溃或数据丢失)
   - [P1 — 性能/资源泄漏](#p1--性能资源泄漏)
   - [P2 — 设计缺陷/竞态条件](#p2--设计缺陷竞态条件)
   - [P3 — 最佳实践偏离](#p3--最佳实践偏离)
8. [测试覆盖审计](#8-测试覆盖审计)
9. [配置面审计](#9-配置面审计)
10. [与 oh-my-openagent 集成边界](#10-与-oh-my-openagent-集成边界)

---

## 1. 项目脉络概览

### 1.1 架构层次

```
OpenCode 进程空间
┌─────────────────────────────────────────────────────────┐
│  插件入口 src/index.ts                                    │
│  ├── 6 个生命周期钩子 (event/chat/tool.before/tool.after │
│  │   /system.transform/session.compacting)               │
│  └── 2 个 Plugin Tool (syncHealth, backfillEmbeddings)    │
│                                                          │
│  MCP 服务器 mcp-server.ts (stdio/SSE 双模)               │
│  └── 18 个 MCP 工具 (通过 TOOLS + TOOL_HANDLERS 注册)    │
│                                                          │
│  内存状态 (进程级单例)                                    │
│  ├── short-term-memory.ts   Map<sessionId, Obs[]>        │
│  ├── memory-buffer.ts       BufferedObservation[] 队列    │
│  ├── output-compressor.ts   fileReadRegistry Map          │
│  ├── system-transform-injector.ts injectionCache Map       │
│  └── embeddingCache         Map<query, embedding>        │
│                                                          │
│  PostgreSQL (外部进程)                                    │
│  └── 9 张业务表 + 6 张辅助表                              │
└─────────────────────────────────────────────────────────┘
```

### 1.2 数据量基准

| 指标 | 值 |
|------|-----|
| observations | ~9,923 行 |
| sessions | 299 |
| reflections | ~45+ |
| 工具调用分布 | bash 610, read 235, edit 162, write 66, todowrite 60 |
| PG 连接池 | 默认 10 (未显式配置) |
| 短时内存 | ≤50 obs/会话, ≤100 会话 |
| 缓冲队列 | ≤500 obs |
| 注入缓存 | ≤50 条目, 60s TTL |

---

## 2. 数据流全景

### 2.1 工具执行流

```
用户/Agent 操作
  ↓
① tool.execute.before 钩子触发
  ├── handleToolExecuteBefore()
  │   ├── session_map 查询 (SELECT id FROM session_map WHERE opencode_session_id = $1)
  │   └── INSERT INTO observations (tool_name, input_summary, ...) with status='pending'
  └── 完成后 → OpenCode 执行工具
      ↓
② tool.execute.after 钩子触发
  ├── compressOutput()  ← 在 RAW 输出上运行
  │   ├── Stage 1: 重复读检测 (fileReadRegistry)
  │   ├── Stage 2: 命令特定 filter (npm/git/bash/...)
  │   └── Stage 3: 通用规则 (空行折叠/重复行/硬截断)
  │   └── 修改 output.output
  │
  ├── handleToolExecuteAfter()
  │   ├── session_map 再次查询 ← 🔴 重复查询
  │   ├── 更新 observations 行 (从 'pending' → output)
  │   ├── 检测因果链 (5分钟内 failure→fix)
  │   ├── 写入短时记忆 (addObservation)
  │   └── (可选) 入队 memory-buffer ← 🔴 未使用
  │
  └── 完成后 → OpenCode 将 output 传给 LLM
      ↓
③ experimental.chat.system.transform 触发 (每次LLM调用)
  ├── 两路召回:
  │   ├── 路径 A: 关键词检索 (当前项目, 90天, importance排序)
  │   └── 路径 B: 语义检索 (pgvector ANN, 3s 超时降级)
  ├── 跨项目回退 (< 3 条时)
  ├── Active Rules 注入 (reflections WHERE applied_at IS NOT NULL)
  ├── 会话摘要 + Token 经济 + 因果链
  └── 合并到 output.system[0] ← 非 push
```

### 2.2 反思流

```
hindsight_reflect MCP 工具
  ├── resolveScope() → session_map 或 legacy sessions
  ├── collectObservations() → top 200 (importance DESC)
  ├── groupBySegment() → 按 topic_segments 分组
  └── reflectOnSegment() per batch of 10
      ├── performReflectionWithLLM()
      │   ├── (当前: 永远走 performHeuristicReflection)
      │   └── 产出 6 种 pattern 类型
      └── storeReflection()
          ├── INSERT INTO reflections (含 action_plan JSONB)
          └── 更新 session_map.reflection_last_at
```

### 2.3 行为闭环流 (v3.9+)

```
apply_reflection MCP 工具
  ├── SELECT from reflections WHERE id = pattern_id
  ├── 检查 applied_at (幂等)
  ├── 检查 action_plan (必须有 trigger/action)
  ├── appendRuleToRulesMd() ← 同步 fs 写入
  │   └── ~/.config/opencode/rules.md
  └── UPDATE reflections SET applied_at = NOW()

下次 system.transform 触发:
  └── fetchActiveRules()
      └── SELECT FROM reflections WHERE applied_at IS NOT NULL
      └── 注入为 "### Active Rules" 段
```

---

## 3. 钩子系统审计

### 3.1 event (统一事件总线)

```
签名: (input: { event: { type, properties } }) => Promise<void>
功能:
  1. 所有事件 → eventSync.handleEvent() → 写入 PG
  2. session.compacted → buildAndWriteSessionSummary()
  3. session.deleted → clearSession()

边界问题:
  [P2] session.compacted 和 session.deleted 的 properties 结构可能不同
       (properties.sessionID vs properties.session?.id)
  [P3] console.error 直接写 stderr (第 357 行)，应该用 logger.error
```

### 3.2 chat.message (每次 LLM 调用)

```
签名: (input, output) => Promise<void>
功能:
  1. 检测用户消息是否包含记忆关键词
  2. 匹配时追加合成消息到 output.parts

边界问题:
  [P3] 方法注释说 "Note: memory injection is now handled by system.transform"
       但 chat.message 仍保留关键词检测。如果 system.transform 已经处理了记忆注入，
       chat.message 的 MEMORY_NUDGE_MESSAGE 可能产生重复或冗余通知
```

### 3.3 tool.execute.before

```
签名: (input, output) => Promise<void>
功能:
  1. 查询 session_map 获取 internal ID
  2. INSERT INTO observations 带 status='pending'

边界问题:
  ✅ 无阻塞异常处理 (try/catch)
  [P0!] session_map 查询可能失败 → 但已 catch
  [P2] tool.execute.before 和 tool.execute.after 各自独立查询 session_map
       同一个工具执行内两次相同查询
```

### 3.4 tool.execute.after

```
签名: (input, output) => Promise<void>
功能:
  1. compressOutput() 修改 output.output
  2. handleToolExecuteAfter() → UPDATE observations
  3. 因果链检测
  4. 短时记忆写入
  5. (可选) memory-buffer enqueue

边界问题:
  [P2] compressOutput 的压缩结果存储在 observations 表，
       但 LLM 收到的 system.transform 注入从 observations 读取。
       如果压缩过度损失语义，反思质量会下降。
  [P3] memory-buffer 的 enqueueObservation 在 handleToolExecuteAfter 中被注释掉了？
       需确认是否使用。
```

### 3.5 experimental.chat.system.transform (核心注入)

```
签名: (input, output) => Promise<void>
功能:
  1. 缓存检查 (60s TTL)
  2. buildInjectionBlock() → 两路召回 + 排序 + 去重 + 压缩
  3. fetchActiveRules() → 已应用的反思模式
  4. 追加到 output.system[0]

边界问题:
  [P1] 缓存 eviction 策略: 超过 50 条时, 对所有条目按时间戳排序找最旧的
       O(n log n) 操作, n=50 时可接受但不是最优
  [P2] Active Rules 查询在每次 LLM 调用时执行, 即使没有新的 applied reflection
  [P2] 全局回退查询 (< 3 条项目内结果) 可能返回大量跨项目记忆
```

### 3.6 experimental.session.compacting

```
签名: (input, output) => Promise<void>
功能:
  1. handleSessionCompacting() → 注入 session summary + tool experiences
  2. handleSessionCompacted() → 异步写入 session_summaries

边界问题:
  [P3] setTimeout 500ms 后显示 toast (第 600 行)
       延迟和 toast API 是 OpenCode 特定的, 可能在其他平台不可用
```

---

## 4. MCP 工具审计

### 4.1 注册表结构

```typescript
const TOOLS: Tool[] = [...]       // 定义 18 个工具
const TOOL_HANDLERS = {}          // 映射 name → handler
```

### 4.2 工具清单

| 工具 | 类型 | 是否有输入校验 | 是否有错误处理 | 备注 |
|------|------|---------------|---------------|------|
| recall_memory | MCP | ✅ | ✅ | |
| hindsight_reflect | MCP | ✅ | ✅ | |
| import_document | MCP | ✅ | ✅ | DEPRECATED |
| apply_reflection | MCP | ✅ | ✅ | |
| get_memory | MCP | ✅ | ✅ | |
| delete_memory | MCP | ✅ | ✅ | |
| timeline | MCP | ✅ | ✅ | |
| knowledge-corpus x7 | MCP | ✅ | ✅ | |
| session-logger x4 | MCP | ✅ | ✅ | |
| syncHealth | Plugin Tool | ✅ | ✅ | |
| backfillEmbeddings | Plugin Tool | ✅ | ✅ | |

### 4.3 边界问题

```
[P0] apply-reflection.ts 使用同步文件 I/O:
  readFileSync + writeFileSync (第 63, 110 行)
  在 MCP 工具处理函数中阻塞事件循环。
  虽然 rules.md 很小 (<50KB), 并发写入可能导致竞态。

[P0] rules.md 无并发写保护:
  两次 apply_reflection 同时调用 → 都读取原始 content →
  都修改 → 后写入者覆盖前写入者的追加内容。

[P2] TOOL_HANDLERS 映射使用 `as unknown as XxxInput` 类型转换
  (第 502, 530, 552, 709, 727 等行)
  运行时无 schema 验证, 传入错误类型的参数会静默通过并导致奇怪的 PG 错误。

[P3] MCP 服务器无认证/授权
  任何能连接 stdio/SSE 端口的进程都可以调用所有工具。
```

---

## 5. 数据库 Schema 与迁移审计

### 5.1 表结构完整性

| 表 | 创建位置 | 索引 | 迁移保护 | 风险 |
|----|---------|------|---------|------|
| session_map | init-db.ts:142 | 3 | IF NOT EXISTS | ✅ |
| topic_segments | init-db.ts:156 | 2 + HNSW | IF NOT EXISTS | ✅ |
| entities | init-db.ts:174 | 5 + HNSW | IF NOT EXISTS | ✅ |
| relations | init-db.ts:193 | 5 | IF NOT EXISTS | ✅ |
| session_summaries | init-db.ts:209 | 2 | IF NOT EXISTS | ✅ |
| observations | init-db.ts:236 | 7 + HNSW | IF NOT EXISTS | ✅ |
| reflections | init-db.ts:260 | 5 + HNSW | IF NOT EXISTS | ✅ |
| reflection_errors | init-db.ts:276 | 2 | IF NOT EXISTS | ✅ |
| semantic_cache | init-db.ts:289 | 7 + HNSW | IF NOT EXISTS | ✅ |
| token_usage_log | init-db.ts:307 | 3 | IF NOT EXISTS | ✅ |
| cache_threshold_log | init-db.ts:320 | 1 | IF NOT EXISTS | ✅ |
| token_economics | init-db.ts:331 | 1 | IF NOT EXISTS | ✅ |

### 5.2 迁移执行顺序

```
setupDatabase():
  BEGIN
  1. createExtensions()      — vector + uuid-ossp
  2. createEnums()           — entity_tier + relation_type
  3. createTables()          — 全部 12 张表
  4. migrateLegacyColumnNames() — session_id → session_map_id
  5. migrateObservationsSource() — 加 source/platform_source/agent_id/causal
  6. migrateV39Schema()      — tier + action_plan + applied_at  ← [P1]
  7. createIndexes()         — 全部索引  ← [P1]
  8. initializeOmOSchema()   — source_agent + agent_task_id
  COMMIT
```

### 5.3 边界问题

```
[P1] 迁移步骤 5/6 使用 SAVEPOINT 隔离错误:
  - 如果 ALTER TABLE 失败, ROLLBACK TO SAVEPOINT 后继续。
  - 但如果步骤 5 失败, 步骤 7 的 createIndexes 尝试在 source/platform_source
    列上建索引, 而这些列可能不存在 → 索引创建会失败。
  - 但实际上 createIndexes 也使用 IF NOT EXISTS + try/catch, 所以错误被吞了。

[P2] causal_role CHECK 约束:
  CHECK (causal_role IN ('cause', 'fix'))
  如果将来添加新角色 (如 'related'), 需要 ALTER TABLE 删除约束重建。

[P3] PG 连接池默认配置:
  无 max=20/connectionTimeoutMillis/idleTimeoutMillis 等显式设置。
  使用 pg.Pool 默认值 (max=10, idleTimeoutMillis=10000)。

[P3] vector 维度硬编码为 1536:
  如果使用的嵌入模型输出不同维度 (Ollama 的 qwen3-embedding 输出 1024),
  pgvector 索引需要在创建时指定正确的维度, 否则 INSERT 会失败。
  但 CREATE TABLE observations(id..., embedding vector(1536))
  硬编码为 1536, 与 ENV 中的 EMBEDDING_DIMENSIONS=1024 不一致。
```

---

## 6. 内存状态审计

### 6.1 状态总览

| 状态 | 类型 | 最大大小 | 清理策略 | 泄漏风险 |
|------|------|---------|---------|---------|
| short-term-memory sessions | Map | 100 sessions × 50 obs = ~500KB | 60s interval TTL | 🟢 低 |
| memory-buffer queue | Array | 500 items = ~2MB | 10×30s 重试后丢弃 | 🟢 低 |
| fileReadRegistry | Map | 无上限 | 仅 per-session 手动清除 | 🔴 高 |
| injectionCache | Map | 50 items | >50 时 O(n log n) evict | 🟢 低 |
| embeddingCache | Map | 无上限 (5min TTL) | 仅过期删除 | 🟡 中 |
| sseTransports (mcp-server) | Map | 无上限 | session 断开时删除 | 🟡 中 |

### 6.2 高泄漏风险: fileReadRegistry

```typescript
// output-compressor.ts:143
const fileReadRegistry = new Map<string, Map<string, number>>();
// key: sessionId → Map<filePath, count>
// 只在 clearReadRegistry(sessionId) 被显式调用时删除
// 除 session-compacting.ts 和 session-completed.ts 外无人调用
```

**问题**: `fileReadRegistry` 只在 `session.deleted` 事件 (通过 `clearSession`) 或被会话 compaction 钩子调用时才清除。如果 session 从未触发这些事件 (例如长时间运行的主会话), Map 会无限增长。每个条目 ~100 bytes, 1000 个 session × 100 个文件 → ~10MB。

### 6.3 中等泄漏风险: embeddingCache

```typescript
// system-transform-injector.ts:28
const embeddingCache = new Map<string, { hash: string; embedding: number[]; timestamp: number }>();
// TTL: 5 分钟, 但无大小上限, 仅 TTL 过期后惰性删除
```

如果 LLM 调用频繁 (每 30s 一次), 每次调用生成新的缓存条目, 5 分钟内可能累积 ~10 条, 每条 ~1KB (1536 维 float × 4 bytes + overhead)。风险低但无大小保护。

---

## 7. 边界问题清单

### P0 — 可能引起崩溃或数据丢失

| # | 文件 | 行号 | 问题 | 影响 |
|---|------|------|------|------|
| **1** | apply-reflection.ts | 63,110 | 同步文件 I/O (`readFileSync`/`writeFileSync`) 阻塞 MCP 事件循环。**并发写入竞态**: 同时调用两次 → 后写入者覆盖前写入者 | 规则丢失、MCP 响应延迟 |
| **2** | output-compressor.ts | 143-156 | `fileReadRegistry` 无全局自动清理。长时间运行的主 session 不触发 `session.deleted`, Map 无限增长 | 内存泄漏 (可达 10MB+) |
| **3** | memory-buffer.ts | 109-131 | flush 时 `queue.splice(0)` 取出全部, 失败的 item 重新 `push` 回队列。如果一批中的部分 INSERT 成功, 部分失败, 成功的不回滚, 失败的重新入队 | 数据部分写入, 部分待重试。PG 无事务保护 |
| **4** | init-db.ts | 236,247 | `embedding vector(1536)` 硬编码。`EMBEDDING_DIMENSIONS=1024` 时 INSERT 会失败 | 向量化功能不可用 |

### P1 — 性能/资源泄漏

| # | 文件 | 行号 | 问题 | 影响 |
|---|------|------|------|------|
| **5** | index.ts | 143-148, 456-466 | `tool.execute.before` 和 `tool.execute.after` 各自独立查询 `SELECT id FROM session_map`, 每次工具执行 2 次相同查询 | 每次工具调用额外 ~2ms PG 查询 |
| **6** | injection/... | 546-549 | injectionCache evict 时对全部缓存排序 `O(n log n)`, 虽然 n ≤ 50 | 可优化为随机淘汰 |
| **7** | injection/... | ~840 | 全局回退查询 (`< 3 条项目结果时`) 可能返回数百条跨项目记忆, 超出 token budget 限制 | 注入过多, 被迫截断, 无效的 PG 查询 |

### P2 — 设计缺陷/竞态条件

| # | 文件 | 行号 | 问题 | 影响 |
|---|------|------|------|------|
| **8** | apply-reflection.ts | 75-110 | `appendRuleToRulesMd` 非原子: read → modify → write。并发调用竞态 | 规则丢失 |
| **9** | init-db.ts | 634-676 | `migrateV39Schema` 中的 SAVEPOINT 如果在 ALTER TABLE 失败后 ROLLBACK TO, `createIndexes` 会尝试在不存在列上建索引 | 索引创建静默失败 |
| **10** | mcp-server.ts | 502, 530, 552 | `as unknown as XxxInput` 类型转换无运行时校验 | 错误参数类型导致 PG 错误 |
| **11** | hindsight-reflect.ts | ~800 | `performReflectionWithLLM` 永远不走 LLM 路径 (代码被注释) | 反思质量固定为启发式, 永远无法升级 |
| **12** | hooks/tool-execute.ts | 83-112 | session_map 查询在循环中无缓存 | 高频工具调用可能压垮 PG |

### P3 — 最佳实践偏离

| # | 文件 | 行号 | 问题 | 建议 |
|---|------|------|------|------|
| **13** | index.ts | 357 | `console.error` 直接写 stderr | 改用 `logger.error` |
| **14** | init-db.ts | 117 | `CREATE EXTENSION IF NOT EXISTS vector` — 无 pgvector 时创建失败 | 建议优雅降级, 跳过向量索引 |
| **15** | mcp-server.ts | 全局 | MCP 服务器无认证 | 非产品级问题, 本地使用可接受 |
| **16** | types.ts | 全局 | `Record<string, any>` 泛滥 (metadata, properties, args) | 可用 `unknown` + 类型守卫 |
| **17** | index.ts | 67 | 插件事件类型用 `any` | 建议明确的联合类型 |
| **18** | 多文件 | 多处 | `catch {}` 空 catch 块 (不记录错误) | 建议至少 `logger.warn` |

---

## 8. 测试覆盖审计

### 8.1 测试套件分布

| 测试文件 | 测试数 | 测试内容 | 覆盖评价 |
|---------|--------|---------|---------|
| system-transform-injector.test.ts | 58 | 注入引擎纯函数 | ✅ 强 |
| token-budget.test.ts | — | Token 预算 | 🟡 一般 |
| observation-scorer.test.ts | 2 | 评分格式化 | ❌ 弱 |
| observation-cleanup.test.ts | 4 | 配置验证 | 🟡 一般 |
| session-summary-writer.test.ts | 2 | 模块导出 | ❌ 弱 |
| semantic-cache.test.ts | — | 语义缓存 | 🟡 一般 |
| hooks.test.ts | — | 钩子单元测试 | 🟡 一般 |
| event-sync.test.ts | — | 事件同步 | 🟡 一般 |
| mcp-tools.test.ts | — | MCP 工具 | 🟡 一般 |
| aggregate-similar.test.ts | — | 聚合相似 | 🟡 一般 |
| integration.test.ts | — | 集成测试 | 🟡 一般 |

### 8.2 未覆盖的关键路径

```
❌ hindsight-reflect.ts 没有单元测试
   - performHeuristicReflection() 无测试
   - storeReflection() 无测试
   - resolveScope() 无测试

❌ apply-reflection.ts 没有测试
   - appendRuleToRulesMd() 无测试
   - 文件系统交互无测试

❌ output-compressor.ts 没有测试
   - 12 种命令 filter 无测试
   - 重复读检测无测试
   - 空行/重复行折叠无测试

❌ short-term-memory.ts 没有测试
❌ memory-buffer.ts 没有测试
❌ mcp-server.ts TOOL_HANDLERS 无集成测试
```

### 8.3 测试基础设施

```
jest.config.js — 配置存在
tests/setup.ts — 测试 setup 存在
覆盖率: 无覆盖率报告配置 (package.json 中 jest --coverage 但未设阈值)
```

---

## 9. 配置面审计

### 9.1 可配置参数

| 变量 | 默认值 | 文件位置 | 是否生效 | 风险 |
|------|--------|---------|---------|------|
| PG_HOST/PORT/DATABASE/USER/PASSWORD | localhost:5432/opencode_memory/opencode/"" | config.ts | ✅ | |
| EMBEDDING_PROVIDER/MODEL/DIMENSIONS | ollama/qwen3-embedding:0.6b/1024 | config.ts | ✅ | 🔴 与 schema 1536 冲突 |
| PG_MEMORY_SYNC_MODE | hybrid | index.ts | ✅ | |
| PG_MEMORY_POLL_INTERVAL | 5000 | index.ts | ✅ | |
| PG_MEMORY_EMBED_COOLDOWN | 300000 | index.ts | ✅ | |
| PG_MEMORY_EMBED_MIN_IMPORTANCE | 3 | index.ts | ✅ | |
| PG_MEMORY_DB_POLLING | true | index.ts | ✅ | |
| PG_MEMORY_OUTPUT_MAX_CHARS | 10000 | output-compressor.ts | ✅ | |
| CACHE_ENABLED | true | index.ts | ✅ | |
| REFLECTION_ENABLED | true | index.ts | ✅ | |
| TOKEN_CONTEXT_LIMIT_RATIO | 0.05 | index.ts | ✅ | |
| TOKEN_MIN_TOKENS | 500 | index.ts | ✅ | |
| TOKEN_MAX_TOKENS | 4000 | index.ts | ✅ | |
| RETRIEVAL_WEIGHT_SEMANTIC/RECENCY/IMPORTANCE | 0.5/0.3/0.2 | index.ts | ✅ | |

### 9.2 配置风险

```
[P0] EMBEDDING_DIMENSIONS 默认 1024 (config.ts:798)
     但 observations.embedding vector(1536) 硬编码 1536 (init-db.ts:243)
     → 使用非 1536 维度时, pgvector INSERT 会失败:
     "expected 1536 dimensions, not 1024"

[P2] ENV 变量命名不统一:
     PG_MEMORY_* 前缀: PG_MEMORY_SYNC_MODE, PG_MEMORY_POLL_INTERVAL
     无前缀: CACHE_ENABLED, REFLECTION_ENABLED, TOKEN_MIN_TOKENS
     → 用户需要记忆两组命名规则

[P3] offPeakHours 用逗号分隔字符串:
     REFLECTION_OFF_PEAK_HOURS="1,2,3,4,5"
     如果用户写 "1, 2, 3" (带空格), parseInt 后的 NaN 被 filter 丢弃,
     静默忽略, 用户可能不知道为什么低峰期没生效。
```

---

## 10. 与 oh-my-openagent 集成边界

| 集成点 | 状态 | 风险 |
|--------|------|------|
| rules.md 双向读写 | ✅ 工作 | [P2] 并发写入竞态 |
| command/pg-memory-* 命令 | ✅ 工作 | 无 |
| skills/pg-memory-* 技能 | ✅ 工作 | 无 |
| truncate_all_tool_outputs | ✅ 兼容 | 无 (已验证) |
| dynamic_context_pruning | ✅ 兼容 | 无 |
| Active Rules 注入 | ✅ 工作 | 无 |
| Agent 模型分隔符 | ✅ 已修复 | `:` → `/` |

---

## 11. 建议修复优先级

### 立即修复 (P0)

```
1. apply-reflection.ts 并发写保护:
   - 添加文件锁或原子写入 (write to temp → rename)
   - 或改用 append-only 模式

2. embedding 维度对齐:
   - 将 init-db.ts 中的 vector(1536) 改为动态: `vector(${EMBEDDING_DIMENSIONS})`
   - 或从 config 读取维度
```

### 本周修复 (P1)

```
3. fileReadRegistry 自动清理:
   - 添加定期清理 timer (如 30 分钟无访问清除)
   - 或使用 WeakMap + TTL

4. session_map 查询缓存:
   - 在 tool-execute.ts 中添加 sessionId → internalId 缓存, 5 分钟 TTL
   - 消除每次工具执行的双重查询
```

### 下月修复 (P2)

```
5. tests 覆盖 hindsight-reflect.ts + apply-reflection.ts + output-compressor.ts
6. embeddingCache 添加大小上限
7. 类型系统加强: Record<string, any> → unknown + 类型守卫
8. performReflectionWithLLM 连接真实 LLM
```

---

## 附录: 关键文件索引

| 文件 | 行数 | 复杂度 | 修改频率 |
|------|------|--------|---------|
| src/index.ts | 983 | 高 | 高 |
| src/mcp/hindsight-reflect.ts | 1410 | 极高 | 高 |
| src/injection/system-transform-injector.ts | 975 | 高 | 高 |
| src/db/init-db.ts | 753 | 中 | 中 |
| src/hooks/tool-execute.ts | 500 | 中 | 中 |
| mcp-server.ts | 1043 | 高 | 中 |
| src/mcp/apply-reflection.ts | 175 | 低 | 低 |
| src/services/output-compressor.ts | 284 | 中 | 低 |
| src/services/short-term-memory.ts | 101 | 低 | 低 |
| src/services/memory-buffer.ts | 165 | 中 | 低 |
