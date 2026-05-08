# opcode-pg-memory v3.0 使用指南

> 更新至 v3.0 | strict:true | 4 层配置合并 | 两路召回注入 | 跨平台 MCP

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
psql -U opencode -d PGOMO -f script/migration-v2.sql
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

### import_document — 文档导入

| 参数 | 类型 | 说明 |
|------|------|------|
| `source` | string | 文档唯一标识 |
| `content` | string | 文档内容（纯文本） |
| `chunk_size` | number | 分块大小，默认 1500 |

---

## 4. 注入引擎

v3.0 核心功能：每次 LLM 调用前，通过 `experimental.chat.system.transform` 自动注入相关记忆。

### 两路召回

```
路径 A (关键词): 当前项目的高重要性 observation
路径 B (语义):   pgvector ANN，以 system prompt 为 query

合并 → 混合排序 → 去重 → TokenBudget → 注入 system[0]
```

### 注入格式

```xml
<pg_memory>
project: my-project

<session_context>
request: Fix database connection pool
learned: Connection pool size should be based on max connections
</session_context>

<relevant_memories>
- [OBSERVATION] (85%) [bash]: input: psql -c "SHOW max_connections"
- [REFLECTION] (72%) pattern: connection-pool-tuning: Increase pool...
</relevant_memories>
</pg_memory>
```

记忆被合并到 `output.system[0]`（非 push 新条目），兼容只接受单条 system message 的 vLLM/Qwen 后端。

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
| `relation "observations" does not exist` | 数据库未初始化 | 插件首次启动自动建表，或手动运行 `script/migration-v2.sql` |
| `Model not found: xxx` | Provider API key 未配置 | 检查 `~/.opencode-pg-memory/.env` |
| 无记忆注入 | `experimental.chat.system.transform` 未注册 | 确认 `opencode.jsonc` plugin 列表包含 `opcode-pg-memory` |
| `output.system[0]` 为空 | 配置层未读取到数据 | 检查 `PG_MEMORY_LOG_LEVEL=debug` 查看详细日志 |
