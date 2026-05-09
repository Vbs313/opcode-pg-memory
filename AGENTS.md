# Agent Memory Usage Guide (v3.5)

opcode-pg-memory v3.0 为多 Agent 环境提供长期记忆支持，支持 11 个内置 Agent 的记忆隔离与共享。

---

## Memory Tiers (记忆层级)

| 层级 | 范围 | 说明 |
|------|------|------|
| `permanent` | 全局共享 | 跨 Agent、跨项目的永久知识（如编码规范） |
| `project` | 项目共享 | 同项目内所有 Agent 共享 |
| `session` | Agent 私有 | 当前 Agent 会话私有，默认级别 |

## 自动注入 (v3.5)

v3.5 通过 `experimental.chat.system.transform` 在**每次 LLM 调用前自动注入**相关记忆，无需 Agent 主动调用 `recall_memory`。

注入策略（按优先级）：
- **短时记忆优先 (v3.5 新增)**：同一 session 内的工具调用和用户消息缓存在内存中，下次 LLM 调用直接注入，**零 PG 查询**
- **路径 A（关键词）**：当前项目的高重要性 observation（90 天窗口）
- **路径 B（语义）**：pgvector ANN（冷启动检测跳过，3s 超时降级）
- **混合排序**：`similarity × 0.5 + importance × 0.3 + recency × 0.2`
- **记忆压缩**：output-first 提炼，不显示原始命令文本
- **元认知指令**：Agent 根据置信度分级使用记忆
- **Token 预算**：自动控制在 500~3000 tokens

## Cross-Agent Memory Sharing

v3.0 保持跨 Agent 记忆共享机制：

```json
// 检索当前 Agent 自己的记忆（默认）
recall_memory({ query: "连接池配置", scope: "session" })

// 检索同任务下所有 Agent 的记忆
recall_memory({ query: "连接池配置", scope: "task" })

// 检索同项目下所有 Agent 的记忆
recall_memory({ query: "连接池配置", scope: "project" })
```

Agent 间的共享规则由 `AGENT_CAPABILITIES` 定义。

## Agent Capabilities

| Agent | Role | Shares memory with |
|-------|------|-------------------|
| Sisyphus | General | Sisyphus-Junior |
| Hephaestus | Build | Sisyphus |
| Oracle | Reasoning | Sisyphus, Metis |
| Librarian | Search | Sisyphus, Explore |
| Explore | Discovery | Sisyphus, Librarian |
| Multimodal Looker | Vision | Sisyphus |
| Prometheus | Plan | Sisyphus, Atlas |
| Metis | Meta | Oracle, Sisyphus |
| Momus | Creative | Sisyphus |
| Atlas | Navigate | Sisyphus, Prometheus |
| Sisyphus-Junior | Execute | Sisyphus |

## Environment Variables

| 变量 | 说明 |
|------|------|
| `OMO_AGENT_ID` | 当前 Agent 名称（如 `oracle`、`explore`） |
| `OPENCODE_AGENT` | 备选，`OMO_AGENT_ID` 未设置时读取 |
| `PG_MEMORY_PLATFORM` | 平台标识（opencode / claude-code / cursor 等） |

## Best Practices

1. **依赖自动注入** — v3.5 在每次 LLM 调用时自动注入记忆，短时记忆优先（零延迟）
2. **特定搜索用 `recall_memory`** — 当自动注入内容不足时，手动调用精确搜索
3. **任务完成后运行 `/pg-memory-reflect`** — 或调用 `hindsight_reflect` 提炼模式
4. **使用 `scope='task'` 跨 Agent 协作** — 同一任务的不同 Agent 可以互相看到记忆
5. **使用 `filters.tier='permanent'` 获取全局知识** — 如编码规范、架构决策
6. **置信度参考** — >=80% 高可信度执行，60-79% 交叉验证，<60% 仅作提示
7. **PG 宕机不慌** — 内存缓冲队列自动暂存，恢复后自动 flush

## 子代理注意事项

Sisyphus-Junior、explore、librarian 等子代理**无直接 MCP 工具访问权限**。
主代理应调用 `recall_memory` 后将结果通过上下文传递给子代理。

但以下机制在子代理中自动生效：
- **短时记忆**：子代理有独立的 session ID，各自的短时记忆互不干扰
- **自动注入**：`experimental.chat.system.transform` 在子代理中也正常工作
- **短时记忆空时**：自动降级到 PG 两路召回
