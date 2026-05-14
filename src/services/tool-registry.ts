import { Pool } from "pg";
import { recallMemory, RecallMemoryInput } from "../mcp/recall-memory";
import { hindsightReflect } from "../mcp/hindsight-reflect";
import { syncHealth, SyncHealthInput } from "../mcp/sync-health";
import {
  backfillEmbeddings,
  BackfillEmbeddingsInput,
} from "../mcp/backfill-embeddings";
import { PluginConfig, HindsightReflectInput } from "../types";

export interface PluginState {
  pool: Pool;
  config: PluginConfig;
}

/**
 * Build the tool definitions map for the plugin.
 * Returns the { recall_memory, hindsight_reflect, sync_health, backfill_embeddings } object
 * that goes under the `tool` key in the hooks object.
 */
export function buildTools(state: PluginState) {
  const { pool, config } = state;

  return {
    recall_memory: {
      description:
        "从长期记忆中检索相关事实、实体、观察和反思，支持多策略并行检索（语义+BM25+图遍历）。使用多维评分函数：Relevance = 0.5*SemSim + 0.3/(1+RecencyDays) + 0.2*Importance",
      args: {
        query: {
          type: "string",
          description: "检索查询文本",
        },
        session_id: {
          type: "string",
          description: "当前会话ID，用于上下文过滤",
        },
        scope: {
          type: "string",
          enum: ["session", "task", "project"],
          default: "session",
          description:
            "检索范围：session=当前会话, task=同任务所有会话, project=同项目所有会话",
        },
        aggregate_similar: {
          type: "boolean",
          default: false,
          description:
            '为true时，连续的同名工具调用合并为一条摘要（如 "read ×47 最近读取了..."）',
        },
        retrieval_strategies: {
          type: "array",
          items: {
            type: "string",
            enum: ["semantic", "bm25", "graph", "keyword"],
          },
          default: ["semantic", "bm25", "graph"],
          description: "检索策略组合",
        },
        max_results: {
          type: "number",
          minimum: 1,
          maximum: 50,
          default: 10,
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
              type: "number",
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
      execute: async (
        args: RecallMemoryInput,
        _context: { client: any; sessionID?: string },
      ) => {
        return recallMemory(args, pool, {
          maxResults: config.retrieval.maxResults,
          rerankEnabled: config.retrieval.rerankEnabled,
          weights: config.retrieval.weights,
        });
      },
    },

    hindsight_reflect: {
      description:
        "对会话观察进行反思，归纳经验模式，生成可复用的反思记录。每30-50条经验触发一次，使用7B蒸馏模型在低峰期执行。",
      args: {
        session_id: {
          type: "string",
          description: "要反思的会话ID",
        },
        trigger_type: {
          type: "string",
          enum: ["threshold", "scheduled", "manual"],
          default: "threshold",
          description: "触发类型",
        },
        observation_threshold: {
          type: "number",
          minimum: 10,
          maximum: 100,
          default: 30,
          description: "触发反思的观察数量阈值",
        },
        model_size: {
          type: "string",
          enum: ["7b", "14b", "full"],
          default: "7b",
          description: "使用的模型规模",
        },
      },
      execute: async (
        args: HindsightReflectInput,
        _context: { client: any; sessionID?: string },
      ) => {
        return hindsightReflect(args, pool, {
          observationThreshold: config.reflection.observationThreshold,
          modelSize: config.reflection.modelSize as "7b" | "14b" | "full",
          offPeakHours: config.reflection.offPeakHours,
        });
      },
    },

    sync_health: {
      description:
        "返回插件同步健康状态：observation 数量、embedding 覆盖率、embedder 队列状态",
      args: {},
      execute: async (
        args: SyncHealthInput,
        _context: { client: any; sessionID?: string },
      ) => {
        return syncHealth(args, pool);
      },
    },

    backfill_embeddings: {
      description:
        "回填缺失的 embedding：将 embedding IS NULL 且 importance >= 3 的 observation 喂入 AsyncEmbedder 队列",
      args: {
        limit: {
          type: "number",
          default: 0,
          description: "限制处理条数，0=全量",
        },
      },
      execute: async (
        args: BackfillEmbeddingsInput,
        _context: { client: any; sessionID?: string },
      ) => {
        return backfillEmbeddings(args, pool);
      },
    },
  };
}
