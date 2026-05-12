# opcode-pg-memory v3.9+ 使用指南

> 更新至 v3.9 | strict:true | Actionable Patterns | apply_reflection | Active Rules | 分层存储

完整的架构和配置参考请见 `REFERENCE.md`。

---

## 目录

1. [安装](#1-安装)
2. [配置](#2-配置)
3. [MCP 工具](#3-mcp-工具)
4. [注入引擎](#4-注入引擎)
5. [跨平台集成](#5-跨平台集成)
6. [Token 经济](#6-token-经济)
7. [运维与监控](#7-运维与监控)
8. [故障排查](#8-故障排查)

---

## 1. 安装

### 前置条件

| 组件 | 要求 | 验证 |
|------|------|------|
| PostgreSQL | 16+（需 pgvector） | `SELECT extname FROM pg_extension WHERE extname='vector'` |
| Node.js | >= 18 | `node --version` |
| Ollama（可选） | `qwen3-embedding:0.6b` | `ollama pull qwen3-embedding:0.6b` |

### npm 安装

```bash
bun install opcode-pg-memory
```

### 源码安装

```bash
git clone https://github.com/Vbs313/opcode-pg-memory.git
cd opcode-pg-memory
bun run build
```

### 初始化数据库

插件首次启动时自动创建所有表结构。如需手动初始化：

```bash
# 数据库已由 init-db.ts 自动初始化，无需手动执行 SQL
```

### 注册到 OpenCode

`~/.config/opencode/opencode.jsonc`：

```jsonc
{
  "plugin": [
    "opcode-pg-memory"
  ],
  "mcp": {
    "pg-memory": {
      "type": "local",
      "command": ["bun", "path/to/opcode-pg-memory/dist/mcp-server.js"],
      "enabled": true,
      "environment": {
        "PG_HOST": "localhost",
        "PG_PORT": "5432",
        "PG_DATABASE": "PGOMO",
        "PG_USER": "opencode",
        "PG_PASSWORD": "你的密码",
        "PG_MEMORY_PLATFORM": "opencode"
      }
    }
  }
}
```

验证：OpenCode 启动日志出现 `[PG Memory] Plugin initialized successfully`。

---

## 2. 配置

### 4 层配置优先级

```
① process.env (MCP environment 注入)
② ~/.opencode-pg-memory/.env (凭证)
③ ~/.config/opencode/pg-memory.jsonc (OpenCode 全局)
④ 硬编码默认值 (Zod schema)
```

### 凭证文件

创建 `~/.opencode-pg-memory/.env`（优先使用 MCP `environment` 块也可以）：

```bash
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=PGOMO
PG_USER=opencode
PG_PASSWORD=your_password
```

### 配置文件

创建 `~/.config/opencode/pg-memory.jsonc`：

```jsonc
{
  // 检索阈值 (0-1，越高越严格)
  "similarityThreshold": 0.7,

  // 每次注入的最大记忆数
  "maxMemories": 15,

  // 日志级别: debug | info | warn | error
  "logLevel": "info",

  // 自动清理低质量 observation
  "cleanupEnabled": true,

  // 平台标识
  "platform": "opencode"
}
```

### 嵌入模型

| Provider | 模型 | 维度 | 备注 |
|----------|------|------|------|
| `ollama` | `qwen3-embedding:0.6b` | **1024** | 本地免费，推荐 |
| `deepseek` | `text-embedding-v2` | **1536** | 需 API Key |
| `openai` | `text-embedding-3-small` | **1536** | 需 API Key |

---

## 3. MCP 工具

### recall_memory — 记忆检索

| 参数 | 类型 | 说明 |
|------|------|------|
| `query` | string | 检索查询文本 |
| `scope` | `session\|task\|project` | 检索范围，默认 `session` |
| `retrieval_strategies` | array | `semantic`, `bm25`, `graph`, `keyword` |
| `max_results` | number | 最大结果数，默认 10 |

### hindsight_reflect — 会话反思

| 参数 | 类型 | 说明 |
|------|------|------|
| `session_id` | string | 指定会话 ID |
| `trigger_type` | `threshold\|scheduled\|manual` | 触发类型 |

### import_document — 文档导入 [DEPRECATED v3.9]

| 参数 | 类型 | 说明 |
|------|------|------|
| `source` | string | 文档唯一标识 |
| `content` | string | 文档内容（纯文本） |
| `chunk_size` | number | 分块大小，默认 1500 |

> v3.9 起标记为 deprecated。Agent 不需要文档切片，仅操作记忆有价值。功能保留但不再改进。

### apply_reflection — 应用规则 [NEW v3.9]

| 参数 | 类型 | 说明 |
|------|------|------|
| `pattern_id` | string | reflections 表 UUID（来自 hindsight_reflect 输出的 `id`） |

将可执行的反思模式（含 action_plan）写入 `~/.config/opencode/rules.md`，
标记 `applied_at`。下次 LLM 调用时，该规则通过 **Active Rules** 自动注入到 Agent 上下文。

### 其他 MCP 工具

完整列表见 REFERENCE.md 第 6 章，共 **19 个工具**：
`recall_memory`, `hindsight_reflect`, `apply_reflection`, `import_document`,
`get_memory`, `delete_memory`, `timeline`,
`build_corpus`, `query_corpus`, `list_corpora`, `rebuild_corpus`,
`delete_corpus`, `prime_corpus`, `reprime_corpus`,
`start_session`, `log_message`, `end_session`, `search_sessions`

---

## 4. 注入引擎

v3.0 核心功能：每次 LLM 调用前，通过 `experimental.chat.system.transform` 自动注入相关记忆。

### 两路召回

```
路径 A (关键词): 当前项目的高重要性 observation
路径 B (语义):   pgvector ANN，以 system prompt 为 query

合并 → 混合排序 → 去重 → TokenBudget → 注入 system[0]
```

### 注入格式 (v3.9)

```xml
<pg_memory>
## Memory System
...
Guidelines:
- >= 80%: high confidence, treat as confirmed knowledge
- 60-79%: moderate confidence, cross-check before acting
- < 60%: low confidence, treat as hint, verify independently
project: my-project
economics: 42 obs · 65% saved

### Session Summary
request: Fix database connection pool
learned: Pool size should be based on max_connections

### Active Rules (v3.9+)
- When `edit` (output: error):
  → When edit reports errors, retry with verbose output before fixing.
  (These rules are persisted in rules.md — you may follow them automatically.)

### Relevant Memories
- [OBSERVATION] (85%) max_connections=100
- [REFLECTION] (72%) pattern: connection-pool-tuning
</pg_memory>
```

### Active Rules 自动注入 (v3.9+)

应用 `apply_reflection` 后，已标记的规则在每次 LLM 调用时自动注入。
规则来源：`reflections WHERE applied_at IS NOT NULL AND action_plan IS NOT NULL`

Agent 直接在上下文中看到规则，无需显式调用 `recall_memory`。

### 行为闭环

```
hindsight_reflect → action_plan  →  apply_reflection
                                    → rules.md 持久化
                                    → applied_at 标记
                                    → 下次 LLM 调用自动注入 Active Rules
                                    → Agent 自动遵守规则
```

相比 v3.0 的改进：
- **元认知头部**：告诉 Agent 置信度分级和如何使用记忆
- **记忆压缩**：output-first，不再显示 raw command
- **经济统计**：显示当前会话的 token 节省比例

合并到 `output.system[0]`（非 push 新条目），兼容只接受单条 system message 的 vLLM/Qwen 后端。

---

## 5. 跨平台集成

所有平台共享同一个 PostgreSQL 数据库，通过 MCP 协议通信。

| 平台 | 配置文件 | 参考模板 |
|------|----------|----------|
| **OpenCode** | `opencode.jsonc` plugin + MCP | 内置 |
| **Claude Code** | `CLAUDE.md` 或 `~/.claude/settings.json` | `platform-templates/claude-code-mcp.md` |
| **Cursor** | `.cursor/mcp.json` | `platform-templates/cursor-mcp.json` |
| **Windsurf** | `.windsurf/mcp.json` | `platform-templates/windsurf-mcp.json` |
| **Continue.dev** | `~/.continue/config.json` | `platform-templates/continue-config.json` |

MCP 服务器支持两种模式：

```bash
# stdio（内嵌，默认）
node dist/mcp-server.js

# SSE（独立进程，所有平台可连）
node dist/mcp-server.js --transport sse --port 37777
```

---

## 6. Token 经济

系统自动追踪记忆的 Token 成本和节省：

| 指标 | 说明 |
|------|------|
| `read_tokens` | 读取记忆消耗的 Token |
| `discovery_tokens` | 如果不存记忆需要重新探索的 Token |
| `savings_estimate` | 节省的 Token 数 |
| `avg_importance` | 记忆平均质量分 (1-5) |

### 自动清理

低价值 observation（importance ≤ 2、无内容、无 embedding）会在 7 天后自动删除。

---

## 7. 运维与监控

### PostgreSQL 维护

```sql
-- 查看向量索引状态
SELECT * FROM pg_indexes WHERE tablename = 'observations';

-- 统计记忆数量
SELECT platform_source, COUNT(*) FROM observations GROUP BY 1;

-- 查看 Token 经济
SELECT * FROM token_economics ORDER BY calculated_at DESC LIMIT 10;
```

### 日志

日志输出到 stderr，格式：

```
[PG Memory] [INFO] [system-transform-injector] Injected 320 tokens of memory context
[PG Memory] [WARN] [session-summary-writer] No session_map entry for xxx
[PG Memory] [ERROR] [env-manager] Failed to read .env file
```

日志级别通过 `PG_MEMORY_LOG_LEVEL` 控制：`debug | info | warn | error`。

---

## 8. 故障排查

| 现象 | 原因 | 解决 |
|------|------|------|
| `ECONNREFUSED` | PostgreSQL 未运行 | `pg_isready` 检查 |
| `relation "observations" does not exist` | 数据库未初始化 | 插件首次启动自动建表（init-db.ts 内置迁移） |
| `Model not found: xxx` | Provider API key 未配置 | 检查 `~/.opencode-pg-memory/.env` |
| 无记忆注入 | `experimental.chat.system.transform` 未注册 | 确认 `opencode.jsonc` plugin 列表包含 `opcode-pg-memory` |
| `output.system[0]` 为空 | 配置层未读取到数据 | 检查 `PG_MEMORY_LOG_LEVEL=debug` 查看详细日志 |
