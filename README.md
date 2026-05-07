# opcode-pg-memory

**OpenCode 长期记忆插件** — PostgreSQL + pgvector 四层记忆架构，11 Agent 记忆隔离 · 跨会话语义检索 · MCP 工具

[![npm](https://img.shields.io/npm/v/opcode-pg-memory)](https://www.npmjs.com/package/opcode-pg-memory)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

## 安装

```bash
# npm 安装（推荐）
bunx opcode-pg-memory install

# 或从 GitHub
git clone https://github.com/Vbs313/opcode-pg-memory.git && cd opcode-pg-memory
.\script\setup.ps1
```

`bunx install` 会自动注册插件到 `opencode.jsonc` 并创建 `/pg-memory-init` 命令。

## 项目结构

```
opcode-pg-memory/
├── src/
│   ├── index.ts               # 插件入口 — 注册全部 7 个生命周期钩子
│   ├── config.ts               # Zod 配置层 — 环境变量 → 文件 → 默认值三层合并
│   ├── types.ts                # 类型定义
│   ├── cli.ts                  # CLI 安装工具
│   ├── db/
│   │   └── init-db.ts           # PostgreSQL 数据库初始化（全表结构 + 迁移）
│   ├── hooks/
│   │   ├── tool-execute.ts      # tool.execute.before/after — 自动记录工具调用到记忆
│   │   ├── session-created.ts   # session 创建钩子
│   │   ├── session-completed.ts # session 完成钩子
│   │   ├── session-compacting.ts# 会话压缩钩子
│   │   ├── message-updated.ts   # 消息更新钩子
│   │   └── message-part-updated.ts
│   ├── mcp/
│   │   ├── recall-memory.ts     # 多策略语义检索（BM25 + 向量 + 图遍历 + 关键词）
│   │   ├── hindsight-reflect.ts # 跨会话反思
│   │   ├── import-document.ts   # 文档导入（事务性 DELETE+INSERT + 语义分块）
│   │   ├── backfill-embeddings.ts # 向量回填
│   │   └── sync-health.ts       # 同步健康检查
│   ├── services/
│   │   ├── async-embedder.ts    # 异步 embedding 队列
│   │   ├── event-synchronizer.ts# 事件同步器
│   │   ├── keyword.ts           # 关键词检测
│   │   └── logger.ts            # 日志
│   ├── utils/
│   │   ├── error-classifier.ts  # 错误分类系统（7 类 × 20+ 模式匹配，对标 oh-my-openagent）
│   │   ├── embedding.ts         # Embedding 服务
│   │   └── token-budget.ts      # Token 预算计算
│   └── cache/
│       └── semantic-cache.ts    # 语义缓存（向量相似度去重）
├── mcp-server.ts               # MCP 服务器入口（TOOL_HANDLERS 注册表模式）
├── index.ts                    # 插件导出入口
├── script/                     # 运维脚本
│   ├── setup.ps1                # Windows 安装脚本
│   ├── migration-v2.sql         # 数据库迁移
│   └── doc-indexer.mjs          # 文档知识库索引（直连 PostgreSQL）
├── docs/                       # 文档
│   ├── PLUGIN_DOCUMENTATION.md  # 架构详解
│   ├── USAGE_GUIDE.md           # 使用指南
│   └── 新方向.md                 # 架构升级规划
└── AGENTS.md                   # Agent 记忆使用指南
```

## 注册

在 `~/.config/opencode/opencode.jsonc` 中确认 MCP 配置：

```jsonc
{
  "mcp": {
    "pg-memory": {
      "type": "local",
      "command": ["bun", "path/to/opcode-pg-memory/dist/mcp-server.js"],
      "enabled": true,
      "environment": {
        "PG_HOST": "localhost", "PG_PORT": "5432",
        "PG_DATABASE": "PGOMO",  "PG_USER": "opencode",
        "PG_PASSWORD": "你的密码",
        "EMBEDDING_PROVIDER": "ollama",
        "EMBEDDING_MODEL": "qwen3-embedding:0.6b",
        "EMBEDDING_DIMENSIONS": "1024"
      }
    }
  }
}
```

验证：`opencode --print-logs --log-level INFO | findstr "PG Memory"` → 看到 `Plugin initialized successfully`

## 配置

三重优先级：**MCP environment > ~/.config/opencode/pg-memory.jsonc > 默认值**

```jsonc
// ~/.config/opencode/pg-memory.jsonc（可选）
{
  "similarityThreshold": 0.7,
  "maxMemories": 15,
  "logLevel": "info",
  "compactionThreshold": 0.85
}
```

| Provider | 模型 | 维度 |
|----------|------|------|
| `ollama` | `qwen3-embedding:0.6b` | 1024 |
| `deepseek` | `text-embedding-v2` | 1536 |
| `openai` | `text-embedding-3-small` | 1536 |

## MCP 工具

### recall_memory

```json
// Agent 自主调用
recall_memory({
  "query": "数据库连接池配置",
  "caller_context": { "type": "omo_agent", "current_goal": "性能调优" },
  "scope": "task",
  "aggregate_similar": true,
  "retrieval_strategies": ["semantic", "graph"],
  "filters": { "tier": "project" }
})
```

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `scope` | `session` / `task` / `project` | `session` | 检索范围：当前会话 / 同任务所有会话 / 同项目所有会话 |
| `aggregate_similar` | `boolean` | `false` | 合并连续同名工具调用（如 `read ×47 最近读取了...`），仅在查询层聚合，不丢失明细 |

### hindsight_reflect

```json
// 跨会话反思
hindsight_reflect({ "omo_task_id": "task_123", "aggregate": true })
```

### sync_health

```json
// 检查同步健康状态（无参数）
sync_health()

// 返回示例
{
  "status": "healthy",
  "observations": { "total": 9922, "with_embedding": 9922, "embedding_pct": 100, "sessions_with_obs": 272 },
  "embedder": { "queue_length": 0, "cooldown_remaining_s": null },
  "warnings": []
}
```

Agent 自愈模式：`sync_health` 发现 coverage < 95% → `backfill_embeddings` → `sync_health` 确认恢复。

### import_document

```json
// 导入文档到记忆库（原子性 DELETE+INSERT）
import_document({
  "source": "docs/ARCHITECTURE.md#section-3",
  "content": "项目架构说明..."
})
```

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `source` | `string` | 必填 | 文档唯一标识（推荐 `路径#段落`） |
| `content` | `string` | 必填 | 文档内容（自动按 markdown heading 语义分块） |
| `overlap` | `int` | 100 | 分块重叠字符数 |
| `chunk_size` | `int` | 1500 | 每块最大字符数 |

所有 MCP 工具通过 `TOOL_HANDLERS` 注册表派发（`mcp-server.ts`），新增工具只需在注册表中添加一行。

## 架构特性

| 特性 | 说明 |
|------|------|
| **Zod 配置层** | 所有配置通过 `ConfigSchema` 校验（`src/config.ts`），支持 env → file → 默认值三层合并 |
| **错误分类系统** | `src/utils/error-classifier.ts` — 7 类错误 × 20+ 模式匹配，`guard()` / `guardSync()` 包装器 |
| **注册表派发** | `TOOL_HANDLERS` 替代 if-chain，新增工具只需一行 |
| **事务性操作** | `import_document` 在单事务内完成 DELETE+INSERT |
| **语义分块** | 按 markdown heading → 段落 → 硬切三级 fallback |## backfill_embeddings

```json
// 回填缺失的 embedding
backfill_embeddings({ "limit": 100 })
backfill_embeddings({})  // 全量
```

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `limit` | `number` | `0`（全量） | 限制处理条数 |

使用 AsyncEmbedder 队列执行，支持 Ollama 不可用时 5 分钟冷却自动续传。已覆盖的 observation（`embedding IS NOT NULL`）不会重复处理。

## 架构

```
session_map → topic_segments → entities / observations / relations / reflections
                              → semantic_cache (HNSW 动态阈值)
                              → token_usage_log
```

## 项目结构

```
src/
├── index.ts        # 插件入口（chat.message + event hook）
├── config.ts       # 集中配置（文件+环境+默认值）
├── cli.ts          # CLI（install 命令）
├── types.ts        # 类型定义
├── db/init-db.ts   # 数据库初始化 + 迁移
├── hooks/          # 生命周期钩子
├── mcp/            # MCP 工具实现
├── services/       # Agent 上下文 · 同步管道 · 日志
├── topic/          # 话题段管理器
├── cache/          # 语义缓存
└── utils/          # 嵌入生成 · Token 预算
mcp-server.ts       # MCP 服务入口
```

## 运维

### 同步对账

```bash
# 查看同步健康度
node script/verify-sync.js

# JSON 输出（用于自动化/监控）
node script/verify-sync.js --json
```

健康状态标志：

| 指标 | 健康 | 告警 |
|------|------|------|
| 同步率 | ≥ 99.5% | < 99% |
| tool_status = 'failed' 占比 | < 5% | > 10% |
| 缺失会话数 | 0 | > 0 |
| 含 tool_call_id 比例 | 100% | < 99% |
| embedding 覆盖度 | ≥ 95% | < 95% |

首次部署后执行一次全量同步：

```bash
node script/verify-sync.js
# 确认同步率 >= 99.5%
```

`verify-sync.js` 是只读脚本，不修改数据库。同步由 EventSynchronizer 自动通过 OpenCode 事件总线或 SQLite 轮询完成。

Agent 可直接调用 `sync_health()` 获取相同信息（`status`、`embedding_pct`、`warnings`）。

### 批量 embedding 回填

首次部署或新增 embedding 模型后，对历史观察生成向量：

```bash
# 查看待回填数量
node script/backfill-embeddings.js --dry-run

# 全量回填（按 created_at 顺序，支持断点续传）
node script/backfill-embeddings.js

# 限制处理条数（快速验证）
node script/backfill-embeddings.js --limit 100
```

## 文档

| 文档 | 内容 | 路径 |
|------|------|------|
| **使用指南** | 完整配置 · 工具调用 · 运维 | [docs/USAGE_GUIDE.md](./docs/USAGE_GUIDE.md) |
| **架构详解** | 钩子系统 · 数据库设计 · 错误分类 | [docs/PLUGIN_DOCUMENTATION.md](./docs/PLUGIN_DOCUMENTATION.md) |
| **Agent 指南** | 11 Agent 能力表 · 跨 Agent 共享规则 | [AGENTS.md](./AGENTS.md) |
| **架构升级** | Zod 配置 + 错误分类 + 注册表重构记录 | [docs/新方向.md](./docs/新方向.md) |

## 数据流

```
Agent 调用 MCP 工具
  └→ mcp-server.ts (TOOL_HANDLERS 注册表派发)
      └→ src/mcp/*.ts (工具逻辑)
          └→ src/db/init-db.ts (PostgreSQL + pgvector)
              └→ observations / entities / reflections / relations 表
```

Agent 每次工具调用自动记录到 `observations` 表（通过 `tool.execute.before/after` 钩子），后续可通过 `recall_memory` 检索。

[GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)
