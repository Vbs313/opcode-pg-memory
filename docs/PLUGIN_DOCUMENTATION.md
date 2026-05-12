# opcode-pg-memory 插件架构详解 (v3.9)

> PostgreSQL + pgvector 跨平台记忆系统 — 2026-05

---

## 1. 架构总览

### v3.5 架构层次

```
┌──────────────────────────────────────────────────────────────────┐
│                    注入层 (src/injection/)                        │
│  system-transform-injector   session-summary-writer              │
│  observation-scorer          observation-cleanup                 │
│  两路召回+混合评分+记忆压缩    自动写入+评分+清理+eval             │
├──────────────────────────────────────────────────────────────────┤
│                  服务层 (src/services/)                           │
│  short-term-memory.ts  memory-buffer.ts                          │
│  Map<sessionId, Obs[]>  内存队列+指数退避                         │
│  async-embedder.ts     logger.ts                                │
├──────────────────────────────────────────────────────────────────┤
│                  基础设施层 (src/shared/)                          │
│  paths.ts  env-manager.ts  settings-defaults.ts  errors.ts       │
│  数据目录    凭证管理+BLOCKED    4层配置合并+Zod   6 Error 子类    │
├──────────────────────────────────────────────────────────────────┤
│                    钩子层 (src/hooks/)                            │
│  tool.execute.before/after  session.created/completed/compacting │
│  message-updated (噪声过滤+重要性评分)                             │
│  experimental.chat.system.transform                              │
├──────────────────────────────────────────────────────────────────┤
│                    MCP 工具层 (src/mcp/)                          │
│  recall_memory  hindsight_reflect  import_document               │
│  timeline  get_memory  delete_memory                             │
│  knowledge-corpus (7工具)  session-logger (4工具)                 │
│  backfill_embeddings  sync_health  ← 共 19 个                    │
├──────────────────────────────────────────────────────────────────┤
│                    存储层 (PostgreSQL + pgvector)                  │
│  session_map  observations  entities  relations                  │
│  reflections  topic_segments  semantic_cache                     │
│  token_usage_log  session_summaries  token_economics             │
│  corpus_meta  corpus_entries                                     │
└──────────────────────────────────────────────────────────────────┘
```

### 设计原则

1. **配置单一来源** — 所有字段由 `Zod schema` 定义类型和默认值，消除手动 `as` 双重维护
2. **凭证与配置分离** — `.env` 只存 API keys / DB 密码，非敏感配置走 `settings.json`
3. **子进程隔离** — `BLOCKED_ENV_VARS` 防止父进程凭据泄露
4. **非阻塞** — 所有钩子 `try/catch`，不影响主流程
5. **`strict: true`** — 零隐式 any，零 null 不安全访问
6. **注册表派发** — `TOOL_HANDLERS` 替代 if-chain，新增工具只需一行

---

## 2. 核心概念

### 2.1 配置体系

**优先级（由高到低）**：

```
① process.env (运行时注入)
② ~/.opencode-pg-memory/.env (数据目录凭证)
③ ~/.opencode-pg-memory/settings.json (数据目录配置)
④ ~/.config/opencode/pg-memory.jsonc (OpenCode 全局覆盖)
⑤ 硬编码 Zod 默认值
```

**凭证白名单**：`saveDotEnv()` 只持久化以下 8 个字段：

```
PG_HOST  PG_PORT  PG_DATABASE  PG_USER  PG_PASSWORD
OPENAI_API_KEY  DEEPSEEK_API_KEY  DEEPSEEK_BASE_URL
```

**BLOCKED_ENV_VARS**（构建子进程环境时删除）：

```
OPENAI_API_KEY    — 防止 shell 泄露
DEEPSEEK_API_KEY  — 同上
ANTHROPIC_API_KEY — 同上
PG_PASSWORD       — 数据库密码
PG_MEMORY_DATA_DIR — 防止递归
```

### 2.2 注入引擎

`experimental.chat.system.transform` 钩子，每次 LLM 调用前触发。

**两路召回流程**：

```
输入: system prompt content
  │
  ├─ 路径 A (关键词，无条件)
  │   SELECT ... FROM observations
  │   WHERE project = $1 AND importance >= 2
  │   ORDER BY importance DESC, created_at DESC
  │   LIMIT 20
  │
  ├─ 路径 B (语义，需 embedding API)
  │   SELECT ... FROM observations
  │   WHERE embedding IS NOT NULL
  │   ORDER BY embedding <=> $query_embedding
  │   LIMIT 20
  │
  ├─ 混合评分
  │   score = similarity × 0.5 + importance × 0.3 + recency × 0.2
  │
  ├─ 去重 (content prefix, 100 chars)
  ├─ TokenBudget (max 3000, min 500)
  └─ 合并到 output.system[0]
```

**合并方式** — 追加到第一条 system message 末尾（非 `push` 新条目），兼容只接受单条 system message 的 vLLM/Qwen 后端。

### 2.3 事件捕获链

```
session.created          → 初始化 session_map
tool.execute.before      → 记录工具调用入参
tool.execute.after       → 记录工具输出 + 格式化
message.updated          → 实体提取
session.compacted        → 写入 session_summaries
session.completed        → 触发反思
```

---

## 3. 数据库设计

### 3.1 表结构

| 表 | 用途 | 关键列 |
|----|------|--------|
| `session_map` | 会话映射 | opencode_session_id, project_id, model_context_limit |
| `observations` | 工具调用记录 | tool_name, importance, embedding, platform_source, agent_id |
| `entities` | 命名实体 | name, type, tier(permanent/project/session), weight |
| `relations` | 实体关系 | source/target_entity_id, relation_type |
| `reflections` | 经验模式 | summary, pattern_type, confidence |
| `topic_segments` | 话题分段 | segment_index, summary, embedding |
| `semantic_cache` | 语义缓存 | query_hash, query_embedding, hit_count |
| `session_summaries` | 会话摘要 (v3.0) | request, investigated, learned, completed, next_steps |
| `token_economics` | Token 经济 (v3.0) | total_observations, avg_importance, savings_estimate |
| `token_usage_log` | Token 使用日志 | operation_type, tokens_used |

### 3.2 索引

- `observations`: 按 `project_id`, `importance`, `created_at`, `platform_source` 索引 + HNSW 向量索引
- `entities`: 按 `type`, `tier+weight`, `name` 索引
- `topic_segments`: HNSW 向量索引
- `session_summaries`: 按 `opencode_session_id`, `project_id` 索引

---

## 4. 钩子系统

| 钩子 | 触发时机 | 功能 |
|------|----------|------|
| `event` | 所有系统事件 | 分发到 EventSynchronizer + session.compacted → 写 session_summary |
| `chat.message` | 新消息到达 | 首次消息时注入记忆（旧方式）+ 关键词检测 |
| `tool.execute.before` | 工具执行前 | 记录入参到 observations |
| `tool.execute.after` | 工具执行后 | 记录出参 + 更新 observation |
| `experimental.chat.system.transform` | 每次 LLM 调用前 | **两路召回 + 混合评分 + 自动注入** |
| `experimental.session.compacting` | 会话压缩 | 标记高价值 observation，保留 |
| `tool` | 注册 MCP 工具 | recall_memory, hindsight_reflect 等 |

---

## 5. 跨平台

### MCP 服务器传输模式

```
stdio (默认):
  OpenCode / Cursor / Windsurf 等直接启动子进程

SSE (--transport sse --port 37777):
  HTTP 服务器，多客户端可同时连接
  GET  /sse          → SSE 流
  POST /sse/message/{id} → JSON-RPC 消息
```

### 平台标记

每个 observation 记录 `platform_source` 字段，标记来源平台：

- `opencode` — OpenCode
- `claude-code` — Claude Code
- `cursor` — Cursor
- `windsurf` — Windsurf
- `continue` — Continue.dev

所有平台共享同一个 PostgreSQL 数据库，通过 MCP 协议通信。

---

## 6. 错误处理

`error-classifier.ts` 将错误分为 7 类 × 20+ 模式：

| 类别 | 示例模式 |
|------|----------|
| `connection` | ECONNREFUSED, ETIMEDOUT, getaddrinfo |
| `fatal` | 认证失败、数据库不存在 |
| `recoverable` | 死锁、超时 |
| `query` | 语法错误、列不存在 |
| `internal` | 未知异常 |

所有钩子使用 `try/catch` 包裹，日志输出后继续执行，不阻断主流程。

---

## 7. 版本演进

| 维度 | v2.x | v3.0 | v3.5 |
|------|------|------|------|
| TypeScript strict | `false` (6 flag) | `true` | `true` |
| 配置目录 | 插件根目录 `.env` | `~/.opencode-pg-memory/.env` | 同 v3.0 |
| 配置层数 | 3 层 | 4 层 | 4 层 |
| 注入方式 | `chat.message` parts | `system.transform` merge system[0] | 同 v3.0 + 短时记忆优先 |
| 召回策略 | 单一重要性排序 | 两路召回 + 混合评分 | 同 v3.0 + 冷启动检测 |
| 记忆压缩 | 无 | 无 | `compressObservation()` output-first |
| 短时记忆 | 无 | 无 | `short-term-memory.ts` Map 缓存 |
| 用户消息 | 不捕获 | 不捕获 | `message-updated` 噪声过滤 + 评分入库 |
| 韧性 | 无 | graceful fallback | 同 v3.0 + memory-buffer 队列 |
| 凭证管理 | 散落 process.env | env-manager.ts + BLOCKED | 同 v3.0 |
| 错误层次 | 仅有 classifier | classifier | classifier + 6 Error 子类 |
| MCP SDK | ^0.5.0 | ^0.5.0 | ^1.29.0 |
| 跨平台 | 无 | 5 模板 | 5 模板 |
| MCP 工具 | 5 | 19 | 19 |
| Agent 技能 | 0 | 3 | 3 |
| 测试 | 9 / 69 | 14 / 168 | 15 / 172 |
