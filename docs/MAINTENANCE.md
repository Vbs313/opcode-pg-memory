# opcode-pg-memory 维护手册

> 本手册列出所有可调参数、阈值和配置项，便于后续调试和调优。
> 代码版本：v3.9+

---

## 目录

1. [环境变量（快速调参）](#1-环境变量快速调参)
2. [hindsight_reflect 参数](#2-hindsight_reflect-参数)
3. [记忆注入参数](#3-记忆注入参数)
4. [短时记忆参数](#4-短时记忆参数)
5. [内存缓冲队列参数](#5-内存缓冲队列参数)
6. [异步嵌入生成参数](#6-异步嵌入生成参数)
7. [语义缓存参数](#7-语义缓存参数)
8. [数据库轮询参数](#8-数据库轮询参数)
9. [输出压缩参数](#9-输出压缩参数)
10. [Schema 参数](#10-schema-参数)
11. [性能基准](#11-性能基准)
12. [故障排查](#12-故障排查)

---

## 1. 环境变量（快速调参）

配置文件：`~/.opencode-pg-memory/.env`（自动加载）

### 数据库连接

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PG_HOST` | `localhost` | PostgreSQL 主机 |
| `PG_PORT` | `5432` | 端口 |
| `PG_DATABASE` | `opencode_memory` | 数据库名 |
| `PG_USER` | `opencode` | 用户 |
| `PG_PASSWORD` | `(空)` | 密码 |

### 嵌入模型

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EMBEDDING_PROVIDER` | `ollama` | 可选 `ollama` / `openai` / `deepseek` |
| `EMBEDDING_MODEL` | `qwen3-embedding:0.6b` | 模型名称 |
| `EMBEDDING_DIMENSIONS` | `1024` | 向量维度（需对齐模型） |
| `EMBEDDING_BATCH_SIZE` | `10` | 批处理大小 |

### 同步配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PG_MEMORY_SYNC_MODE` | `hybrid` | `event-only` / `poll-only` / `hybrid` |
| `PG_MEMORY_POLL_INTERVAL` | `5000` | 轮询间隔（ms） |
| `PG_MEMORY_DB_POLLING` | `true` | 设为 `false` 禁用轮询 |

### 嵌入后台任务

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PG_MEMORY_EMBED_COOLDOWN` | `300000` | 嵌入冷却时间（ms，默认 5 分钟） |
| `PG_MEMORY_EMBED_MIN_IMPORTANCE` | `3` | 最低 importance 才触发嵌入 |

### 特性开关

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OMO_ENABLED` | `(空)` | 设为 `true` 启用 OmO schema 扩展 |
| `PLATFORM` | `opencode` | 平台标识，写入 observations 的 `platform_source` |
| `LOG_LEVEL` | `info` | 日志级别：`debug` / `info` / `warn` / `error` |
| `PG_MEMORY_OUTPUT_MAX_CHARS` | `10000` | 输出压缩器 Stage 3 硬截断长度。建议与 oh-my-openagent 的 `truncate_all_tool_outputs` 对齐 |

### 输出压缩与 oh-my-openagent 的关系

`compressOutput` 在 `tool.execute.after` 钩子中运行，**优先于** oh-my-openagent 的 `truncate_all_tool_outputs`。
即：opcode-pg-memory 压缩**原始输出**，oh-my-openagent 再对已压缩的输出做二次截断（通常为空操作）。

| 场景 | compressOutput | oh-my-openagent truncation | 影响 |
|------|---------------|---------------------------|------|
| 大输出 (git diff 80KB) | raw→~2KB (filter 生效) | 2KB → 不变 | ✅ 压缩优先，truncation 空操作 |
| 中输出 (npm install 30KB) | raw→~1KB (filter 生效) | 1KB → 不变 | ✅ 同上 |
| 小输出 (< 500 chars) | 返回 null (不变) | 原始→可能截断 | ⚠️ 数据量小，截断无害 |

---

## 2. hindsight_reflect 参数

源文件：`src/mcp/hindsight-reflect.ts`（`DEFAULT_CONFIG`，第 145-160 行）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `observationThreshold` | `30` | 触发反思的最少观察数 |
| `segmentThreshold` | `10` | 触发反思的最少分段数 |
| `minThreshold` | `30` | 最低观察数硬下限 |
| `maxThreshold` | `50` | 单次处理观察数硬上限 |
| `modelSize` | `"7b"` | 启发式模式（当前不用 LLM） |
| `offPeakHours` | `[1,2,3,4,5]` | 低峰时段（UTC 小时） |
| `minConfidence` | `0.6` | 低于此置信度的 pattern 不存储 |
| `maxObservationsPerSegment` | `100` | 每个分段最多处理多少条观察 |
| `maxObservationsAggregate` | `200` | 聚合模式最多处理多少条观察 |
| `reflectionBatchSize` | `10` | 每批 LLM 处理多少条观察 |

### Pattern 类型与置信度

| 类型 | 置信度 | 条件 | 说明 |
|------|--------|------|------|
| `session_overview` | `0.9` | 总是生成 | 观察数 / 工具数 / 用户消息数 |
| `error_pattern` | `0.75` | errorObs >= 1 | 检测到错误/异常/失败 |
| `tool_preference` | `0.5 + count*0.05` (max 0.95) | 工具使用 >= 5 | 高频工具识别 |
| `workflow` | `0.5 + count*0.05` | 工具使用 >= 3 | 中频工具 (3-4 次) |
| `success_pattern` | `0.7` | successObs >= 3 | 连续成功模式 |
| `technical_stack` | `0.85` | 检测到语言/框架 | 技术栈识别 |

### Action Plan 生成规则

v3.9+ 新增。pattern 附带结构化 trigger/action：

- **error_pattern**: trigger = 输出含 "error"/"exception"/"failed" 的工具；action = "重试并捕获完整日志"
- **workflow/tool_preference**: trigger = 高频工具；action = "考虑规划以减少上下文切换"
- **session_overview / success_pattern / technical_stack**: 无 action_plan

---

## 3. 记忆注入参数

源文件：`src/injection/system-transform-injector.ts`（`DEFAULT_INJECTION_CONFIG`，第 113-121 行）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxTokens` | `2000` | 注入块最大 token 数 |
| `minScore` | `0.3` | 低于此分数的记忆不注入 |
| `keywordLimit` | `20` | 关键词召回上限 |
| `semanticLimit` | `20` | 语义召回上限 |
| `dedupPrefixLength` | `100` | 去重匹配前缀长度（字符） |
| `weights.semantic` | `0.5` | 语义相似度权重 |
| `weights.importance` | `0.3` | 重要性权重 |
| `weights.recency` | `0.2` | 新鲜度权重 |
| `recencyHalfLifeDays` | `2` | 新鲜度半衰期（天） |

评分公式：

```
score = semantic × 0.5 + (importance ÷ 5) × 0.3 + recency_boost × 0.2
```

### Active Rules 参数

源文件：`src/mcp/apply-reflection.ts` + `src/injection/system-transform-injector.ts`

| 参数 | 值 | 说明 |
|------|-----|------|
| `fetchActiveRules 上限` | `5` | 每次注入读取已应用规则数 |
| `minConfidence` | `0.6` | reflection 最低置信度（继承） |
| `applied_at 标记` | 成功后 `NOW()` | 防重复应用 |

---

## 4. 短时记忆参数

源文件：`src/services/short-term-memory.ts`

| 参数 | 值 | 说明 |
|------|-----|------|
| `MAX_OBSERVATIONS_PER_SESSION` | `50` | 每个会话缓存的观察上限 |
| `TTL_MS` | `1_800_000` | 过期时间（30 分钟） |
| 清理间隔 | `60_000` | 每 60 秒清理过期条目 |

短时记忆在内存中，不写入 PG。超出上限时删除最旧条目。

---

## 5. 内存缓冲队列参数

源文件：`src/services/memory-buffer.ts`

| 参数 | 值 | 说明 |
|------|-----|------|
| `MAX_RETRIES` | `10` | 最大重试次数 |
| `RETRY_INTERVAL_MS` | `30_000` | 重试间隔（30 秒） |
| `BUFFER_TIMEOUT_MS` | `300_000` | 超时丢弃（5 分钟） |

缓冲队列在内存中，用于 tool.execute.after 的异步写入。
指数退避：第 N 次重试间隔 = `RETRY_INTERVAL_MS × 2^(N-1)`（上限 5 分钟）。

---

## 6. 异步嵌入生成参数

源文件：`src/services/async-embedder.ts`

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `cooldownMs` | `300_000` | 两次嵌入之间的冷却时间（可由 `PG_MEMORY_EMBED_COOLDOWN` 覆盖） |
| `minImportance` | `3` | 只对 importance >= 此值的观测生成嵌入（可由 `PG_MEMORY_EMBED_MIN_IMPORTANCE` 覆盖） |

嵌入生成在后台进程中进行，不阻塞主流程。

---

## 7. 语义缓存参数

源文件：`src/cache/semantic-cache.ts`，配置默认值在 `src/index.ts` (`DEFAULT_PLUGIN_CONFIG.cache`)

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `initialThreshold` | `0.92` | 初始匹配阈值 |
| `adjustmentStep` | `0.02` | 自适应调整步长 |
| `minThreshold` | `0.85` | 阈值下限 |
| `maxThreshold` | `0.97` | 阈值上限 |
| `enabled` | `true` | 设为 `false` 禁用缓存 |

---

## 8. 数据库轮询参数

源文件：`src/services/db-polling.ts`，配置在 `src/index.ts` (第 285-293 行)

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `intervalMs` | `5000` | 轮询间隔（ms） |
| `backoffBaseMs` | `1000` | 退避基数（ms） |
| `backoffMaxMs` | `60000` | 退避上限（ms） |

轮询模式用于 `poll-only` 或 `hybrid` 同步模式。

---

## 9. 输出压缩参数

源文件：`src/services/output-compressor.ts`

| 命令 | 策略 | 说明 |
|------|------|------|
| `npm` / `pnpm` / `yarn` | 提取关键行 + versions | install/outdated/audit 精简 |
| `ls` / `Get-ChildItem` / `dir` | tail -20 | 只保留最后 20 行 |
| `grep` / `Select-String` / `findstr` | head -30 + match count | 保留前 30 行 + 匹配数 |
| `find` / `Get-ChildItem -Recurse` | 按类型分组计数 | 不展示原始列表 |
| `cat` / `type` | head -80 + line count | 只保留前 80 行 |
| `git status` | 只保留 modified/untracked | 精简状态输出 |
| `git diff` | 统计 + head -80 | 总改动行数 + 前 80 行 |
| `git log` | head -15 | 只保留前 15 条 |
| `cargo build` / `check` | 提取 errors/warnings | 保留关键编译信息 |
| `psql` / SQL | 精简行宽 | 防止单行过长 |
| 重复读取检测 | 3 分钟内同文件 → 跳过 | 减少重复信息 |

---

## 10. Schema 参数

### 表结构

| 表 | 核心列 | 用途 |
|----|--------|------|
| `session_map` | 12 列 | 会话→项目映射 |
| `topic_segments` | 11 列 | 话题分段 |
| `observations` | 17 列 | 工具调用/消息记录 |
| `reflections` | 13 列 | 反思模式 |
| `entities` | 13 列 | 知识图谱节点 |
| `relations` | 7 列 | 实体关系 |
| `session_summaries` | 4 列 | 会话摘要 |
| `semantic_cache` | 11 列 | 语义缓存 |
| `reflection_errors` | 5 列 | 反思错误日志 |

详细定义见 `src/db/init-db.ts`。

### v3.9 新增列

| 表 | 列 | 类型 | 默认值 |
|----|-----|------|--------|
| `observations` | `tier` | `VARCHAR(10)` | `'hot'` (可设 hot/warm/cold) |
| `reflections` | `action_plan` | `JSONB` | `NULL` |
| `reflections` | `applied_at` | `TIMESTAMPTZ` | `NULL` |

### 存储层级定义

- **hot**: created_at < 90 天，高检索优先级
- **warm**: created_at 90-365 天，中等检索优先级
- **cold**: created_at > 365 天，低检索优先级（需显式查询）

暂未实现自动 tier 迁移脚本，需手动执行：

```sql
-- 标记 90 天前的观察为 warm
UPDATE observations SET tier = 'warm'
WHERE tier = 'hot' AND created_at < NOW() - INTERVAL '90 days';

-- 标记 365 天前的观察为 cold  
UPDATE observations SET tier = 'cold'
WHERE tier IN ('hot', 'warm') AND created_at < NOW() - INTERVAL '365 days';
```

### 向量索引

| 表 | 索引类型 | 参数 |
|----|----------|------|
| observations | HNSW (vector_cosine_ops) | m=16, ef_construction=64 |
| reflections | HNSW (vector_cosine_ops) | m=16, ef_construction=64 |
| entities | HNSW (vector_cosine_ops) | m=16, ef_construction=64 |
| semantic_cache | HNSW (vector_cosine_ops) | m=16, ef_construction=64 |
| topic_segments | HNSW (vector_cosine_ops) | m=16, ef_construction=64 |

---

## 11. 性能基准

以下数据基于用户环境（9,923 observations, 299 sessions, Windows, localhost PostgreSQL）：

| 操作 | 耗时 | 说明 |
|------|------|------|
| `hindsight_reflect`（200 obs） | ~120-140 ms | 纯启发式，无需 LLM |
| `recall_memory`（关键词路径） | ~50-100 ms | 走 btree 索引 |
| `recall_memory`（语义路径） | ~100-500 ms | HNSW + 超时降级 |
| 记忆注入（13 条） | ~200-300 ms | 两路召回 + 去重 + 格式化 |
| 单次 `tool.execute.after` | < 5 ms | 纯内存操作 + 缓冲队列 |
| PG 查询延迟 | < 1 ms | localhost Unix socket |
| `npm install` | ~60s | 依赖安装时间 |

### 瓶颈分析

- **PG 连接池大小**: 默认未显式配置，使用 `pg.Pool` 默认值（10）
- **PG 内存**: ~10K observations 约 50MB
- **短时记忆内存**: ~50 条 × ~1KB = ~50KB
- **内存缓冲队列**: < 50 条，< 100KB

---

## 12. 故障排查

### 常见错误

| 错误 | 原因 | 解决方案 |
|------|------|----------|
| `relation "observations" does not exist` | 数据库未初始化 | 重启 OpenCode 自动建表 |
| `42703: column "action_plan" does not exist` | Schema 未迁移 | 运行 `ALTER TABLE reflections ADD COLUMN action_plan JSONB` |
| `ECONNREFUSED` | PostgreSQL 未运行 | `pg_isready` 检查 |
| `apply_reflection` 返回 "No actionable plan" | 该 pattern 无 trigger/action | 用 `hindsight_reflect` 重新生成 |
| `apply_reflection` 返回 "Already applied" | 重复应用 | 幂等保护，忽略即可 |
| 无记忆注入 | `experimental.chat.system.transform` 未注册 | 确认 `opencode.jsonc` plugin 列表包含 `opcode-pg-memory` |

### 日志级别调试

```bash
PG_MEMORY_LOG_LEVEL=debug opencode
```

---

> 本文档由 v3.9+ 代码库自动生成。修改参数后请确保运行 `bun run build` 重新编译。
