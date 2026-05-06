# opcode-pg-memory

**OpenCode 长期记忆插件** — PostgreSQL + pgvector 四层记忆架构，话题隔离 · Agent 自主调用 · OmO 多 Agent 协调

[![npm](https://img.shields.io/npm/v/opcode-pg-memory)](https://www.npmjs.com/package/opcode-pg-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## 安装

```bash
# npm 安装（推荐）
bunx opcode-pg-memory install

# 或从 GitHub
git clone https://github.com/Vbs313/opcode-pg-memory.git && cd opcode-pg-memory
.\scripts\setup.ps1
```

`bunx install` 会自动注册插件到 `opencode.jsonc` 并创建 `/pg-memory-init` 命令。

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
  "retrieval_strategies": ["semantic", "graph"],
  "filters": { "tier": "project" }
})
```

### hindsight_reflect

```json
// 跨会话反思
hindsight_reflect({ "omo_task_id": "task_123", "aggregate": true })
```

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
├── topic/          # 话题段管理器
├── services/       # 日志 · 关键词 · 隐私过滤
├── cache/          # 语义缓存
└── omo/            # OmO 适配器
mcp-server.ts       # MCP 服务入口
```

## 文档

| 文档 | 内容 |
|------|------|
| [USAGE_GUIDE.md](./USAGE_GUIDE.md) | 完整使用指南 — 配置 · 工具 · 运维 |
| [PLUGIN_DOCUMENTATION.md](./PLUGIN_DOCUMENTATION.md) | 架构详解 — 钩子系统 · 数据库设计 |

## License

MIT
