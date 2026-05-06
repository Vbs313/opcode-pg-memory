# opcode-pg-memory

**OpenCode 长期记忆插件** — 基于 PostgreSQL + pgvector 的四层记忆架构，支持话题隔离、Agent 自主调用和 OmO 多 Agent 协调。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-2.0.0-green)](./package.json)

## 特性

- **四层记忆架构** — Retain · Recall · Reflect · Semantic Cache
- **话题段隔离** — 滑动窗口 + 余弦相似度自动检测会话内话题切换，防止跨话题实体污染
- **语义向量检索** — HNSW 索引 + 多维评分（语义 50% + 时效 30% + 重要性 20%）
- **OmO Agent 集成** — Agent 可自主调用记忆工具，支持 `caller_context` 上下文融合
- **MCP 工具** — `recall_memory` 记忆检索 · `hindsight_reflect` 模式反思
- **统一事件钩子** — 匹配 OpenCode 官方 Plugin API

## 快速开始

### 前置条件

- PostgreSQL 16+（需 pgvector 扩展）
- Bun 1.0+
- Ollama + `qwen3-embedding:0.6b`（或 DeepSeek / OpenAI API）

```powershell
# 安装嵌入模型
ollama pull qwen3-embedding:0.6b
```

### 安装

```powershell
git clone https://github.com/Vbs313/opcode-pg-memory.git
cd opcode-pg-memory

# 配置
cp .env.example .env
notepad .env     # 修改 PG_PASSWORD 等

# 一键安装
.\scripts\setup.ps1
```

### 注册

在 `~/.config/opencode/opencode.jsonc` 中添加：

```jsonc
{
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
        "EMBEDDING_PROVIDER": "ollama",
        "EMBEDDING_MODEL": "qwen3-embedding:0.6b",
        "EMBEDDING_DIMENSIONS": "1024"
      }
    }
  }
}
```

### 验证

```powershell
opencode --print-logs --log-level INFO | findstr "PG Memory"
```

看到 `Plugin initialized successfully` 即表示成功。

## MCP 工具

### recall_memory

```json
// 基础检索
recall_memory({ "query": "如何优化数据库查询？" })

// Agent 自主调用（带话题上下文融合）
recall_memory({
  "query": "数据库连接池配置",
  "caller_context": { "type": "omo_agent", "current_goal": "性能调优" },
  "retrieval_strategies": ["semantic", "graph"],
  "filters": { "tier": "project" }
})
```

### hindsight_reflect

```json
// 反思会话
hindsight_reflect({ "session_id": "ses_abc" })

// 反思 OmO 任务（跨会话聚合）
hindsight_reflect({ "omo_task_id": "task_123", "aggregate": true })
```

## 架构

```
session_map                     ← OpenCode 会话映射
    │
    ├─ topic_segments           ← 话题边界隔离（滑动窗口检测）
    │   ├─ entities             ← 实体（含 weight/tier/confidence）
    │   ├─ observations         ← 工具执行观察
    │   ├─ relations            ← 实体关系
    │   └─ reflections          ← 模式反思
    │
    ├─ semantic_cache           ← 语义缓存（HNSW 检索，动态阈值）
    └─ token_usage_log
```

## 配置

| 嵌入 Provider | 模型 | 维度 |
|---------------|------|------|
| `ollama` | `qwen3-embedding:0.6b` | 1024 |
| `deepseek` | `text-embedding-v2` | 1536 |
| `openai` | `text-embedding-3-small` | 1536 |

## 项目结构

```
├── src/
│   ├── index.ts              # 插件入口（官方 Plugin API）
│   ├── types.ts              # 类型定义
│   ├── db/init-db.ts         # 数据库初始化 + 迁移
│   ├── hooks/                # 生命周期钩子
│   ├── mcp/                  # MCP 工具实现
│   │   ├── recall-memory.ts
│   │   └── hindsight-reflect.ts
│   ├── topic/                # 话题段管理器
│   │   └── segment-manager.ts
│   ├── cache/                # 语义缓存
│   ├── utils/                # 嵌入 & Token 预算
│   └── omo/                  # OmO 适配器
├── mcp-server.ts             # MCP 服务入口
├── scripts/
│   ├── setup.ps1             # 一键安装
│   └── migration-v2.sql      # DB 迁移（v1→v2）
├── tests/
└── dist/                     # 编译输出
```

## 文档

| 文档 | 内容 |
|------|------|
| [USAGE_GUIDE.md](./USAGE_GUIDE.md) | 使用指南 — 配置 · 工具参数 · 运维 · 最佳实践 |
| [PLUGIN_DOCUMENTATION.md](./PLUGIN_DOCUMENTATION.md) | 架构详解 — 四层记忆 · 钩子系统 · 数据库设计 |

## 从 v1 升级

```powershell
git pull
bun install
bun run build
.\scripts\setup.ps1 -SkipBuild  # 仅执行数据库迁移
```

迁移脚本 `scripts/migration-v2.sql` 会：
- 创建 `session_map` 和 `topic_segments` 表
- 从旧 `sessions` 表迁移数据
- 添加 `topic_segment_id` 到所有记忆表

## License

MIT
