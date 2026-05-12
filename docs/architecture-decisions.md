# 架构决策记录

> 最后更新: 2026-05-10 | 对应版本: opcode-pg-memory v3.9

---

## 已实施的决策

### ADR-001: 自动注入使用 `experimental.chat.system.transform`

**状态**: ✅ 已实施 (v3.0)

使用 OpenCode 官方 Plugin SDK 的 `experimental.chat.system.transform` 钩子，在每次 LLM 调用前注入记忆。
记忆合并到 `output.system[0]`（非 `push` 新条目），兼容只接受单条 system message 的 vLLM/Qwen 后端。

### ADR-002: 两路召回 + 混合排序

**状态**: ✅ 已实施 (v3.0)

| 路径 | 策略 | 无条件 |
|------|------|--------|
| 关键词 | `WHERE project = $1 ORDER BY importance DESC` | ✅ 总是执行 |
| 语义 | `ORDER BY embedding <=> $query` | 需要 embedding API |

**评分公式**: `score = similarity × 0.5 + importance × 0.3 + recency × 0.2`

### ADR-003: PostgreSQL 作为唯一存储

**状态**: ✅ 已实施 (v2.0+)

所有平台共享同一个 PostgreSQL 数据库。MCP Server 作为唯一的数据访问层，
其他平台不直接连接数据库。

### ADR-004: `.env` 迁移到独立数据目录

**状态**: ✅ 已实施 (v3.0)

凭证从插件根目录 `.env` 迁移到 `~/.opencode-pg-memory/.env`。
配置与凭证分离：`.env` 只存 API keys / DB 密码，非敏感配置走 `settings.json`。

### ADR-005: 4 层配置合并

**状态**: ✅ 已实施 (v3.0)

```
process.env → ~/.opencode-pg-memory/settings.json
  → ~/.config/opencode/pg-memory.jsonc → Zod 默认值
```

### ADR-006: 子进程环境隔离

**状态**: ✅ 已实施 (v3.0)

`BLOCKED_ENV_VARS` 从子进程环境中删除敏感变量：
`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `PG_PASSWORD`, `PG_MEMORY_DATA_DIR`

### ADR-007: `strict: true`

**状态**: ✅ 已实施 (v3.0)

TypeScript 从 `"strict": false` + 6 个独立 false flag 改为 `"strict": true`。
修复 4 处类型错误后，11,400 行代码零类型错误。

### ADR-008: 跨平台 MCP 配置模板

**状态**: ✅ 已实施 (v3.0)

为 Cursor、Windsurf、Claude Code、Continue.dev 生成 MCP 配置模板，
位于 `platform-templates/` 目录。

---

### ADR-009: 短时记忆层

**状态**: ✅ 已实施 (v3.5)

在 LLM 和 PG 之间增加内存短时记忆层。当前会话的工具调用和用户消息
直接缓存到 `Map<sessionId, Observation[]>`。`system.transform` 时优先
从短时记忆读取，命中则零 PG 查询。

### ADR-010: 内存队列替代 SQLite 缓冲区

**状态**: ✅ 已实施 (v3.4.1)

本地 PG 场景下，SQLite 持久化缓冲是过度设计。替换为纯内存队列 +
指数退避重试（30s 间隔，max 10 次，约 5 分钟后放弃）。

### ADR-011: 用户消息捕获 + 噪声过滤

**状态**: ✅ 已实施 (v3.5.1~3.5.3)

---

### ADR-012: 移除双重注入 (v3.9.0)

**状态**: ✅ 已实施 (v3.9.0)

`chat.message` 钩子中的记忆注入逻辑被移除。该注入路径是 v2.x 遗留，
通过 synthetic part 注入实体信息。v3.0 引入 `experimental.chat.system.transform`
后，每次 LLM 调用前都会通过 system[0] 合并注入记忆，导致两条路径同时工作，
LLM 收到两份相同的记忆块。

### ADR-013: Entities 加入全局回退 (v3.9.0)

**状态**: ✅ 已实施 (v3.9.0)

`message-updated` 钩子持续从用户消息中提取实体并写入 `entities` 表，
但注入管道（keywordRecall + semanticRecall）只检索 `observations`，
`entities` 表的数据从未被检索到。v3.9.0 在全局回退路径中加入
`entities WHERE weight >= 5` 检索，使结构化知识也能被跨项目召回。

用户消息通过 `message.updated` 钩子捕获入库。经过三层处理：
1. `isNoise()` 过滤问候语/纯标点/重复字符
2. `calculateMessageImportance()` 评分 (1-5)
3. `importance=2` 的消息 7 天后 cleanup 自动删除

---

## 被否决的方案

### 否决: 独立 guard-plugin

在尝试 7 轮迭代后放弃。最终方案：`opencode.jsonc` 的 `formatter` 配置即可实现自动格式化，
无需独立的 guard-plugin。

### 否决: 用 `session.created` 替代 `experimental.chat.system.transform`

`session.created` 事件没有 `output.system` 可修改对象。
记忆注入必须通过 `experimental.chat.system.transform`。
id, session_map_id, topic_segment_id, tool_name,
tool_input_summary, tool_output_summary, embedding,
importance, created_at, message_id, metadata
```

**缺失你需要的 `source` 和 `source_hash` 列**——你的分析正确。

索引方面已有 `idx_observations_importance`, `idx_observations_created_at`, HNSW 向量索引，但无 `source` 索引——这是预期，因为列尚未存在。

---

## 二、关键纠正：Skill 不是钩子，插件才是

### 你分析中的核心错误假设

你说：

> "编写 Skill `deterministic-guard`，利用 oh-my-openagent Skill 系统，on:task_completed 钩子"

**这不可行。** 我读完了 `src/features/opencode-skill-loader/` 的全部代码。Skills 的 YAML frontmatter 只支持：
- `name`, `description`, `tools`（推荐工具白名单）
- `mcp`（推荐的 MCP 服务器）
- **不支持任何生命周期事件绑定**

Skills 的作用是：Agent 在任务开始时接收到指令文本（"请遵循以下规范……"），不会自动执行脚本。

### 正确的方案：写一个 OpenCode 插件，而不是 Skill

你的确定性闭环需要的是一个 **OpenCode Plugin**（TypeScript 文件），挂在 `~/.config/opencode/plugins/` 下。插件的 hooks 模式如 `ecc-hooks.ts`（Everything Claude Code 示例）所示：

```typescript
// 示例结构 ~/.config/opencode/plugins/guard-plugin.ts
import type { PluginModule } from "@opencode-ai/plugin"

export const server: PluginModule = {
  hooks: {
    "tool.execute.after": async (input, output) => {
      // 1. 获取文件路径
      // 2. 批量运行 prettier + eslint --fix（保守规则集）
      // 3. 收集不可修复错误写入 .opencode/last_errors.json
    },
    "session.created": async (input) => {
      // 4. 读取 last_errors.json，注入到系统提示
    }
  }
}
```

**核心前提：oh-my-openagent v4.0.0 的 `@opencode-ai/plugin` SDK 已经支持 `tool.execute.after` 和 `session.created` 等钩子**。`rules-injector` 本身就是用这个机制实现的。

---

## 三、真实可行性评估（基于 Windows + deepseek-v4-flash 约束）

| 你提议的方案 | 实际可行性 | 修正方案 |
|-|-|-|
| Skill `deterministic-guard`（on:task_completed） | ❌ 不存在 | 改为 OpenCode Plugin |
| Skill `doc-sync`（on:file_changed） | ❌ 不存在 | 改为 Plugin + CLI 脚本 |
| Skill MCP → opcode-pg-memory MCP | ✅ 可行 | `skill-mcp-manager` 能发现 opcode-pg-memory 的 MCP server |
| `formatter-trigger` 已有去抖 | ❌ 每文件独立执行 | 需在 Plugin 中自己实现 debounce |
| Subagent 使用 deepseek model | ❌ 子会话无模型 | 所有需要在子会话执行的任务都不可用（重要约束！） |

### 子代理模型修复

**问题根因**：
`task(subagent_type="explore")` 创建的子会话不继承 deepseek provider 的 API key 配置。子会话试图用 `deepseek:deepseek-v4-flash` 但无法认证，然后 fallback 到硬编码的内建模型（gpt-5.5, gemini-3.1-pro 等）——均无 API key。

**修复尝试**：`background_task.fallback_models` 配置项**不存在**（已代码确认：`src/features/background-agent/`、`src/shared/model-requirements.ts` 中均无此配置）。唯一可能的修复路径有两条：

**路径 A**（如果子会话继承 provider）：在 `~/.config/opencode/opencode.jsonc` 的 deepseek provider 中显式写上 `apiKey`（而非仅依赖环境变量），看子会话是否能继承。

**路径 B**（接受限制）：如果仍不行，说明 OpenCode 的 session 创建时**不复制 provider 配置**——这是 OpenCode 核心的设计限制，当前无解。所有子代理任务改为在主会话中直接执行（反正 tools 都是直接可用的）。

**临时方案**：如果上方修复后子代理依然不可用，所有需要子代理的任务改为**在主会话中直接执行**（反正 tools 都是直接可用的）。`doc-indexer` 脚本必须是本地 CLI 工具（Node.js 直连执行），不依赖 Agent 驱动。

---

## 四、修正后的工程指令

### P0（本周）：确定性反馈闭环——OpenCode Plugin

**文件**：`~/.config/opencode/plugins/guard-plugin.ts`

```typescript
// ~/.config/opencode/plugins/guard-plugin.ts
// Plugin SDK 1.4.0 已验证的可用钩子
import type { PluginModule } from "@opencode-ai/plugin"

const debounceTimers = new Map<string, NodeJS.Timeout>()
const pendingFiles = new Set<string>()
const lastErrors: string[] = []

export const server: PluginModule = {
  hooks: {
    // 钩子 1：工具执行后触发格式化——已验证 tool.execute.after 存在
    "tool.execute.after": async (input, output) => {
      // 只处理 write/edit 操作
      if (!["write", "edit", "multiedit"].includes(input.tool)) return
      
      // 从 output.metadata 提取文件路径
      const filePath = extractFilePath(output)
      if (!filePath) return
      
      // 去抖：合并 500ms 内的所有文件写入
      pendingFiles.add(filePath)
      const existing = debounceTimers.get("batch")
      if (existing) clearTimeout(existing)
      
      debounceTimers.set("batch", setTimeout(async () => {
        const files = [...pendingFiles]
        pendingFiles.clear()
        
        try {
          // 批量运行 prettier（安全，不改变 AST）
          await runFormatter(files, "prettier --write", extractDir(filePath))
          
          // 仅运行"不改变 AST"的 ESLint 规则
          // 白名单：semi, comma-dangle, indent, quotes 等纯格式规则
          await runFormatter(files,
            "eslint --fix --rule 'semi: error' --rule 'comma-dangle: error'",
            extractDir(filePath)
          )
          
          // 收集不可自动修复的错误
          const errors = await runLintOnly(files, extractDir(filePath))
          lastErrors.length = 0
          lastErrors.push(...errors)
        } catch (e) {
          // 不阻断主链路，仅 log
          console.error("[guard-plugin] lint error:", e)
        }
      }, 500))
    },
    
    // 钩子 2：每次 LLM 调用前注入错误信息
    // 已验证：experimental.chat.system.transform 存在（index.d.ts:233）
    "experimental.chat.system.transform": async (_input, output) => {
      if (lastErrors.length > 0) {
        output.system.push(
          `\n[LINT ERRORS FROM PREVIOUS SESSION]\n${lastErrors.join("\n")}\n[END]`
        )
      }
    }
  }
}
```

**依赖**：`prettier` + `eslint` 需作为 devDependencies 安装在项目中。Windows 兼容，因为 Node.js 脚本直接运行。

### P0：opcode-pg-memory 增量更新

**SQL 变更**（`src/db/init-db.ts`）：

```sql
-- 新增列
ALTER TABLE observations 
  ADD COLUMN source VARCHAR(512),
  ADD COLUMN source_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_observations_source ON observations(source);
```

**新增 MCP 工具** `import_document`（`src/mcp/import-document.ts`）：

```typescript
// 原子性替换逻辑
async function importDocument(source: string, content: string) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("DELETE FROM observations WHERE source = $1", [source])
    // 切分 content 为多个观察记录
    const chunks = chunkContent(content)
    for (const chunk of chunks) {
      const embedding = await embedder.embed(chunk.text)
      await client.query(`
        INSERT INTO observations 
        (session_map_id, tool_name, tool_input_summary, embedding, 
         importance, source, source_hash, metadata)
        VALUES ($1, 'import_document', $2, $3, 4, $4, $5, $6)
      `, [PG_SESSION_ID, chunk.text, embedding, source, chunk.hash, {}])
    }
    await client.query("COMMIT")
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
  // 事务外异步 REINDEX
  pool.query("REINDEX INDEX CONCURRENTLY idx_observations_embedding")
}
```

### P1（下周）：知识库索引脚本

由于子代理模型不可用，`doc-sync` 必须是**本地运行的可执行脚本**，放在项目根目录：

```
.opencode/doc-indexer.mjs
```

**通信方式**：不经过 MCP 协议。doc-indexer 直接操作 PostgreSQL（方式 C），因为 import_document 的核心逻辑是 SQL INSERT + embedding 计算，在脚本中复用 embedder 模块的代码更简单可靠。

```javascript
// doc-indexer.mjs — 独立 Node.js 脚本
// 使用方法：node .opencode/doc-indexer.mjs
// 扫描项目文档 → 语义分块 → 直连 PostgreSQL 插入

import { readFileSync, readdirSync } from "fs"
import { resolve, relative } from "path"
import pg from "pg"

const DOC_PATTERNS = ["ARCHITECTURE.md", "CONTRIBUTING.md", "docs/**/*.md"]

// 1. 扫描匹配文件
// 2. 按 markdown heading 语义边界分块（段落/标题），而非硬性字数
// 3. 直连 PostgreSQL，执行 DELETE + INSERT 事务
// 4. 每块计算 SHA256(source + content) 作为 source_hash
```

此脚本通过 `(node .opencode/doc-indexer.mjs)` 手动执行，或通过 git pre-commit hook 自动触发。

### P2（按需）：操作路径重放

**不推荐现在投入。** 原因：
1. `tool.batch` 已存在但限制多，通用重放引擎工程量远超最初的 2 周预估
2. 子代理模型不可用，重放序列需要子代理分析相似度——这条路被堵死
3. 你的 80% 重复任务可以通过 template + Ctrl+C/V 解决

**替代方案**：保存 Prometheus 规划的输出 `.sisyphus/plans/` 作为模板。下次类似任务时手动加载。

---

## 五、握手协议：两系统协作图

```
┌─────────────────────────────────────────┐
│           OpenCode 主会话                │
│  (deepseek:deepseek-v4-flash)            │
│                                          │
│  ~/.config/opencode/plugins/             │
│  ├── guard-plugin.ts  ← 新增             │
│  │   ├── tool.execute.after → 格式+lint   │
│  │   └── session.created → 注入错误       │
│  │                                        │
│  └── opcode-pg-memory/                    │
│       └── mcp-server.ts                  │
│           ├── recall_memory              │
│           ├── hindsight_reflect          │
│           └── import_document  ← 新增     │
│                                          │
│  oh-my-openagent hooks (不修改)           │
│  ├── rules-injector (tool.execute.after) │
│  ├── formatter-trigger (手动调用)         │
│  └── ...52 hooks                         │
└─────────────────────────────────────────┘
           │ MCP stdio
           ▼
┌─────────────────────────────────────────┐
│  PostgreSQL                             │
│  observations 表                         │
│  ├── 新增 source VARCHAR(512)            │
│  └── 新增 source_hash VARCHAR(64)        │
└─────────────────────────────────────────┘
           │
.opencode/doc-indexer.mjs (手动/git hook 触发)
```

---

## 六、失败模式与降级策略

| 故障点 | 后果 | 降级 |
|-|-|-|
| guard-plugin.ts 的 `prettier --write` 修改了语义 | 代码被错误格式化 | **保守规则集**：prettier 全部安全；eslint 仅 `semi`, `comma-dangle`, `indent` 等纯格式规则 |
| guard-plugin.ts 批量运行 prettier 时文件被其他进程锁定（Windows 常见） | 格式化失败 | 捕获 `EBUSY` 错误，等待 100ms 重试一次，仍失败则跳过该文件并记录到 lastErrors |
| guard-plugin.ts crash | Agent 不受影响继续工作 | try-catch 包裹所有逻辑，崩溃时仅 log 不阻断主链路 |
| import_document 事务执行一半断连 | 脏数据 | 事务内 DELETE+INSERT：要么全删全插，要么保持不变。执行 DELETE 前先 BEGIN，提交前检查影响行数是否合理 |
| embedding 计算耗时过长导致 MCP 超时（大文档） | 导入失败 | 设置 MCP timeout 为 5 分钟，或将 embedding 计算移到 background worker |
| REINDEX CONCURRENTLY 长时间阻塞 | 查询超时 | 加 `timeout` 参数，超时后跳过 REINDEX，标记索引需要重建 |
| doc-indexer.mjs 意外删除了整个 observations 表 | 知识库丢失 | 执行 DELETE 前先 BEGIN，临时导出受影响 source 的数据到备份表。提交前检查影响行数是否合理 |
| doc-indexer.mjs 导入 100 个文档，向量爆炸 | 检索精度下降 | 设置 `observations` 表上限（10 万行），超出后自动淘汰最早 `source` |
| `experimental.chat.system.transform` 注入错误到 system prompt 但跨会话污染 | 会话A的错误出现在会话B | 用 `Map<sessionID, string[]>` 隔离不同会话的错误缓存 |

---

## 七、一周行动清单（修正版）

| 时间 | 行动 | 工作量 | 修改文件 |
|------|------|--------|----------|
| 今天 | 安装 opencode-rules | 2 分钟 | `opencode plugin opencode-rules@latest --global` |
| 今天 | 创建 `~/.config/opencode/rules.md` | 10 分钟 | 写入项目编码规范 |
| 周一 | 实现 `guard-plugin.ts` | 2-3 小时 | `~/.config/opencode/plugins/guard-plugin.ts` |
| 周二 | 给 `observations` 表加 `source`/`source_hash` | 1 小时 | `src/db/init-db.ts` |
| 周三 | 实现 `import_document` MCP 工具 | 3-4 小时 | `src/mcp/import-document.ts` + 注册到 `mcp-server.ts` |
| 周四 | 写 `doc-indexer.mjs` 脚本 | 2 小时 | `.opencode/doc-indexer.mjs` |
| 周五 | 测试全链路：文档导入→格式化→错误注入 | 2 小时 | - |

### 需要你手动确认的点（已更新）

1. ✅ **`experimental.chat.system.transform` 已确认存在**（`@opencode-ai/plugin@1.4.0`, `dist/index.d.ts:233`）。无需 fallback 方案，直接用这个钩子注入错误信息到 system prompt。
2. **opcode-pg-memory 是否已连上 PostgreSQL？** — 检查 `mcp-server.ts:25-32` 的环境变量 `PG_HOST`, `PG_PORT` 等已配置并且数据库可达。
3. **子代理修复验证** — 已在上方提供 `background_task.fallback_models: []` 方案。尝试后如仍不可用，所有子代理工作改为主会话内直接执行。
