#!/usr/bin/env node

/**
 * MCP Server for OpenCode PG Memory Plugin
 *
 * Supports two transport modes:
 *   1. stdio (default) — used by OpenCode, Cursor, Windsurf MCP configs
 *   2. sse (standalone) — `opcode-pg-memory mcp start --port 37777`
 *      for background daemon mode
 *
 * Tools: recall_memory, hindsight_reflect, import_document, sync_health, backfill_embeddings
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import http from "http";
import { Pool } from "pg";
import { initializeDatabase } from "./src/db/init-db";
import { recallMemory, RecallMemoryInput } from "./src/mcp/recall-memory";
import {
  hindsightReflect,
  HindsightReflectInput,
} from "./src/mcp/hindsight-reflect";
import { importDocument, ImportDocumentInput } from "./src/mcp/import-document";
import { getMemory, GetMemoryInput } from "./src/mcp/get-memory";
import { getTimeline, TimelineInput } from "./src/mcp/timeline";
import { deleteMemory, DeleteMemoryInput } from "./src/mcp/delete-memory";
import {
  buildCorpus,
  queryCorpus,
  listCorpora,
  rebuildCorpus,
  deleteCorpus,
} from "./src/mcp/knowledge-corpus";
import type {
  BuildCorpusInput,
  QueryCorpusInput,
} from "./src/mcp/knowledge-corpus";
import {
  startSession,
  logMessage,
  endSession,
  searchSessions,
} from "./src/mcp/session-logger";
import type {
  StartSessionInput,
  LogMessageInput,
  EndSessionInput,
  SearchSessionsInput,
} from "./src/mcp/session-logger";
import { createLogger } from "./src/services/logger";
import { classifyError } from "./src/utils/error-classifier";
import { getDatabaseConfig } from "./src/config";

const logger = createLogger("mcp-server");

// 配置加载：通过 config 模块（4 层合并：env → settings.json → file → 默认值）
const dbConfig = getDatabaseConfig();

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
  // ── New v3.0 tools ────────────────────────────────────
  {
    name: "get_memory",
    description:
      "Fetch a single memory by ID with full details. Supports observations, reflections, and entities.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory UUID" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_memory",
    description:
      "Delete a specific memory by ID. Privacy tool for removing sensitive or incorrect memories.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory UUID to delete" },
        type: {
          type: "string",
          enum: ["observation", "reflection", "entity"],
          description: "Memory type hint",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "timeline",
    description:
      "Fetch a single memory by ID with full details. Supports observations, reflections, and entities.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Memory UUID from observations, reflections, or entities table",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "timeline",
    description:
      "Get chronological timeline around a specific memory. Returns observations before and after the anchor point.",
    inputSchema: {
      type: "object",
      properties: {
        anchor_id: {
          type: "string",
          description: "Memory ID to center the timeline around",
        },
        depth_before: {
          type: "number",
          default: 3,
          description: "Items before anchor (max 10)",
        },
        depth_after: {
          type: "number",
          default: 3,
          description: "Items after anchor (max 10)",
        },
        project: { type: "string", description: "Filter by project" },
      },
      required: ["anchor_id"],
    },
  },
  {
    name: "build_corpus",
    description:
      "Build a named knowledge corpus from matching observations. A corpus can be queried and primed for injection.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique corpus name" },
        query: {
          type: "string",
          description: "Free-text filter applied to observation content",
        },
        project: { type: "string", description: "Filter by project" },
        platform: { type: "string", description: "Filter by platform source" },
        min_importance: {
          type: "number",
          default: 1,
          description: "Minimum importance (1-5)",
        },
        max_results: {
          type: "number",
          default: 100,
          description: "Max corpus size",
        },
        description: { type: "string", description: "Optional description" },
      },
      required: ["name"],
    },
  },
  {
    name: "query_corpus",
    description: "Search within a built knowledge corpus.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Corpus name" },
        query: { type: "string", description: "Search query" },
        limit: { type: "number", default: 10, description: "Max results" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_corpora",
    description: "List all named knowledge corpora with entry counts.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "rebuild_corpus",
    description:
      "Rebuild a corpus by re-running its original filter query to refresh entries.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Corpus name to rebuild" },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_corpus",
    description: "Delete a named corpus and all its entries.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Corpus name to delete" },
      },
      required: ["name"],
    },
  },
  {
    name: "start_session",
    description:
      "Start a new named session for activity logging. Returns a session_id for use with log_message and end_session.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Optional session name" },
        project: { type: "string", description: "Project identifier" },
      },
      required: [],
    },
  },
  {
    name: "log_message",
    description:
      "Log a message (user or agent) to an active session. Requires a session_id from start_session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session ID from start_session",
        },
        role: {
          type: "string",
          enum: ["user", "agent"],
          description: "Message role",
        },
        content: { type: "string", description: "Message content" },
      },
      required: ["session_id", "content"],
    },
  },
  {
    name: "end_session",
    description:
      "End a session with optional summary. Saves what was learned for future reference.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session ID from start_session",
        },
        summary: { type: "string", description: "What was accomplished" },
        learned: { type: "string", description: "What was learned" },
        next_steps: { type: "string", description: "Next steps" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "search_sessions",
    description:
      "Search across all logged sessions. Finds sessions by content in summaries, learnings, and next steps.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: {
          type: "number",
          default: 10,
          description: "Max results (max 50)",
        },
      },
      required: ["query"],
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

  // ── New v3.0 tools ──────────────────────────────────────

  get_memory: async (args, pool) => {
    if (!args.id) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: "Missing id" }),
          },
        ],
        isError: true,
      };
    }
    const result = await getMemory(args as unknown as GetMemoryInput, pool);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result ?? { error: "Not found" }, null, 2),
        },
      ],
    };
  },

  timeline: async (args, pool) => {
    if (!args.anchor_id) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Missing anchor_id",
            }),
          },
        ],
        isError: true,
      };
    }
    const result = await getTimeline(args as unknown as TimelineInput, pool);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  delete_memory: async (args, pool) => {
    if (!args.id) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: "Missing id" }),
          },
        ],
        isError: true,
      };
    }
    const result = await deleteMemory(
      args as unknown as DeleteMemoryInput,
      pool,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  build_corpus: async (args, pool) => {
    if (!args.name) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: "Missing name" }),
          },
        ],
        isError: true,
      };
    }
    const result = await buildCorpus(args as unknown as BuildCorpusInput, pool);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  query_corpus: async (args, pool) => {
    if (!args.name) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Missing name",
            }),
          },
        ],
        isError: true,
      };
    }
    const result = await queryCorpus(args as unknown as QueryCorpusInput, pool);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  list_corpora: async (_args, pool) => {
    const result = await listCorpora(pool);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  rebuild_corpus: async (args, pool) => {
    if (!args.name) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: "Missing name" }),
          },
        ],
        isError: true,
      };
    }
    const result = await rebuildCorpus(
      args as unknown as { name: string },
      pool,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  delete_corpus: async (args, pool) => {
    if (!args.name) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: "Missing name" }),
          },
        ],
        isError: true,
      };
    }
    const result = await deleteCorpus(
      args as unknown as { name: string },
      pool,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  start_session: async (args, pool) => {
    const result = await startSession(
      args as unknown as StartSessionInput,
      pool,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  log_message: async (args, pool) => {
    if (!args.session_id || !args.content) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Missing session_id or content",
            }),
          },
        ],
        isError: true,
      };
    }
    const result = await logMessage(args as unknown as LogMessageInput, pool);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  end_session: async (args, pool) => {
    if (!args.session_id) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Missing session_id",
            }),
          },
        ],
        isError: true,
      };
    }
    const result = await endSession(args as unknown as EndSessionInput, pool);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  search_sessions: async (args, pool) => {
    const result = await searchSessions(
      args as unknown as SearchSessionsInput,
      pool,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
};

// ── SSE Transport Helpers ──────────────────────────────────
// Session ID → SSEServerTransport mapping for routing POST requests

const sseTransports = new Map<string, SSEServerTransport>();
const startTime = Date.now();

/**
 * Create and start an HTTP server with SSE transport.
 * MCP clients connect via GET /sse, then POST /sse/{sessionId} for messages.
 * Health check at GET /health.
 */
async function startSSEServer(
  server: Server,
  pool: Pool,
  port: number,
): Promise<http.Server> {
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    try {
      // ── Health check ──
      if (req.method === "GET" && pathname === "/health") {
        let dbOk = false;
        try {
          await pool.query("SELECT 1");
          dbOk = true;
        } catch {
          dbOk = false;
        }
        const health = {
          status: dbOk ? "healthy" : "degraded",
          db: dbOk ? "connected" : "disconnected",
          uptime: Math.floor((Date.now() - startTime) / 1000),
          transports: sseTransports.size,
        };
        res.writeHead(dbOk ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify(health));
        return;
      }

      // ── SSE stream ──
      if (req.method === "GET" && pathname === "/sse") {
        const transport = new SSEServerTransport("/sse/message", res);
        sseTransports.set(transport.sessionId, transport);
        res.on("close", () => {
          sseTransports.delete(transport.sessionId);
        });
        await server.connect(transport);
        return;
      }

      // ── Client POST messages ──
      if (req.method === "POST" && pathname.startsWith("/sse/message/")) {
        const sessionId = pathname.split("/").pop() || "";
        const transport = sseTransports.get(sessionId);
        if (!transport) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Session not found" }));
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    } catch (error) {
      logger.error("SSE server error", error);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal server error");
      }
    }
  });

  return new Promise<http.Server>((resolve) => {
    httpServer.listen(port, "127.0.0.1", () => {
      logger.info(`SSE server listening on http://127.0.0.1:${port}/sse`);
      resolve(httpServer);
    });
  });
}

async function main() {
  // Parse CLI flags: --transport sse|stdio (default: stdio), --port N (default: 37777)
  const transportIdx = process.argv.indexOf("--transport");
  const transportMode = (process.argv
    .find((a) => a.startsWith("--transport="))
    ?.split("=")[1] ||
    (transportIdx !== -1 ? process.argv[transportIdx + 1] : undefined) ||
    "stdio") as "stdio" | "sse";
  const portIdx = process.argv.indexOf("--port");
  const port = parseInt(
    process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ||
      (portIdx !== -1 ? process.argv[portIdx + 1] : undefined) ||
      "37777",
    10,
  );

  logger.info(`Starting MCP server (transport: ${transportMode})...`);

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
      if (!handler) throw new Error(`Unknown tool: ${name}`);
      return await handler(args as Record<string, unknown>, pool);
    } catch (error) {
      const classified = classifyError(error);
      logger.error(
        `${classified.severity.toUpperCase()} [${classified.category}] ${classified.message}`,
      );
      if (classified.suggestion) logger.info(`→ ${classified.suggestion}`);
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

  // ── Connect transport ──
  let httpServer: http.Server | undefined;
  if (transportMode === "sse") {
    httpServer = await startSSEServer(server, pool, port);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("Server running on stdio");
  }

  // ── Graceful shutdown ──
  const shutdown = async () => {
    logger.info("Shutting down...");
    // 1. Stop accepting new connections
    if (httpServer) {
      httpServer.close();
    }
    server.close();
    // 2. Drain database pool
    await pool.end().catch(() => {});
    logger.info("Shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  logger.error("Fatal error", error);
  process.exit(1);
});
