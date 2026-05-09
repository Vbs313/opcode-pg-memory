# opcode-pg-memory v3.5

**OpenCode 长期记忆插件** — PostgreSQL + pgvector 跨平台记忆持久化

[![npm](https://img.shields.io/npm/v/opcode-pg-memory)](https://www.npmjs.com/package/opcode-pg-memory)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
![TypeScript strict](https://img.shields.io/badge/strict-true-brightgreen)
![tests](https://img.shields.io/badge/tests-172%20passing-brightgreen)

---

## 概览

PostgreSQL 驱动的记忆系统，通过 `experimental.chat.system.transform` 在每次 LLM 调用前自动注入相关历史记忆。含短时记忆层（零延迟）和长时记忆层（两路召回）。

| 能力 | 说明 |
|------|------|
| **短时记忆** | 当前会话的工具调用和消息缓存于内存 Map，30 分钟 TTL，零 PG 查询 |
| **双路召回** | 关键词 + 语义 pgvector ANN，混合评分，冷启动检测 |
| **19 个 MCP 工具** | 检索、时间线、知识语料库、会话日志、文档导入、反思 |
| **记忆压缩** | Observations 压缩为 output-first 叙事结构 |
| **噪声过滤** | 问候语/纯标点/重复字符 → 跳过入库 |
| **消息评分** | `calculateMessageImportance()` 1-5 级，高价值保留更久 |
| **Agent 元认知** | `<pg_memory>` 注入行为指南（>=80%/60-79%/<60% 分级） |
| **韧性设计** | PG 宕机不崩溃，内存缓冲 + 指数退避重试 |
| **跨平台** | OpenCode / Claude Code / Cursor / Windsurf / Continue.dev |

---

## 快速开始

```bash
bun install opcode-pg-memory
```

配置 `~/.config/opencode/opencode.jsonc`：

```jsonc
{
  "plugin": ["opcode-pg-memory"],
  "mcp": {
    "pg-memory": {
      "type": "local",
      "command": ["bun", "path/to/opcode-pg-memory/dist/mcp-server.js"],
      "enabled": true,
      "environment": {
        "PG_HOST": "localhost", "PG_PORT": "5432",
        "PG_DATABASE": "PGOMO", "PG_USER": "opencode",
        "PG_PASSWORD": "your_password",
        "PG_MEMORY_PLATFORM": "opencode"
      }
    }
  }
}
```

详细说明见 `REFERENCE.md`。

---

## 项目结构

```
opcode-pg-memory/
├── src/
│   ├── index.ts                     # 插件入口 (6 钩子)
│   ├── config.ts                    # 配置封装
│   │
│   ├── injection/                   # 注入引擎
│   │   ├── system-transform-injector.ts  # 两路召回 + 压缩 + 评分
│   │   ├── session-summary-writer.ts     # 会话摘要
│   │   ├── observation-scorer.ts         # 评分 + 经济学 + eval
│   │   └── observation-cleanup.ts        # 低价值清理
│   │
│   ├── hooks/                       # OpenCode 生命周期钩子
│   │   ├── tool-execute.ts          # 工具调用捕获 + 短时记忆
│   │   ├── message-updated.ts       # 消息捕获 + 噪声过滤 + 评分
│   │   ├── session-created.ts       # 会话创建
│   │   ├── session-completed.ts     # 会话完成
│   │   ├── session-compacting.ts    # 会话压缩
│   │   └── message-part-updated.ts  # 片段更新
│   │
│   ├── mcp/                         # 19 个 MCP 工具
│   │   ├── recall-memory.ts         # 多策略检索
│   │   ├── hindsight-reflect.ts     # 跨会话反思
│   │   ├── import-document.ts       # 文档导入
│   │   ├── timeline.ts              # 时间线
│   │   ├── get-memory.ts            # 单条详情
│   │   ├── delete-memory.ts         # 隐私删除
│   │   ├── knowledge-corpus.ts      # 7 工具 (build/query/list/rebuild/delete/prime/reprime)
│   │   ├── session-logger.ts        # 4 工具 (start/log/end/search)
│   │   ├── backfill-embeddings.ts   # 向量回填
│   │   └── sync-health.ts           # 健康检查
│   │
│   ├── services/                    # 服务层
│   │   ├── short-term-memory.ts     # 短时记忆 (Map, 30min TTL, 50/会话)
│   │   ├── memory-buffer.ts         # PG 不可用时内存队列
│   │   ├── async-embedder.ts        # 异步 embedding
│   │   ├── logger.ts                # 日志
│   │   └── ...
│   │
│   ├── shared/                      # 基础设施
│   │   ├── paths.ts                 # ~/.opencode-pg-memory/
│   │   ├── env-manager.ts           # 凭证管理 + BLOCKED_ENV_VARS
│   │   ├── settings-defaults.ts     # 4 层配置合并 + Zod
│   │   └── errors.ts                # Error 类层次 (6 子类)
│   │
│   └── utils/
│       ├── embedding.ts             # Embedding 服务 (Ollama/OpenAI/DeepSeek)
│       ├── error-classifier.ts      # 错误分类 (7 类 × 20+ 模式)
│       └── token-budget.ts          # Token 预算
│
├── mcp-server.ts                    # MCP 服务器 (stdio + SSE + /health)
├── index.ts                         # 插件导出入口
├── tests/                           # 172 个测试
├── skills/                          # 3 Agent 技能
├── platform-templates/              # 5 平台 MCP 模板
└── docs/
    ├── REFERENCE.md                 # 完全参考手册
    ├── PLUGIN_DOCUMENTATION.md      # 架构详解
    └── USAGE_GUIDE.md               # 使用指南
```

---

## 配置

### 4 层优先级

```
process.env → ~/.opencode-pg-memory/.env
  → ~/.opencode-pg-memory/settings.json
  → ~/.config/opencode/pg-memory.jsonc
  → Zod 默认值
```

### 关键环境变量

```bash
PG_HOST=localhost           # PostgreSQL
PG_PORT=5432
PG_DATABASE=PGOMO
PG_PASSWORD=your_password
PG_MEMORY_PLATFORM=opencode # 平台标识
PG_MEMORY_LOG_LEVEL=info    # 日志级别
```

### 嵌入模型

```bash
EMBEDDING_PROVIDER=ollama   # 或 deepseek/openai
EMBEDDING_MODEL=qwen3-embedding:0.6b
```

---

## 数据流

```
用户消息
  → message-updated (噪声过滤 → 重要性评分 → 入库 + 短时记忆)

工具调用
  → tool.execute.before (记录入参)
  → tool.execute.after (记录出参 + 短时记忆)
  → PG 不可用 → enqueueObservation (内存队列, 30s 重试)

下次 LLM 调用
  → experimental.chat.system.transform
     短时记忆有数据? → 直接注入 (零 PG 查询)
     短时记忆空?     → 两路召回 (关键词 + 语义 pgvector)
     混合评分 → 压缩 → 元认知注入 → output.system[0]
```

---

## MCP 服务器

```bash
# stdio (默认)
node dist/mcp-server.js

# SSE (独立进程)
node dist/mcp-server.js --transport sse --port 37777

# 健康检查
curl http://localhost:37777/health
```

---

## 开发

```bash
bun run typecheck     # strict:true 类型检查
bun run test          # 172 tests
bun run build         # 生产构建
```

---

## License

GPL-3.0
