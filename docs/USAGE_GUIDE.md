# opcode-pg-memory v2.5.0 使用指南

> ⚠️ 本文档已从 v2.2 更新至 v2.5.0
> 主要变更：Zod 配置层、错误分类系统、注册表模式派发、import_document 工具

## 目录

1. [安装](#1-安装)
2. [配置](#2-配置)
3. [MCP 工具](#3-mcp-工具)
4. [话题段系统](#4-话题段系统)
5. [新功能（v2.2）](#5-新功能)
6. [运维与监控](#6-运维与监控)
7. [故障排查](#7-故障排查)

---

## 1. 安装

### 方式一：bunx（推荐）

```bash
bunx opcode-pg-memory install
```

自动完成：注册插件到 `opencode.jsonc` + 创建 `/pg-memory-init` 命令。

### 方式二：GitHub

```bash
git clone https://github.com/Vbs313/opcode-pg-memory.git
cd opcode-pg-memory
cp .env.example .env && notepad .env
.\scripts\setup.ps1
```

### 前置条件

| 组件 | 要求 |
|------|------|
| PostgreSQL | 16+（需 pgvector） |
| Bun | 1.0+ |
| Ollama | `qwen3-embedding:0.6b`（或 DeepSeek/OpenAI API） |

### 注册 MCP

`~/.config/opencode/opencode.jsonc`：

```jsonc
{
  "mcp": {
    "pg-memory": {
      "type": "local",
      "command": ["bun", "path/to/opcode-pg-memory/dist/mcp-server.js"],
      "enabled": true,
      "environment": {
        "PG_HOST": "localhost", "PG_PORT": "5432",
        "PG_DATABASE": "PGOMO", "PG_USER": "opencode",
        "PG_PASSWORD": "你的密码",
        "EMBEDDING_PROVIDER": "ollama",
        "EMBEDDING_MODEL": "qwen3-embedding:0.6b",
        "EMBEDDING_DIMENSIONS": "1024"
      }
    }
  }
}
```

验证：`opencode --print-logs --log-level INFO | findstr "PG Memory"` → `Plugin initialized successfully`

---

## 2. 配置

### 配置优先级

```
MCP environment > ~/.config/opencode/pg-memory.jsonc > 默认值
```

### 配置文件（可选）

创建 `~/.config/opencode/pg-memory.jsonc`：

```jsonc
{
  // 检索阈值 (0-1，越高越严格)
  "similarityThreshold": 0.7,

  // 每次注入的最大记忆数
  "maxMemories": 15,

  // 日志级别: debug | info | warn | error
  "logLevel": "info",

  // 上下文压缩阈值 (0-1)
  "compactionThreshold": 0.85
}
```

### 环境变量

```bash
PG_MEMORY_LOG_LEVEL=info     # 日志级别（覆盖配置文件）
PG_HOST=localhost             # PostgreSQL 主机
PG_PORT=5432
PG_DATABASE=PGOMO
PG_USER=opencode
PG_PASSWORD=123456
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=qwen3-embedding:0.6b
EMBEDDING_DIMENSIONS=1024    # 必须与模型一致！
```

### 嵌入模型

| Provider | 模型 | 维度 | 备注 |
|----------|------|------|------|
| `ollama` | `qwen3-embedding:0.6b` | **1024** | 本地免费 |
| `deepseek` | `text-embedding-v2` | **1536** | API Key |
| `openai` | `text-embedding-3-small` | **1536** | API Key |

---

## 3. MCP 工具

### recall_memory — 记忆检索

| 参数 | 类型 | 说明 |
|------|------|------|
| `query` | string ✅ | 查询文本 |
| `caller_context` | object | `{type, current_goal, current_session_id}` — 启用话题融合 |
| `topic_segment_id` | string | 限定话题段 |
| `retrieval_strategies` | string[] | `semantic`/`bm25`/`graph`/`keyword`/`temporal` |
| `max_results` | number | 默认 10 |
| `filters` | object | `{min_confidence, tier, entity_types, exclude_topic_segment_ids, time_range_days}` |

```json
// Agent 自主调用
recall_memory({
  "query": "数据库连接池配置",
  "caller_context": { "type": "omo_agent", "current_goal": "性能调优" },
  "retrieval_strategies": ["semantic", "graph"],
  "filters": { "tier": "project", "time_range_days": 90 }
})
```

### hindsight_reflect — 反思

| 参数 | 类型 | 说明 |
|------|------|------|
| `session_id` / `omo_task_id` / `topic_segment_id` | string ① | 三选一 |
| `aggregate` | boolean | `true`=合并所有段反思 |
| `model_size` | string | `7b`/`14b`/`full` |
| `observation_threshold` | number | 触发阈值（默认 30） |

```json
hindsight_reflect({ "session_id": "ses_abc" })
hindsight_reflect({ "omo_task_id": "task_123", "aggregate": true })
```

---

## 4. 话题段系统

插件自动检测会话内话题切换，隔离不同话题的实体和观察。

```
会话 ses_abc:
├── 段 #1 "Docker 网络" (15 条) → 实体: iptables, docker0
├── 段 #2 "CSS Grid"   (8 条)  → 实体: .container, grid
└── 段 #3 "服务器部署"  (12 条) → 反思: "systemd service 需 After=network.target"
```

算法：滑动窗口（3 条消息）+ 余弦相似度（阈值 0.3）。短消息（< 10 字符）跳过。

---

## 5. 新功能（v2.2）

### 5.1 首条消息记忆注入

每个新会话的首条消息自动注入历史记忆块：

```
[PG MEMORY]
Relevant context from previous sessions:
- [ENTITY] buildCommand (permanent): npm run build (95%)
- [OBSERVATION] Build takes ~45s with 8GB RAM (project)
- [REFLECTION] Test before build to catch errors early (confidence: 0.85)
```

### 5.2 关键词检测

当用户消息包含 "remember this"、"save this"、"don't forget" 等关键词时，自动提示保存记忆。

### 5.3 隐私过滤

工具输入输出中的 `<private>...</private>` 标记自动替换为 `[REDACTED]`。

### 5.4 Compaction Toast

上下文压缩时自动显示 TUI 通知。

### 5.5 配置集中化

`~/.config/opencode/pg-memory.jsonc` 集中管理所有配置，支持 JSONC 注释。

---

## 6. 运维与监控

```sql
-- 会话统计
SELECT sm.opencode_session_id,
  COUNT(ts.id) AS segments,
  SUM(ts.observation_count) AS total_obs
FROM session_map sm
LEFT JOIN topic_segments ts ON ts.session_map_id = sm.id
GROUP BY sm.opencode_session_id
ORDER BY total_obs DESC LIMIT 20;

-- 实体分布
SELECT tier, COUNT(*), ROUND(AVG(weight), 2) FROM entities GROUP BY tier;

-- 缓存命中率
SELECT COUNT(*) FILTER (WHERE hit_count > 1) AS hits, COUNT(*) AS total
FROM semantic_cache WHERE is_pruned = FALSE;

-- 最近反思
SELECT summary, confidence, pattern_type, created_at
FROM reflections ORDER BY created_at DESC LIMIT 10;

-- 数据库维护
VACUUM ANALYZE entities;
VACUUM ANALYZE observations;
VACUUM ANALYZE semantic_cache;
```

---

## 7. 故障排查

| 问题 | 诊断 |
|------|------|
| 新会话未入库 | `opencode --print-logs --log-level DEBUG \| findstr "PG Memory"` |
| 嵌入失败 | `ollama list`；`ollama run qwen3-embedding:0.6b "test"` |
| PG 连接失败 | `psql -h localhost -U opencode -d PGOMO -c "SELECT 1"` |
| 话题段未创建 | 单话题会话只有 1 段；`SELECT * FROM topic_segments` |
| 日志不输出 | `PG_MEMORY_LOG_LEVEL=debug opencode ...` |

---

**版本**: 2.2.0 | **更新**: 2026-05-06 | [GitHub](https://github.com/Vbs313/opcode-pg-memory)
