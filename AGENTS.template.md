# Agent Memory Usage Guide

PG Memory 插件为多 Agent 环境提供长期记忆支持，支持 11 个内置 Agent 的记忆隔离与共享。

## Memory Tiers (记忆层级)

| 层级 | 范围 | 说明 |
|------|------|------|
| `permanent` | 全局共享 | 跨 Agent、跨项目的永久知识（如编码规范） |
| `project` | 项目共享 | 同项目内所有 Agent 共享 |
| `session` | Agent 私有 | 当前 Agent 会话私有，默认级别 |

## Cross-Agent Memory Sharing (跨 Agent 共享)

使用 `recall_memory` 的 `scope` 参数控制检索范围：

```json
// 检索当前 Agent 自己的记忆（默认）
recall_memory({ query: "连接池配置", scope: "session" })

// 检索同任务下所有 Agent 的记忆
recall_memory({ query: "连接池配置", scope: "task" })

// 检索同项目下所有 Agent 的记忆
recall_memory({ query: "连接池配置", scope: "project" })
```

Agent 间的共享规则由 `AGENT_CAPABILITIES` 定义（见下方表格）。
`scope='task'` 会包含共享规则内允许的所有 Agent 的记忆。

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
| `OMO_AGENT_ID` | 当前 Agent 名称（如 `oracle`、`explore`）。设置后 session 会自动标记 agent_id |
| `OPENCODE_AGENT` | 备选，当 `OMO_AGENT_ID` 未设置时读取 |

未设置时，插件运行在单 Agent 模式（向后兼容），所有行为不变。

## Best Practices

1. **任务开始前调用 recall_memory** — 获取历史经验和相关上下文
2. **使用 `scope='task'` 进行协作** — 跨 Agent 检索同任务记忆
3. **使用 `filters.tier='permanent'` 获取全局知识** — 如编码规范、架构决策
4. **使用 `aggregate_similar=true`** — 聚合重复工具调用，避免上下文膨胀
5. **任务完成后调用 hindsight_reflect** — 或运行 `/pg-memory-reflect`

## 子代理注意事项

Sisyphus-Junior、explore、librarian 等子代理**无直接 MCP 工具访问权限**。
主代理应调用 `recall_memory` 后将结果通过上下文传递给子代理。

## Agent-Specific Injection (planned)

当 Agent 启动新会话时，自动注入：
- 所有 `permanent` 层级记忆
- 所有 `project` 层级记忆（如果设置了 `project_id`）
- 同一 Agent 最近 5 条会话记忆
- 共享规则内其他 Agent 最近 5 条任务记忆

> 当前版本：agent_id 自动记录到 session_map。Agent 特定的注入逻辑计划在后续版本实现。
