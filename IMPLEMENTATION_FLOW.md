# opcode-pg-memory 实现流程

> v2.3.0 — EventSynchronizer 架构

## 目录

1. [数据流总图](#1-数据流总图)
2. [EventSynchronizer](#2-eventsynchronizer)
3. [DB Polling 兜底](#3-db-polling-兜底)
4. [插件钩子清单](#4-插件钩子清单)
5. [MCP 工具](#5-mcp-工具)
6. [斜杠命令](#6-斜杠命令)
7. [存储结构](#7-存储结构)
8. [配置项](#8-配置项)

---

## 1. 数据流总图

```
┌─────────────────────────────────────────────────────────────────┐
│                       OpenCode 实例                              │
│  ┌──────────┐  ┌──────────┐  ┌─────────┐  ┌──────────────────┐ │
│  │ TUI 终端  │  │ Desktop  │  │ CLI run │  │ Web API (4096)   │ │
│  └────┬─────┘  └────┬─────┘  └────┬────┘  └────────┬─────────┘ │
│       │             │             │                 │           │
│       └─────────────┴──────┬──────┴─────────────────┘           │
│                            │                                    │
│                     OpenCode 事件总线                            │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ session.created │ tool.execute.after │ message.updated│       │
│  │ session.completed │ session.compacted │ ...           │       │
│  └──────────────────────────┬───────────────────────────┘       │
└─────────────────────────────┼───────────────────────────────────┘
                              │
                  ┌───────────┴───────────┐
                  │      插件事件钩子       │
                  │   (src/index.ts)       │
                  └───────────┬───────────┘
                              │
                              ▼
                  ┌───────────────────────┐
                  │  EventSynchronizer    │  ← 统一入口
                  │  src/services/        │
                  │  event-synchronizer.ts │
                  │                       │
                  │  1. mode 过滤         │
                  │  2. 去重窗口 (5s)     │
                  │  3. 乐观锁重试 (×3)   │
                  └───────┬───────────────┘
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
     ┌──────────────┐      ┌──────────────────┐
     │  钩子处理器    │      │  DB Polling       │
     │ (hook source) │      │ (poll source)     │
     └───────┬──────┘      └────────┬─────────┘
             │                      │
             ▼                      ▼
     ┌──────────────────────────────────────────────┐
     │             PostgreSQL (PGOMO)               │
     │  session_map → topic_segments                │
     │       → entities / observations / relations   │
     │       → reflections / semantic_cache          │
     └──────────────────────────────────────────────┘
                          ▲
                          │
     ┌────────────────────┴┐
     │  OpenCode SQLite    │  ← DB Polling 读取来源
     │  ~/.local/share/    │
     │  opencode/opencode.db│
     └─────────────────────┘
```

---

## 2. EventSynchronizer

**文件**: `src/services/event-synchronizer.ts`
**职责**: 所有写操作的统一入口。钩子和轮询都生成 PluginEvent 对象，推入 EventSynchronizer 处理。

### PluginEvent 结构

```typescript
interface PluginEvent {
  id: string;                  // `${type}:${sessionId}:${timestamp}`
  type: PluginEventType;       // 'session.created' | 'tool.execute.after' | ...
  sessionId: string;           // OpenCode session ID
  timestamp: number;           // Unix ms
  version: number;             // 乐观锁版本号
  source: 'hook' | 'poll';    // 来源
  data: Record<string, any>;   // 事件载荷
}
```

### 处理流程

```
handleEvent(event)
  │
  ├─ 1. mode 过滤
  │   event-only → 跳过 poll 来源
  │   poll-only  → 跳过 hook 来源
  │   hybrid     → 全部通过
  │
  ├─ 2. 去重检查
  │   同一 type + sessionId + version 在 5s 内重复 → 跳过
  │   最近 1000 条记录，超过 60s 的自动清理
  │
  ├─ 3. 确保 session_map 存在
  │   INSERT INTO session_map ON CONFLICT DO NOTHING
  │
  ├─ 4. 分发到具体处理器
  │   session.created     → handleSessionCreated()
  │   session.completed   → handleSessionCompleted()
  │   session.compacted   → handleSessionCompacted()
  │   message.updated     → handleMessageUpdated()
  │   tool.execute.before → handleToolExecuteBefore()
  │   tool.execute.after  → handleToolExecuteAfter()
  │
  └─ 5. 乐观锁更新
     UPDATE session_map SET version = version + 1
     WHERE id = $1 AND version = $2
     失败 → 重试（最多 3 次，50ms → 250ms → 1s 退避）
```

### 重试策略

| 尝试 | 延迟 | 说明 |
|:----:|:----:|------|
| 第 1 次 | 50ms | 立即重试 |
| 第 2 次 | 250ms | 指数退避 ×5 |
| 第 3 次 | 1s | 指数退避 ×4 |
| 失败 | — | 日志记录，不阻断主流程 |

---

## 3. DB Polling 兜底

**文件**: `src/services/db-polling.ts`
**职责**: 当 OpenCode 事件总线不触发时（如 Desktop WebView），定期轮询 SQLite 数据库同步数据。

### 真实数据库结构（经现场确认）

OpenCode SQLite 不用平铺列，message 和 part 的关键内容存放在 JSON 文本字段中：

```
session (扁平列)
  ├─ id (TEXT PK)
  ├─ title, time_created, agent, model
  │
  ├─ message (data=TEXT JSON)
  │   ├─ id, session_id, time_created
  │   └─ data: { role, agent, modelID, tokens, time, parentID }
  │
  ├─ part (data=TEXT JSON)
  │   ├─ id, message_id, session_id, time_created
  │   └─ data: { type, text?, tool?, callID?, state: { status, input, output } }
  │
  ├─ event (data=TEXT JSON)
  │   └─ id, aggregate_id, seq, type, data
  │
  ├─ session_message (桥接)
  └─ __drizzle_migrations (ORM 版本)
```

### 两段式查询流程

OpenCode 的消息存储**不**是扁平列，必须两段读取：

```
1. message 表 → 读出 JSON
   { role: "assistant", agent: "Sisyphus", modelID: "deepseek-v4", tokens: {...} }

2. part 表 → 读出 JSON (一条 message 对应多条 part)
   { type: "text", text: "正在分析..." }
   { type: "tool", tool: "bash", callID: "call_xxx", state: { status: "completed", input: {...}, output: "..." } }
   { type: "reasoning", text: "..." }
```

### 同步流程

```
start()
  ├─ 连接 OpenCode SQLite
  ├─ 加载 PG 中已有的 session_map ID 到 knownSessions Set
  └─ 定时 sync() 循环（默认每 5 秒，成功则保持，失败退避）
      │
      ├─ 1. 读取新 sessions
      │   SELECT id, title, time_created FROM session
      │   未在 knownSessions 中 → 生成 PluginEvent(session.created, source='poll')
      │
      ├─ 2. 读取新 messages
      │   SELECT id, session_id, data FROM message WHERE time_created > lastSyncTime
      │   → parse JSON: { role, agent, modelID, tokens }
      │   → 生成 PluginEvent(message.updated, source='poll')
      │
      └─ 3. 对每条新 message, 读取其 parts
          SELECT data FROM part WHERE message_id = ?
          → parse JSON: { type, tool, callID, state }
          → type === 'tool' → 生成 PluginEvent(tool.execute.after, source='poll')
```

### 退避策略

| 场景 | 行为 |
|------|------|
| 正常 | 每 5 秒同步一次 |
| SQLite 连接失败 | 降级日志，不阻塞插件 |
| JSON 解析失败 | 跳过该条，不影响本轮其他数据 |
| 连续失败 | 间隔翻倍：5s → 10s → 20s → ... → 最大 60s |
| 恢复成功 | 立即重置为初始间隔 |

### 关键风险声明

1. **message.data 和 part.data 是内部 JSON 格式，非公共 API**。OpenCode 随时可能变更结构
2. **Drizzle ORM 管理表结构**，`__drizzle_migrations` 表中的迁移记录可做版本检测
3. **轮询是兜底机制，不是主路径**。主路径仍是 OpenCode 事件总线（TUI/CLI/web server）
4. **此轮询逻辑仅适配当前已知结构**，OpenCode 升级后需要验证

---

## 4. 插件钩子清单

| # | 钩子 | source | 功能 | 是否通过 Synchronizer |
|---|------|--------|------|:--------------------:|
| 1 | `event` | hook | 处理 session.created/tool.execute.after 等 | ✅ |
| 2 | `chat.message` | hook | 首条消息注入 [PG MEMORY] 上下文 | ❌ (只读) |
| 3 | `tool.execute.before` | hook | 拦截工具参数 | ⚠️ 部分通过 |
| 4 | `tool.execute.after` | hook | 记录工具输出为观察 | ✅ |
| 5 | `experimental.session.compacting` | hook | 压缩时 Toast + 上下文保留 | ❌ (只读) |
| 6 | `experimental.chat.system.transform` | hook | 系统提示词注入工具说明 | ❌ (只读) |

### 只读（不经过 Synchronizer）

以下操作只读 DB，不走写入路径：

- `chat.message` → `retrieveFactsForInjection()` 查询 entities
- `experimental.chat.system.transform` → 纯字符串拼接
- `experimental.session.compacting` → Toast 通知（UI 操作）
- MCP 工具 `recall_memory`、`hindsight_reflect` → 查询 PG

---

## 5. MCP 工具

注册在 `src/index.ts` 和 `mcp-server.ts` 中。

### recall_memory

```
输入: query (string)
     caller_context?: { type, current_goal, current_session_id }
     filters?: { tier, entity_types, min_confidence, time_range_days }
     max_results?: number (默认 10)

流程:
  query → 生成嵌入向量 → HNSW 检索
       → BM25 全文搜索
       → Graph 实体关系遍历
       → 多策略合并 (0.5×语义 + 0.3×时效 + 0.2×重要性)
       → 衰减计算 (exp(-0.01 × days_since_last_seen))
       → 按 relevance_score 排序 → 返回 top-k
```

### hindsight_reflect

```
输入: session_id / omo_task_id / topic_segment_id (三选一)
     trigger_type: 'manual' | 'threshold' | 'scheduled'
     aggregate?: boolean
     model_size?: '7b' | '14b' | 'full'

流程:
  参数 → 收集 observations → 按 topic_segment 分组
       → 每 10 条一批 → 规则匹配错误/工具/成功模式
       → 生成 reflections 表记录
```

---

## 6. 斜杠命令

| 命令 | 文件 | 功能 |
|------|------|------|
| `/pg-memory-init` | `~/.config/opencode/command/pg-memory-init.md` | 验证插件安装 |
| `/pg-memory-reflect` | `同上/pg-memory-reflect.md` | 一键反思 |
| `/pg-memory-sync` | `同上/pg-memory-sync.md` | 同步历史会话到 PG |
| `/pg-memory-note` | `同上/pg-memory-note.md` | 手动记录观察 |

通过 `bunx opcode-pg-memory install` 自动创建，存放于 `~/.config/opencode/command/`。

---

## 7. 存储结构

### OpenCode SQLite（数据源）

| 表 | 内容 | 读取方式 |
|----|------|----------|
| `session` | 会话元数据 (id, title, time_created, agent, model) | 扁平列 |
| `message` | 消息元数据 (id, session_id, data:TEXT JSON → role, tokens, modelID) | 解析 JSON data |
| `part` | 消息部件 (data:TEXT JSON → type:text/tool, tool, callID, state) | 解析 JSON data |
| `event` | 事件溯源 (type, data:TEXT JSON) | 解析 JSON data |
| `session_message` | 会话-消息桥接 | 辅助查询 |
| `__drizzle_migrations` | ORM 迁移版本 | 版本检测 |

### PostgreSQL (PGOMO) — 插件的长期记忆存储

```
session_map
  ├─ opencode_session_id (VARCHAR) ← OpenCode session.id
  ├─ version (INTEGER) ← 乐观锁
  ├─ last_active_at
  │
  ├─ topic_segments ← 话题段
  │   ├─ segment_index, summary, embedding
  │   └─ observation_count, closed_at
  │
  ├─ entities ← 实体（从 message/part 中提取）
  │   ├─ name, type, tier (session/project/permanent)
  │   └─ weight, confidence, embedding
  │
  ├─ observations ← 工具执行观察
  │   ├─ tool_name, tool_input_summary, tool_output_summary
  │   ├─ importance (1-5), embedding
  │   └─ message_id ← 关联 OpenCode message.id
  │
  ├─ relations ← 实体关系
  │
  ├─ reflections ← 反思模式
  │
  ├─ semantic_cache ← 语义缓存
  │
  └─ token_usage_log ← 用量日志
```

### 读写分离

| 操作 | 数据源 | 路径 |
|------|--------|------|
| 读取 session 列表 | SQLite | OpenCodeSchemaAdapter.getRecentSessions() |
| 读取 message | SQLite | OpenCodeSchemaAdapter → parse message.data JSON |
| 读取 part (含 tool call) | SQLite | OpenCodeSchemaAdapter → parse part.data JSON |
| 写入 session_map | PG | EventSynchronizer.handleEvent() → pool.query |
| 写入 observations | PG | EventSynchronizer → handleToolExecuteAfter() |
| 写入 entities | PG | message.updated handler |
| 写入 reflections | PG | hindsight_reflect 工具 |
| 查询 entities | PG | recall_memory / chat.message |

---

## 8. 配置项

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PG_MEMORY_SYNC_MODE` | `hybrid` | `event-only` \| `poll-only` \| `hybrid` |
| `PG_MEMORY_POLL_INTERVAL` | `5000` | 轮询间隔（ms） |
| `PG_MEMORY_DB_POLLING` | `true` | `false` 禁用轮询 |
| `PG_MEMORY_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `PG_HOST` | `localhost` | PostgreSQL 主机 |
| `PG_PORT` | `5432` | PostgreSQL 端口 |
| `PG_DATABASE` | `PGOMO` | PostgreSQL 库名 |
| `PG_USER` | `opencode` | PostgreSQL 用户 |
| `PG_PASSWORD` | — | PostgreSQL 密码 |

### 配置文件

`~/.config/opencode/pg-memory.jsonc`（可选，支持 JSONC 注释）：

```jsonc
{
  "syncMode": "hybrid",
  "logLevel": "info",
  "maxMemories": 10,
  "similarityThreshold": 0.6,
  "compactionThreshold": 0.85
}
```

---

**文档版本**: 1.0 | **对应插件**: v2.3.0 | **更新**: 2026-05-06
