#!/usr/bin/env node

/**
 * MCP Server for OpenCode PG Memory Plugin
 *
 * 提供 recall_memory 和 hindsight_reflect 两个 MCP 工具
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Pool } from "pg";
import { initializeDatabase, DatabaseConfig } from "./src/db/init-db";
import { recallMemory, RecallMemoryInput } from "./src/mcp/recall-memory";
import {
  hindsightReflect,
  HindsightReflectInput,
} from "./src/mcp/hindsight-reflect";
import { importDocument, ImportDocumentInput } from "./src/mcp/import-document";
import { createLogger } from "./src/services/logger";

const logger = createLogger("mcp-server");

// 配置加载：环境变量（由 OpenCode MCP config 的 environment 字段注入，或 .env 文件）
const dbConfig: DatabaseConfig = {
  host: process.env.PG_HOST || "localhost",
  port: parseInt(process.env.PG_PORT || "5432", 10),
  database: process.env.PG_DATABASE || "opencode_memory",
  user: process.env.PG_USER || "opencode",
  password: process.env.PG_PASSWORD || "",
  ssl: process.env.PG_SSL === "true",
};

// 工具定义
const TOOLS: Tool[] = [
  {
    name: "recall_memory",
    description:
      "从长期记忆中检索相关事实、实体、观察和反思，支持多策略并行检索（语义+BM25+图遍历）。使用多维评分函数：Relevance = 0.5*SemSim + 0.3/(1+RecencyDays) + 0.2*Importance",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "检索查询文本",
        },
        session_id: {
          type: "string",
          description: "当前会话ID，用于上下文过滤",
        },
        retrieval_strategies: {
          type: "array",
          items: {
            enum: ["semantic", "bm25", "graph", "keyword"],
          },
          default: ["semantic", "bm25", "graph"],
          description: "检索策略组合",
        },
        max_results: {
          type: "integer",
          default: 10,
          minimum: 1,
          maximum: 50,
          description: "返回结果数量上限",
        },
        filters: {
          type: "object",
          properties: {
            entity_types: {
              type: "array",
              items: { type: "string" },
              description: "实体类型过滤",
            },
            tier_levels: {
              type: "array",
              items: { enum: ["permanent", "project", "session"] },
              description: "层级过滤",
            },
            min_confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
              default: 0.5,
              description: "最低置信度",
            },
            time_range_days: {
              type: "integer",
              description: "时间范围（天）",
            },
          },
        },
        rerank: {
          type: "boolean",
          default: true,
          description: "是否使用交叉编码器重排序",
        },
      },
      required: ["query"], // session_id 可选：未提供时自动检测最近活跃 session
    },
  },
  {
    name: "hindsight_reflect",
    description:
      "对会话/任务/话题段的观察进行反思，归纳经验模式，生成可复用的反思记录。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "OpenCode 会话 ID（可选，三选一）",
        },
        omo_task_id: {
          type: "string",
          description: "OmO 任务 ID（可选，三选一）",
        },
        topic_segment_id: {
          type: "string",
          description: "特定话题段 ID（可选，三选一）",
        },
        trigger_type: {
          type: "string",
          enum: ["threshold", "scheduled", "manual"],
          default: "threshold",
          description: "触发类型",
        },
        observation_threshold: {
          type: "integer",
          default: 30,
          minimum: 10,
          maximum: 100,
          description: "触发反思的观察数量阈值",
        },
        model_size: {
          type: "string",
          enum: ["7b", "14b", "full"],
          default: "7b",
          description: "使用的模型规模",
        },
      },
      required: [],
    },
  },
  {
    name: "import_document",
    description:
      "将外部文档原子性导入记忆库。删除该 source 的旧记录并插入新分块（带 embedding）。支持语义边界分块（按 markdown heading）。用于知识库同步和增量更新。",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description:
            "文档唯一标识，推荐格式：相对路径#段落标识（如 docs/ARCHITECTURE.md#section-3）",
        },
        content: {
          type: "string",
          description: "文档内容（纯文本，将由服务端自动按语义边界分块）",
        },
        session_id: {
          type: "string",
          description: "可选的 session_id，不传则使用默认可用 session",
        },
        overlap: {
          type: "integer",
          default: 100,
          description: "语义边界标识之间的重叠字符数",
        },
        chunk_size: {
          type: "integer",
          default: 1500,
          description: "每个分块的最大字符数",
        },
      },
      required: ["source", "content"],
    },
  },
];

// ── 工具处理器注册表 ──────────────────────────────────
// 新增工具只需：1) 在 TOOLS 加定义  2) 在 TOOL_HANDLERS 加一行

type ToolHandler = (
  args: Record<string, unknown>,
  pool: Pool,
) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  recall_memory: async (args, pool) => {
    if (!args.query) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Missing required parameter: query",
            }),
          },
        ],
        isError: true,
      };
    }
    const result = await recallMemory(
      args as unknown as RecallMemoryInput,
      pool,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  hindsight_reflect: async (args, pool) => {
    if (!args.session_id && !args.omo_task_id && !args.topic_segment_id) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error:
                "Missing required parameter: one of session_id, omo_task_id, or topic_segment_id",
            }),
          },
        ],
        isError: true,
      };
    }
    const result = await hindsightReflect(
      args as unknown as HindsightReflectInput,
      pool,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  import_document: async (args, pool) => {
    if (!args.source || !args.content) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Missing required parameters: source, content",
            }),
          },
        ],
        isError: true,
      };
    }
    const result = await importDocument(
      args as unknown as ImportDocumentInput,
      pool,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
};

async function main() {
  logger.info("Starting server...");

  // 初始化数据库
  let pool: Pool;
  try {
    pool = await initializeDatabase(dbConfig);
    logger.info("Database connected");
  } catch (error) {
    logger.error("Database connection failed", error);
    process.exit(1);
  }

  // 创建 MCP 服务器
  const server = new Server(
    {
      name: "opcode-pg-memory",
      version: "2.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // 处理工具列表请求
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // 处理工具调用请求
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // 验证参数存在
    if (!args) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Missing arguments",
            }),
          },
        ],
        isError: true,
      };
    }

    try {
      const handler = TOOL_HANDLERS[name];
      if (!handler) {
        throw new Error(`Unknown tool: ${name}`);
      }
      return await handler(args as Record<string, unknown>, pool);
    } catch (error) {
      logger.error(`Error calling tool ${name}`, error);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
            }),
          },
        ],
        isError: true,
      };
    }
  });

  // 创建传输层
  const transport = new StdioServerTransport();

  // 连接服务器
  await server.connect(transport);

  logger.info("Server running on stdio");

  // 优雅关闭
  process.on("SIGINT", async () => {
    logger.info("Shutting down...");
    await pool.end();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Shutting down...");
    await pool.end();
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error("Fatal error", error);
  process.exit(1);
});
