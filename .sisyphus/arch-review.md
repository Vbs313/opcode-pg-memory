# PG Memory 架构审查报告

> 审查日期：2026-05-07
> 方法：源码审计 + PG schema 实时验证 + 参考外部 OmO 文档

## 关键发现

### OmO 代码状态：1,544 行死代码

审查中最重要的发现。OmO 相关代码状态：

| 模块 | 行数 | 状态 | 证据 |
|------|------|------|------|
| `src/omo/adapter.ts` | 747 | ❌ 死代码 | `index.ts` 中无 import/调用 |
| `src/omo/types.ts` | 231 | ❌ 死代码 | 仅在 adapter.ts 中被引用 |
| `src/mcp/recall-memory-omo.ts` | 366 | ❌ 死代码 | `index.ts` 中无 import/注册 |
| `src/mcp/hindsight-reflect-omo.ts` | 431 | ❌ 死代码 | `index.ts` 中无 import/注册 |
| **合计** | **1,544** | **死代码** | 零运行时入口 |

额外验证：

- `omo_coordination` 表 **不存在**于 PG（`\d omo_coordination` 返回未找到）。这是因为 `initializeOmOSchema()` 从未被调用。
- `observations.source_agent` 列 **存在**（可能由早期迁移手动添加），但 `agent_task_id` 列 **不存在**。
- `recall-memory-omo.ts` 中第 247-249 行的 `omo_coordination` 查询若被执行会直接 PG 报错。

**建议**：将这 4 个文件标记为"待清理/未来代码"。当前不应在运行时代码路径中引用任何 OmO 模块。

## 一、功能冗余

### 1.1 [高] `scripts/backfill-embeddings.js` vs `src/mcp/backfill-embeddings.ts`

同一目的（回填 embedding）有两套独立实现：

| 维度 | 独立脚本 | MCP 工具 |
|------|---------|----------|
| 队列 | 直接循环调用 Ollama | 喂入 AsyncEmbedder 队列 |
| 冷却 | 自有的 5 分钟冷却逻辑 | 复用 AsyncEmbedder 冷却 |
| 向量格式 | `pgvector.toSql(embedding)` | `JSON.stringify(embedding)` |
| 断点续传 | `created_at` 游标 | 无游标（依赖队列） |
| 入口 | CLI | Agent 对话 |

两套实现的向量格式最终产生相同的 `[0.1,0.2,...]`，但任一修复 bug（例如驱动格式变更）不会同步到另一方。

**建议**：统一为 MCP 工具 + 一个简化的 CLI 包装器（`node -e "call backfillEmbeddings via dist"`），删除独立的 `scripts/backfill-embeddings.js`。

### 1.2 [中] `mcp/recall-memory-omo.ts` 与 `mcp/recall-memory.ts`

`recall-memory-omo.ts` 包装基础 `recall-memory.ts`，叠加 Agent 范围过滤和 Token 预算。但由于整个 OmO 层是死代码（见上方关键发现），此冗余仅存在于代码库中，不影响运行时。

- 基础版 `recall_memory` 已有 `scope` 参数（`'session'|'task'|'project'`），与 OmO 的 `agent_scope` 功能重叠。
- 若未来启用 OmO，应统一为一个参数或明确覆盖规则。

**建议**：保持现状直至 OmO 集成正式启用。届时再决定是否合并参数。

### 1.3 [低] `session-created.ts` vs EventSynchronizer `ensureSessionMap`

两者都负责创建 `session_map` 行：

- `ensureSessionMap`：裸 `INSERT ... ON CONFLICT DO NOTHING`（只创建 opencode_session_id）
- `handleSessionCreated`：完整 upsert（project_id, model_context_limit, metadata）

前者为后续 handler 准备行，后者填充细节。互补而非冗余。

**建议**：保持现状。

---

## 二、功能冲突

### 2.1 [中] 事件双路径

`src/index.ts` 中 `tool.execute.after` 同时通过两个路径处理：

```
路径 A: event hook → EventSynchronizer → handleToolExecuteAfter
路径 B: tool.execute.after hook → 直接调用 handleToolExecuteAfter
```

后果：一次工具执行可能触发两次 `handleToolExecuteAfter`。由于该函数使用 UPDATE-before-INSERT（通过 `session_map_id + message_id + tool_name` 查重），且 EventSynchronizer 有 5 秒去重窗口，目前实际不会产生重复行。但**这个安全完全依赖巧合**——如果未来修改了查重逻辑或去重窗口，就会产生重复数据。

**建议**：
- 短期：在路径 B 中检查 EventSynchronizer 的 processingCount 或添加守卫变量。
- 中期：废弃路径 B，只保留事件总线路径 A。

### 2.2 [低] OmO 参数重叠（仅未来问题）

基础 `recall_memory.scope`（数据维度）与 OmO `agent_scope`（Agent 维度）语义不同但重叠。当前 OmO 为死代码，此冲突不存在。

**建议**：标记为未来任务。启用 OmO 时需定义组合规则。

---

## 三、功能缺失

### 3.1 [中] `omo_coordination` 表缺失

`initializeOmOSchema()` 在 adapter.ts 第 134-143 行定义了 `omo_coordination` 表的 DDL，但由于 adapter 从未初始化，该表不存在。`source_agent` 列在 `observations` 中存在（可能手动添加），但 `agent_task_id` 列缺失。

**建议**：创建迁移脚本 `scripts/migration-v2.4.1-omo-schema.sql`，包含完整的 OmO schema 定义（`omo_coordination` 表 + `agent_task_id` 列），使 schema 与代码定义一致。

### 3.2 [中] `scripts/` 与 `src/mcp/` 功能分裂

两条 embedding 回填路径没有共享核心逻辑：

```
standalone: 直接 Ollama 循环 + 自有冷却 + 自有游标
MCP:       AsyncEmbedder 队列 + 复用冷却
```

需要各自维护格式处理和错误逻辑。

**建议**：提取 `generateEmbeddingForObservation(id, text)` 为核心函数，两路径共用。

### 3.3 [中] 队列无限增长

`AsyncEmbedder` 的 `queue: EmbeddingJob[]` 是内存数组，无容量上限。极端情况下（Ollama 停机数小时且有大量工具执行），可能堆积数万条。

**建议**：设置硬上限（如 5000），超过时丢弃旧项打 warn。

### 3.4 [低] `sync_health` 的 `queue_length: -1` 隐晦

当 `getAsyncEmbedder()` 返回 null（插件未完全初始化状态），`queue_length: -1` 对用户不友好。

**建议**：改为 `null`，文档注明 null = embedder 未初始化。

### 3.5 [低] 测试覆盖率缺口

| 模块 | 覆盖 |
|------|------|
| `aggregateConsecutiveSimilar` | ✅ 7 个用例 |
| `resolveScopeToSessionIds` | ❌ 无（需 PG） |
| `EventSynchronizer.handleEvent` | ❌ 无 |
| `syncHealth` 输出形状 | ❌ 无 |
| `backfillEmbeddings` 参数校验 | ❌ 无 |

**建议**：对纯函数补充单元测试。集成测试（需 PG）暂不引入。

---

## 四、总结与优先级

### 总体评估

项目代码质量高于预期。两个最严重的潜在问题实际上不存在：

1. ❌ 我最初报告的"OmO 查询不存在的表"——代码虽引用了不存在的表，但整个 OmO 层是**完全断开的死代码**，永远不会被执行。这不是运行时风险。
2. ❌ "双事件路径产生重复"——实际无害，UPDATE-before-INSERT + dedup 窗口提供了双重保护。

### 处理结果

| 优先级 | 问题 | 状态 | 修复 |
|--------|------|:----:|------|
| **P1** | OmO 死代码 | ✅ | 移至 `src/omo/_unused/`，tsconfig 排除，README 保留重新启用指南 |
| **P1** | backfill 两套实现 | ✅ | CLI 脚本改为 `dist/src/mcp/backfill-embeddings` 的瘦包装器，核心逻辑统一到 MCP 工具 |
| **P2** | `omo_coordination` 表缺失 | ✅ | 创建 `scripts/migration-omo-schema.sql`（幂等，含 `agent_task_id` 列） |
| **P2** | Embedder 队列无上限 | ✅ | 硬上限 5000，超限丢弃旧项打 warn，添加 `getDroppedCount()` |
| **P3** | `sync_health.queue_length: -1` | ✅ | 改为 `null`，接口类型 `number\|null` |
| **P3** | EventSynchronizer 单元测试 | ✅ | 14 个用例全部通过（dedup、processingCount、stopped、isAvailable、drain、mode filter） |
