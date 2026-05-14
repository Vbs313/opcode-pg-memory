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
import {
  applyReflection,
  ApplyReflectionInput,
} from "./src/mcp/apply-reflection";
import { reviewRules, ReviewRulesInput } from "./src/mcp/review-rules";
import { getMemory, GetMemoryInput } from "./src/mcp/get-memory";
import { getTimeline, TimelineInput } from "./src/mcp/timeline";
import { deleteMemory, DeleteMemoryInput } from "./src/mcp/delete-memory";
import {
  buildCorpus,
  queryCorpus,
  listCorpora,
  rebuildCorpus,
  deleteCorpus,
  primeCorpus,
  reprimeCorpus,
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
import { getDatabaseConfig } from "./src/config";
import {
  searchNetwork,
  NetworkSearchInput,
  NetworkSearchOutput,
} from "./src/mcp/network-search";
import {
  getTopReputationSkills,
  ReputationScore,
} from "./src/services/skill-reputation";
import {
  RECALL_MEMORY_DESCRIPTION,
  RECALL_MEMORY_ARGS,
  HINDSIGHT_REFLECT_DESCRIPTION,
  HINDSIGHT_REFLECT_ARGS,
} from "./src/services/tool-registry";

const logger = createLogger("mcp-server");

// 配置加载：通过 config 模块（4 层合并：env → settings.json → file → 默认值）
const dbConfig = getDatabaseConfig();

// 工具定义
const TOOLS: Tool[] = [
  {
    name: "recall_memory",
    description: RECALL_MEMORY_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: RECALL_MEMORY_ARGS,
      required: ["query"],
    },
  },
  {
    name: "hindsight_reflect",
    description: HINDSIGHT_REFLECT_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: HINDSIGHT_REFLECT_ARGS,
      required: [],
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
    name: "prime_corpus",
    description:
      "Fetch corpus entries as formatted text for injection into current session context.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Corpus name to prime" },
        max_items: { type: "number", default: 10, description: "Max entries" },
      },
      required: ["name"],
    },
  },
  {
    name: "reprime_corpus",
    description:
      "Rebuild then prime a corpus (refresh entries before injecting).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Corpus name to reprime" },
        max_items: { type: "number", default: 10, description: "Max entries" },
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
  {
    name: "apply_reflection",
    description:
      "将 hindsight_reflect 产出的可执行模式写入 rules.md，使 Agent 自动遵守。接收 pattern_id，检查 action_plan，追加到 ~/.config/opencode/rules.md，标记 applied_at。幂等操作，同类 pattern 7 天冷却期。",
    inputSchema: {
      type: "object",
      properties: {
        pattern_id: {
          type: "string",
          description:
            "reflections 表的 UUID，来自 hindsight_reflect 输出中的 id 字段",
        },
      },
      required: ["pattern_id"],
    },
  },
  {
    name: "review_rules",
    description:
      "列出所有已应用的规则及其有效性（应用后的错误计数）。支持按 pattern_type 过滤。",
    inputSchema: {
      type: "object",
      properties: {
        pattern_type: {
          type: "string",
          description:
            "可选：按模式类型过滤（error_pattern, workflow, tool_preference 等）",
        },
        include_archived: {
          type: "boolean",
          description: "是否包含 90 天前的归档规则",
        },
        limit: {
          type: "number",
          default: 50,
          description: "返回上限",
        },
      },
    },
  },
  {
    name: "search_network",
    description:
      "v4.0 联邦式认知网络检索 — 跨项目搜索技能、记忆和知识图谱实体。返回结果附带声誉评分。scope: skills/memories/entities/all",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索查询文本",
        },
        scope: {
          type: "string",
          enum: ["skills", "memories", "entities", "all"],
          default: "all",
          description: "搜索范围",
        },
        min_reputation: {
          type: "number",
          default: 0,
          description: "最低声誉评分阈值 (0-10)",
        },
        max_results: {
          type: "number",
          default: 20,
          description: "最大返回结果数",
        },
        exclude_project_id: {
          type: "string",
          description: "排除指定项目 ID",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "skill_reputation",
    description:
      "v4.0 技能声誉排行 — 列出跨项目技能声誉评分，按综合声誉降序。声誉 = 成功率×0.5 + 采用率×0.3 + 近度×0.2",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          default: 20,
          description: "返回上限",
        },
        min_reputation: {
          type: "number",
          default: 0,
          description: "最低声誉评分",
        },
      },
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

  prime_corpus: async (args, pool) => {
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
    const result = await primeCorpus(
      args as unknown as { name: string; max_items?: number },
      pool,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  reprime_corpus: async (args, pool) => {
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
    const result = await reprimeCorpus(
      args as unknown as { name: string; max_items?: number },
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

  apply_reflection: async (args, pool) => {
    if (!args.pattern_id) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              applied: false,
              error: "Missing pattern_id",
            }),
          },
        ],
        isError: true,
      };
    }
    const result = await applyReflection(
      args as unknown as ApplyReflectionInput,
      pool,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  review_rules: async (args, pool) => {
    const result = await reviewRules(args as unknown as ReviewRulesInput, pool);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  // v4.0: 联邦式网络检索
  search_network: async (args, pool) => {
    const result = await searchNetwork(
      args as unknown as NetworkSearchInput,
      pool,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  // v4.0: 技能声誉排行
  skill_reputation: async (_args, pool) => {
    const skills = await getTopReputationSkills(pool, { limit: 20 });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: true, skills }, null, 2),
        },
      ],
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
  pool: Pool | null,
  port: number,
): Promise<http.Server> {
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    try {
      // ── Health check ──
      if (req.method === "GET" && pathname === "/health") {
        let dbOk = false;
        if (pool) {
          try {
            await pool.query("SELECT 1");
            dbOk = true;
          } catch {
            dbOk = false;
          }
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

  // 初始化数据库（graceful fallback: 失败时仍启动，工具返回错误）
  let pool: Pool | null = null;
  let dbReady = false;
  try {
    pool = await initializeDatabase(dbConfig);
    dbReady = true;
    logger.info("Database connected");
  } catch (error) {
    logger.warn(
      "Database unavailable — tools return errors until PG is back",
      error,
    );
  }

  // 创建 MCP 服务器
  const server = new Server(
    {
      name: "opcode-pg-memory",
      version: "3.2.0",
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

    // Helper: normalize tool response to { success, data/error } MCP format
    const respond = (result: unknown, isError = false) => ({
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      ...(isError ? { isError: true } : {}),
    });

    // DB not ready — all tools return the same error
    if (!dbReady || !pool) {
      return respond(
        {
          success: false,
          error: "Database unavailable — check PostgreSQL connection",
        },
        true,
      );
    }

    if (!args) {
      return respond({ success: false, error: "Missing arguments" }, true);
    }

    try {
      const handler = TOOL_HANDLERS[name];
      if (!handler) throw new Error(`Unknown tool: ${name}`);
      const result = await handler(args as Record<string, unknown>, pool);
      // Normalize: wrap bare returns in { success: true, data }
      if (result && typeof result === "object" && "success" in result) {
        return respond(result);
      }
      return respond({ success: true, data: result });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      logger.error(`ERROR: ${msg}`);
      return respond(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        true,
      );
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
    // 2. Drain database pool (if initialized)
    if (pool) {
      await pool.end().catch(() => {});
    }
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
