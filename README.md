# opcode-pg-memory v3.0

**OpenCode 长期记忆插件** — PostgreSQL + pgvector 实现跨平台记忆持久化

[![npm](https://img.shields.io/npm/v/opcode-pg-memory)](https://www.npmjs.com/package/opcode-pg-memory)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
![TypeScript strict](https://img.shields.io/badge/strict-true-brightgreen)
![tests](https://img.shields.io/badge/tests-171%20passing-brightgreen)

---

## 概览

opcode-pg-memory 是一个基于 PostgreSQL + pgvector 的长期记忆系统，通过 OpenCode 的官方 Plugin API（`experimental.chat.system.transform`）在每次 LLM 调用前自动注入相关记忆。

**核心能力**：

| 能力 | 说明 |
|------|------|
| **自动注入** | 每次 LLM 调用前，两路召回（关键词 + 语义）+ 混合排序，自动注入到 system prompt |
| **跨会话记忆** | 基于 PostgreSQL，记忆不会随会话结束丢失 |
| **跨平台** | 通过 MCP 协议支持 OpenCode / Claude Code / Cursor / Windsurf / Continue.dev |
| **结构化解码** | 工具调用被自动解码为 observations → entities → reflections |
| **Token 经济** | 自动评分 + 低价值清理，控制存储增长 |

---

## 安装

### 前置条件

| 组件 | 要求 |
|------|------|
| PostgreSQL | 16+（需 pgvector 扩展） |
| Node.js | >= 18 |
| Ollama（可选） | `qwen3-embedding:0.6b`（或 DeepSeek / OpenAI API） |

### npm 安装

```bash
bun install opcode-pg-memory
```

### 从源码

```bash
git clone https://github.com/Vbs313/opcode-pg-memory.git
cd opcode-pg-memory
cp .env.example .env
# 编辑 .env 填入 PG 凭证
bun run build
```

### 注册到 OpenCode

在 `~/.config/opencode/opencode.jsonc` 中：

```jsonc
{
  "plugin": [
    "opcode-pg-memory"              // npm 包名，或 "./plugins/opcode-pg-memory"（本地路径）
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
        "PG_PASSWORD": "your_password",
        "PG_MEMORY_PLATFORM": "opencode"
      }
    }
  }
}
```

**验证安装**：启动 OpenCode，日志出现 `[PG Memory] Plugin initialized successfully` 即成功。

---

## 项目结构

```
opcode-pg-memory/
├── src/
│   ├── index.ts                        # 插件入口 — 注册全部钩子
│   ├── config.ts                       # 配置封装层（委派 shared/）
│   ├── types.ts                        # 类型定义
│   ├── cli.ts                          # CLI 工具
│   │
│   ├── injection/                      # ★ v3.0 新增 — 注入引擎
│   │   ├── system-transform-injector.ts # 两路召回 + 混合评分 + 自动注入
│   │   ├── session-summary-writer.ts   # 会话摘要自动写入
│   │   ├── observation-scorer.ts       # Observation 评分 + Token Economics
│   │   └── observation-cleanup.ts      # 低价值 observation 自动清理
│   │
│   ├── shared/                         # ★ v3.0 新增 — 基础设施层
│   │   ├── paths.ts                    # 统一路径管理 (~/.opencode-pg-memory/)
│   │   ├── env-manager.ts              # .env 加载/保存 + BLOCKED_ENV_VARS + 隔离环境
│   │   └── settings-defaults.ts        # 4 层配置合并 (env → settings.json → jsonc → 默认值)
│   │
│   ├── hooks/                          # OpenCode 生命周期钩子
│   │   ├── tool-execute.ts             # tool.execute.before/after — 自动记录工具调用
│   │   ├── session-created.ts          # 会话创建 + 记忆注入
│   │   ├── session-completed.ts        # 会话完成 + 反思触发
│   │   ├── session-compacting.ts       # 会话压缩
│   │   ├── message-updated.ts          # 消息更新 → 实体提取
│   │   └── message-part-updated.ts     # 消息片段更新
│   │
│   ├── mcp/                            # MCP 工具实现
│   │   ├── recall-memory.ts            # 多策略语义检索 (BM25 + 向量 + 图 + 关键词)
│   │   ├── hindsight-reflect.ts        # 跨会话反思
│   │   ├── import-document.ts          # 文档导入 (事务性 DELETE+INSERT + 语义分块)
│   │   ├── backfill-embeddings.ts      # 向量回填
│   │   └── sync-health.ts             # 同步健康检查
│   │
│   ├── services/                       # 服务层
│   │   ├── async-embedder.ts           # 异步 embedding 队列
│   │   ├── event-synchronizer.ts       # 事件同步器
│   │   ├── opencode-schema-adapter.ts  # OpenCode SQLite 适配
│   │   ├── keyword.ts                  # 关键词检测
│   │   ├── agent-context.ts            # Agent 上下文 / 记忆隔离
│   │   ├── privacy.ts                  # 隐私过滤
│   │   └── logger.ts                   # 日志 (从 config 读取级别)
│   │
│   ├── db/
│   │   └── init-db.ts                  # PostgreSQL 初始化 (10 表 + 索引 + 迁移)
│   │
│   ├── cache/
│   │   └── semantic-cache.ts           # 语义缓存 (向量相似度去重)
│   │
│   ├── topic/
│   │   └── segment-manager.ts          # 话题段管理
│   │
│   └── utils/
│       ├── embedding.ts                # Embedding 服务 (Ollama / OpenAI / DeepSeek)
│       ├── error-classifier.ts         # 错误分类 (7 类 × 20+ 模式)
│       └── token-budget.ts             # Token 预算计算
│
├── mcp-server.ts                       # MCP 服务器入口 (支持 stdio + SSE)
├── index.ts                            # 插件导出入口
├── platform-templates/                 # ★ v3.0 新增 — 跨平台 MCP 配置模板
│   ├── cursor-mcp.json                 #   Cursor 集成
│   ├── windsurf-mcp.json               #   Windsurf 集成
│   ├── claude-code-mcp.md              #   Claude Code 集成
│   └── continue-config.json            #   Continue.dev 集成
├── tests/                              # ★ v3.0 新增 — 168 个测试
│   ├── system-transform-injector.test.ts  # 注入引擎测试 (58 tests)
│   ├── settings-defaults.test.ts          # 配置合并测试 (20 tests)
│   ├── env-manager.test.ts                # 环境变量管理测试
│   ├── ...
└── docs/
    ├── PLUGIN_DOCUMENTATION.md             # 架构详解
    └── USAGE_GUIDE.md                      # 使用指南
```

---

## 配置体系

### 4 层配置合并（优先级由高到低）

```
① process.env (运行时注入，最高)
② ~/.opencode-pg-memory/settings.json
③ ~/.config/opencode/pg-memory.jsonc
④ 硬编码默认值 (Zod schema)
```

### 凭证 vs 配置分离

| 文件 | 存储内容 | 路径 |
|------|----------|------|
| `.env` | API keys、DB 密码 | `~/.opencode-pg-memory/.env` |
| `settings.json` | 非敏感配置 | `~/.opencode-pg-memory/settings.json` |
| `pg-memory.jsonc` | OpenCode 全局覆盖 | `~/.config/opencode/pg-memory.jsonc` |

### 关键环境变量

```bash
# PostgreSQL
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=PGOMO
PG_USER=opencode
PG_PASSWORD=your_password

# Embedding 模型 (三选一)
EMBEDDING_PROVIDER=ollama      # 或 deepseek / openai
EMBEDDING_MODEL=qwen3-embedding:0.6b
EMBEDDING_DIMENSIONS=1024

# 平台身份
PG_MEMORY_PLATFORM=opencode    # 标记当前平台 (opencode/claude-code/cursor/...)
PG_MEMORY_LOG_LEVEL=info       # 日志级别
```

---

## 注入引擎（核心功能）

`experimental.chat.system.transform` — 每次 LLM 调用前自动注入记忆：

```
输入: 当前 system prompt content + session.project
       │
       ├─ 路径 A: 关键词召回 (project 过滤, importance DESC)
       │     SELECT ... FROM observations WHERE project = $1
       │     ORDER BY importance DESC, created_at DESC LIMIT 20
       │
       ├─ 路径 B: 语义召回 (pgvector ANN)
       │     SELECT ... FROM observations
       │     ORDER BY embedding <=> $query_embedding LIMIT 20
       │
       ├─ 混合排序: score = similarity × 0.5 + importance × 0.3 + recency × 0.2
       ├─ 去重: content_prefix_hash
       ├─ TokenBudget: 500~3000 tokens
       └─ 合并到 output.system[0] (非 push，兼容 vLLM/Qwen)
```

---

## 跨平台集成

所有平台通过 MCP 协议连接到同一个 PostgreSQL：

| 平台 | 配置方式 | 参考文件 |
|------|----------|----------|
| **OpenCode** | `opencode.jsonc` plugin + MCP | 内置支持 |
| **Claude Code** | `CLAUDE.md` MCP block | `platform-templates/claude-code-mcp.md` |
| **Cursor** | `.cursor/mcp.json` | `platform-templates/cursor-mcp.json` |
| **Windsurf** | `.windsurf/mcp.json` | `platform-templates/windsurf-mcp.json` |
| **Continue.dev** | `~/.continue/config.json` | `platform-templates/continue-config.json` |

MCP 服务器支持两种传输模式：

```bash
# stdio 模式 (默认，用于 OpenCode/Cursor/etc 内嵌)
node dist/mcp-server.js

# SSE 模式 (独立后台进程)
node dist/mcp-server.js --transport sse --port 37777
```

---

## 开发

```bash
# 构建
bun run build

# 类型检查 (strict: true)
bun run typecheck

# 测试 (168 tests)
bun test

# 测试覆盖
bun test --coverage
```

### 架构原则

- `strict: true` — 零隐式 any，零 null 不安全访问
- 所有 `process.env` 读取通过 `env-manager.ts` 集中管理
- BLOCKED_ENV_VARS 防止父进程凭据泄露到子进程
- 所有钩子非阻塞 — try/catch 包裹，不影响主流程
- Zod schema 作为单一事实来源，所有配置字段经过运行时校验

---

## License

GPL-3.0
