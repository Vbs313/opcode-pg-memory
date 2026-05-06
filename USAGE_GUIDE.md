# opcode-pg-memory v2.0.0 使用指南

> 面向 OpenCode + Oh My OpenAgent 的生产级长期记忆系统

## 目录

1. [快速上手](#1-快速上手)
2. [配置详解](#2-配置详解)
3. [MCP 工具](#3-mcp-工具)
4. [话题段系统](#4-话题段系统)
5. [OmO Agent 集成](#5-omo-agent-集成)
6. [记忆生命周期](#6-记忆生命周期)
7. [运维与监控](#7-运维与监控)
8. [故障排查](#8-故障排查)
9. [最佳实践](#9-最佳实践)

---

## 1. 快速上手

### 1.1 前置条件

| 组件 | 要求 | 说明 |
|------|------|------|
| PostgreSQL | 16+ | 必须安装 pgvector 扩展 |
| OpenCode | 最新版 | 支持 Plugin API |
| Ollama | 可选 | 本地嵌入模型（推荐 `qwen3-embedding:0.6b`，需先 `ollama pull`） |
| Bun | 1.0+ | 构建插件 |

```powershell
# 安装嵌入模型（使用 Ollama 时需先拉取）
ollama pull qwen3-embedding:0.6b
```

### 1.2 安装

```powershell
# 1. 进入插件目录
cd <plugin-dir>   # 例如：~/.config/opencode/plugins/opcode-pg-memory

# 2. 复制并编辑配置
cp .env.example .env
notepad .env       # 修改 PG_PASSWORD 等

# 3. 一键安装（检查依赖、安装包、构建、数据库迁移）
.\scripts\setup.ps1
```

### 1.3 注册到 OpenCode

在 OpenCode 配置文件（`~/.config/opencode/opencode.jsonc`）中添加 MCP 配置：

```jsonc
{
  "mcp": {
    "pg-memory": {
      "type": "local",
      "command": ["bun", "<plugin-dir>/dist/mcp-server.js"],
      "enabled": true,
      "environment": {
        "PG_HOST": "localhost",
        "PG_PORT": "5432",
        "PG_DATABASE": "PGOMO",
        "PG_USER": "opencode",
        "PG_PASSWORD": "你的密码",
        "EMBEDDING_PROVIDER": "ollama",
        "EMBEDDING_MODEL": "qwen3-embedding:0.6b",
        "EMBEDDING_DIMENSIONS": "1024"
      }
    }
  }
}
```

> **配置优先级**：OpenCode MCP `environment` 字段是运行时配置的**唯一来源**。插件目录下的 `.env` 仅用于 `setup.ps1` 脚本。

### 1.4 验证

```powershell
# 检查数据库连接
$env:PGPASSWORD='你的密码'; psql -h localhost -U opencode -d PGOMO -c "SELECT COUNT(*) FROM session_map;"

# 检查插件日志（OpenCode 启动后）
opencode --print-logs --log-level INFO | findstr "PG Memory"
```

---

## 2. 配置详解

### 2.1 嵌入模型

| Provider | 模型 | 维度 | 说明 |
|----------|------|------|------|
| `ollama` | `qwen3-embedding:0.6b` | **1024** | 本地免费 |
| `deepseek` | `text-embedding-v2` | **1536** | 需 API Key |
| `openai` | `text-embedding-3-small` | **1536** | 需 API Key |

> `EMBEDDING_DIMENSIONS` 必须与所选模型的实际输出维度一致，否则向量检索会失败。

### 2.2 环境变量

```bash
# === PostgreSQL ===
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=PGOMO
PG_USER=opencode
PG_PASSWORD=123456

# === 嵌入模型 ===
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=qwen3-embedding:0.6b
EMBEDDING_DIMENSIONS=1024
EMBEDDING_BATCH_SIZE=10

# === OmO 集成（可选）===
OMO_ENABLED=true
```

### 2.3 插件运行时参数

以下参数在 `src/index.ts` 的 `DEFAULT_PLUGIN_CONFIG` 中定义，修改后需重新构建：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `cache.initialThreshold` | `0.92` | 语义缓存初始相似度阈值 |
| `cache.adjustmentStep` | `0.02` | 阈值自动调整步长 |
| `reflection.segmentThreshold` | `5` | 每个话题段触发反思的最低观察数 |
| `reflection.offPeakHours` | `[1,2,3,4,5]` | 低峰期小时（**UTC**，即北京时间 9:00-13:00） |
| `tokenBudget.contextLimitRatio` | `0.05` | Context 窗口 5% 用于记忆注入 |
| `retrieval.weights` | `{s:0.5, r:0.3, i:0.2}` | 检索排序（语义/时效/重要性） |
| `topic.mutationThreshold` | `0.3` | 话题突变阈值（越低越敏感） |
| `topic.windowSize` | `3` | 滑动检测窗口大小 |

---

## 3. MCP 工具

### 3.1 recall_memory

从长期记忆中检索相关实体、观察和反思。支持多策略并行检索 + 话题上下文融合。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | `string` | ✅ | 自然语言查询 |
| `caller_context` | `object` | ❌ | `{type, current_goal, current_session_id}` — 提供时启用话题融合 |
| `session_id` | `string` | ❌ | 限定会话 |
| `topic_segment_id` | `string` | ❌ | 限定话题段 |
| `retrieval_strategies` | `string[]` | ❌ | `semantic`/`bm25`/`graph`/`keyword`/`temporal` |
| `max_results` | `number` | ❌ | 默认 10，最大 50 |
| `filters` | `object` | ❌ | `{min_confidence, min_importance, tier, entity_types, exclude_topic_segment_ids, time_range_days}` |

#### 示例

```json
// 基础检索
recall_memory({ "query": "如何优化数据库查询？" })

// Agent 自主调用
recall_memory({
  "query": "数据库连接池配置",
  "caller_context": { "type": "omo_agent", "current_goal": "性能调优", "current_session_id": "ses_abc" },
  "retrieval_strategies": ["semantic", "graph"],
  "filters": { "tier": "project", "time_range_days": 90 }
})
```

#### 返回

```json
{
  "success": true,
  "query": "数据库连接池配置",
  "context_used": { "topic_segment_id": "<uuid>", "topic_summary": "PG connection pooling" },
  "results": [{
    "type": "observation",
    "content": "pool.max = 20",
    "relevance_score": 0.87,
    "context": { "session_id": "ses_abc", "topic_summary": "PG connection pooling", "timestamp": "..." }
  }],
  "total_found": 5,
  "retrieval_time_ms": 45
}
```

---

### 3.2 hindsight_reflect

对会话/任务/话题段的观察进行反思，归纳经验模式。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `session_id` | `string` | ① | OpenCode 会话 ID |
| `omo_task_id` | `string` | ① | OmO 任务 ID（跨会话） |
| `topic_segment_id` | `string` | ① | 话题段 ID（优先级最高） |
| `trigger_type` | `string` | ❌ | `manual`（默认）/`threshold`/`scheduled` |
| `model_size` | `string` | ❌ | `7b`（默认）/`14b`/`full` |
| `aggregate` | `boolean` | ❌ | `false`=每个段单独反思，`true`=合并所有段 |
| `observation_threshold` | `number` | ❌ | 触发反思的最低观察数（默认 30） |

> ① 三选一即可。优先级：`topic_segment_id` > `omo_task_id` > `session_id`。

#### 示例

```json
// 反思会话（按话题段分别反思）
hindsight_reflect({ "session_id": "ses_abc" })

// 反思 OmO 任务（跨会话聚合）
hindsight_reflect({ "omo_task_id": "task_123", "aggregate": true })

// 反思特定话题段
hindsight_reflect({ "topic_segment_id": "<uuid>" })
```

#### 返回

```json
{
  "generated_reflections": [{
    "id": "<uuid>",
    "summary": "频繁遇到权限错误，通过 GRANT ALL ON SCHEMA public 解决",
    "confidence": 0.85,
    "pattern_type": "error_pattern"
  }],
  "token_usage": { "input": 1250, "output": 350, "total": 1600 },
  "duration_ms": 2340
}
```

---

## 4. 话题段系统

### 4.1 概念

话题段（Topic Segment）是会话内部的主题隔离单元。插件自动检测同一会话内的话题切换，将不同话题的实体/观察/反思隔离到独立段中，防止跨话题污染。

```
会话 ses_abc:
├── 段 #1 "Docker 网络调试" (15 条观察)
│   ├── 实体: iptables, docker0
│   └── 反思: "iptables 规则冲突是常见原因"
├── 段 #2 "CSS Grid 布局" (8 条观察)
│   └── 实体: .container, grid-template
└── 段 #3 "服务器部署" (12 条观察)
    └── 反思: "systemd service 需 After=network.target"
```

### 4.2 边界检测

```
滑动窗口（3 条消息）+ 余弦相似度（阈值 0.3）：
1. 消息 → 嵌入向量
2. 窗口内向量与当前段摘要计算平均余弦相似度
3. < 0.3 → 话题突变 → 关闭当前段 → 创建新段
4. 短消息（< 10 字符）跳过检测
```

### 4.3 监控

```sql
-- 查看某会话的话题段
SELECT ts.segment_index, ts.summary, ts.observation_count
FROM topic_segments ts
JOIN session_map sm ON ts.session_map_id = sm.id
WHERE sm.opencode_session_id = 'ses_abc'
ORDER BY ts.segment_index;
```

---

## 5. OmO Agent 集成

### 5.1 系统提示词注入

```markdown
## 长期记忆工具

### recall_memory — 检索历史记忆
处理新任务前调用：
- query: 当前任务目标
- caller_context: { type: "omo_agent", current_goal: "<目标>" }

### hindsight_reflect — 总结任务经验
完成任务后调用：
- omo_task_id: "<任务ID>"
- aggregate: true
```

### 5.2 自主调用流程

```
Agent 收到任务
    ├→ recall_memory(query=任务目标) → 获取历史经验
    ├→ 执行任务（产生实体和观察）
    └→ hindsight_reflect(omo_task_id=任务ID) → 归纳模式
```

---

## 6. 记忆生命周期

### 6.1 Tier 策略

| Tier | 共享范围 | 示例 |
|------|---------|------|
| `session` | 当前会话 | 临时调试信息 |
| `project` | 同一项目 | 架构决策 |
| `permanent` | 所有会话 | 编程范式 |

### 6.2 知识归档

```sql
-- 高价值实体升级
UPDATE entities SET tier = 'project'
WHERE weight >= 8.0 AND tier = 'session' AND confidence >= 0.8;

UPDATE entities SET tier = 'permanent'
WHERE weight >= 9.0 AND tier = 'project';
```

### 6.3 缓存淘汰

```sql
DELETE FROM semantic_cache
WHERE hit_count < 3 AND created_at < NOW() - INTERVAL '30 days';
```

---

## 7. 运维与监控

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

-- Token 趋势
SELECT DATE(created_at), SUM(tokens_used)
FROM token_usage_log WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY 1 ORDER BY 1;

-- 缓存状态
SELECT COUNT(*) FILTER (WHERE hit_count > 1) AS hits, COUNT(*) AS total
FROM semantic_cache WHERE is_pruned = FALSE;
```

---

## 8. 故障排查

| 问题 | 诊断 |
|------|------|
| 新会话未入库 | `opencode --print-logs --log-level DEBUG \| findstr "PG Memory"` |
| 嵌入失败 | `ollama list`；`ollama run qwen3-embedding:0.6b "test"` |
| PG 连接失败 | `Get-Service postgresql*`；`psql -h localhost -U opencode -d PGOMO -c "SELECT 1"` |
| 话题段未创建 | 单话题会话只有 1 段；`SELECT * FROM topic_segments` |
| 缓存命中低 | `SELECT * FROM cache_threshold_log ORDER BY created_at DESC LIMIT 3` |

---

## 9. 最佳实践

1. **层级策略**：架构决策用 `project` tier，调试用 `session`（默认），通用知识升级到 `permanent`
2. **定期反思**：重要任务完成后主动调用 `hindsight_reflect`
3. **话题隔离**：检索时用 `exclude_topic_segment_ids` 排除无关话题
4. **分治**：OpenCode 管理会话生命周期（SQLite），插件做语义检索增强（PG + pgvector）

---

**文档版本**: 2.0.0 | **更新**: 2026-05-06
