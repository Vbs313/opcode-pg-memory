import { createHash } from "node:crypto";
import { Pool } from "pg";
import { handleSessionCompacting } from "../hooks/session-compacting";
import { handleMessagePartUpdated } from "../hooks/message-part-updated";
import {
  handleToolExecuteBefore,
  handleToolExecuteAfter,
  clearSessionCache,
} from "../hooks/tool-execute";
import { createLogger } from "./logger";
import { buildInjectionBlock } from "../injection/system-transform-injector";
import { buildAndWriteSessionSummary } from "../injection/session-summary-writer";
import { estimateTokens } from "../utils/token-budget";
import { clearSession } from "./short-term-memory";
import { detectMemoryKeyword, MEMORY_NUDGE_MESSAGE } from "./keyword";
import { compressOutput } from "./output-compressor";
import { PluginConfig } from "../types";

export interface PluginState {
  pool: Pool;
  config: PluginConfig;
}

export interface HookBuilderContext {
  client?: {
    tui?: {
      showToast?: (input: {
        body: {
          title: string;
          message: string;
          variant: string;
          duration: number;
        };
      }) => Promise<void>;
    };
  };
  project?: {
    name?: string;
  };
}

/**
 * Build the hooks object for the plugin.
 * Includes event, chat.message, tool.execute.before/after,
 * experimental.chat.system.transform, and experimental.session.compacting hooks.
 *
 * Tool definitions are handled separately by tool-registry.ts.
 */
export function buildHooks(state: PluginState, ctx: HookBuilderContext) {
  const { pool, config } = state;
  const logger = createLogger("plugin");

  // Injection pipeline cache — skip PG query if system prompt hash unchanged
  // Key: sessionId, Value: { hash of system prompt, cached injection block }
  const injectionCache = new Map<
    string,
    { systemHash: string; block: string; timestamp: number }
  >();
  const INJECTION_CACHE_TTL_MS = 60_000; // 1 minute

  return {
    // -----------------------------------------------------------------------
    // Unified event hook - receives ALL bus events
    // -----------------------------------------------------------------------
    event: async (input: {
      event: { type: string; properties: Record<string, any> };
    }) => {
      const { type, properties } = input.event;
      try {
        const sid = properties.sessionID || properties.session?.id;

        if (!sid) return;

        // Auto-write session summary when session is compacted
        if (type === "session.compacted") {
          buildAndWriteSessionSummary(
            pool,
            sid,
            ctx.project?.name,
            properties.info?.summary || properties.summary,
          ).catch((err: Error) =>
            logger.warn("Failed to write session summary", err),
          );
        }

        // Clear short-term memory when session is deleted
        if (type === "session.deleted") {
          clearSession(sid);
          clearSessionCache(sid);
        }

        // Route message.part.updated to streaming observation capture
        if (type === "message.part.updated") {
          handleMessagePartUpdated(
            {
              session: { id: sid },
              message: {
                id: properties.messageId || properties.id || "unknown",
                partIndex: properties.partIndex ?? 0,
                content: properties.content || "",
                isComplete: properties.isComplete ?? false,
              },
            },
            {},
            pool,
          ).catch((err: Error) =>
            logger.warn("Failed to handle message.part.updated:", err.message),
          );
        }
      } catch (error) {
        logger.error(`Error handling event '${type}':`, error);
      }
    },

    // -----------------------------------------------------------------------
    // chat.message - inject relevant memories on first message
    // -----------------------------------------------------------------------
    "chat.message": async (
      input: {
        sessionID: string;
        agent?: string;
        model?: { providerID: string; modelID: string };
        messageID?: string;
        variant?: string;
      },
      output: { message: any; parts: any[] },
    ) => {
      try {
        // Note: memory injection is now handled by experimental.chat.system.transform.
        // This hook only provides keyword-based nudges as a lightweight reminder.
        const userText = output.parts
          .filter((p: any) => p.type === "text" && !p.synthetic)
          .map((p: any) => p.text || "")
          .join(" ");

        if (detectMemoryKeyword(userText)) {
          logger.info("Memory keyword detected", {
            sessionID: input.sessionID,
          });
          output.parts.push({
            id: `prt_pgmemory-nudge-${Date.now()}`,
            sessionID: input.sessionID,
            messageID: output.message?.id || input.messageID || "",
            type: "text",
            text: MEMORY_NUDGE_MESSAGE,
            synthetic: true,
          });
        }
      } catch (error) {
        logger.error("Failed to inject memories in chat.message", error);
        // Non-blocking: never crash the message flow
      }
    },

    // -----------------------------------------------------------------------
    // tool.execute.before - intercept before tool execution
    // -----------------------------------------------------------------------
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: any },
    ) => {
      try {
        await handleToolExecuteBefore(
          {
            session: { id: input.sessionID },
            tool: { name: input.tool, parameters: output.args || {} },
            messageId: input.callID,
          },
          { parameters: output.args },
          pool,
        );
      } catch (error) {
        logger.error("Error in tool.execute.before:", error);
      }
    },

    // -----------------------------------------------------------------------
    // tool.execute.after - intercept after tool execution
    // -----------------------------------------------------------------------
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args: any },
      output: { title: string; output: string; metadata: any },
    ) => {
      try {
        // ── Output compression: reduce token consumption ──
        if (output.output) {
          const filePath =
            input.args?.filePath || input.args?.path || undefined;
          const compressed = compressOutput(output.output, {
            toolName: input.tool,
            sessionId: input.sessionID,
            filePath,
          });
          if (compressed) {
            output.output = compressed.compressed;
          }
        }

        const result = {
          success: !(
            output.output && output.output.toLowerCase().includes("error")
          ),
          data: output.output,
          error:
            output.output && output.output.toLowerCase().includes("error")
              ? output.output
              : undefined,
        };

        await handleToolExecuteAfter(
          {
            session: { id: input.sessionID },
            tool: { name: input.tool, parameters: input.args || {} },
            result,
            messageId: input.callID,
            executionTimeMs: output.metadata?.executionTimeMs || 0,
          },
          {} as Record<string, never>,
          pool,
        );
      } catch (error) {
        logger.error("Error in tool.execute.after:", error);
      }
    },

    // -----------------------------------------------------------------------
    // experimental.chat.system.transform - inject memories into system prompt
    //
    // 两路召回 + 混合排序，合并到 output.system[0]（而非 push 新条目）。
    // 参考：https://github.com/anomalyco/opencode/issues/23660
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (
      input: {
        sessionID?: string;
        model: { id: string; contextLimit: number; name: string };
      },
      output: { system: string[] },
    ) => {
      try {
        const sessionId = input.sessionID || "default";
        const systemContent = output.system?.[0] || "";
        if (!systemContent) return;

        // Read config for token budget
        const contextLimit = input.model?.contextLimit || 128000;
        const budgetMax = Math.min(
          Math.max(Math.floor(contextLimit * 0.02), 500),
          3000,
        );

        // ── Injection cache: skip PG query if system prompt hash unchanged ──
        const systemHash = createHash("md5")
          .update(systemContent)
          .digest("hex");
        const cached = injectionCache.get(sessionId);
        if (
          cached &&
          cached.systemHash === systemHash &&
          Date.now() - cached.timestamp < INJECTION_CACHE_TTL_MS
        ) {
          if (cached.block) {
            output.system[0] = systemContent + "\n\n" + cached.block;
          }
          return; // Skip PG query entirely
        }

        // Build memory injection block (two-path recall + hybrid scoring)
        const injectionBlock = await buildInjectionBlock(
          {
            systemPrompt: systemContent,
            sessionId,
            contextLimit,
            project: ctx.project?.name,
            platformSource: "opencode",
          },
          pool,
          {
            maxTokens: budgetMax,
            minScore: 0.3,
            keywordLimit: 20,
            semanticLimit: 20,
            dedupPrefixLength: 100,
            weights: [0.5, 0.3, 0.2],
            recencyHalfLifeDays: 2,
          },
        );

        // Update cache
        injectionCache.set(sessionId, {
          systemHash,
          block: injectionBlock,
          timestamp: Date.now(),
        });

        if (injectionBlock) {
          // Merge into the PRIMARY system block — NOT push a new entry.
          output.system[0] = systemContent + "\n\n" + injectionBlock;

          // Evict stale cache entries (keep under 50)
          if (injectionCache.size > 50) {
            const oldest = [...injectionCache.entries()].sort(
              ([, a], [, b]) => a.timestamp - b.timestamp,
            )[0];
            if (oldest) injectionCache.delete(oldest[0]);
          }

          logger.info(
            `Injected ${estimateTokens(injectionBlock)} tokens of memory context`,
            { sessionID: sessionId },
          );
        }
      } catch (error) {
        logger.error("Error in system.transform injection:", error);
        // Non-blocking: never crash the LLM request
      }
    },

    // -----------------------------------------------------------------------
    // experimental.session.compacting - session compaction hook
    // -----------------------------------------------------------------------
    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: { context: string[]; prompt?: string },
    ) => {
      try {
        // Show compaction notification
        if (ctx.client?.tui?.showToast) {
          ctx.client.tui
            .showToast({
              body: {
                title: "PG Memory Compaction",
                message: "Compacting with pg-memory context...",
                variant: "warning",
                duration: 3000,
              },
            })
            .catch(() => {});
        }

        await handleSessionCompacting(
          {
            session: { id: input.sessionID },
            messagesToCompact: output.context || [],
            compactionStrategy: "prune",
          },
          { preserveMessageIds: [] },
          pool,
        );

        // Show success toast
        if (ctx.client?.tui?.showToast) {
          const showToast = ctx.client.tui.showToast;
          setTimeout(() => {
            showToast({
              body: {
                title: "Compaction Complete",
                message: "PG Memory preserved high-value observations",
                variant: "success",
                duration: 2000,
              },
            }).catch(() => {});
          }, 500);
        }
      } catch (error) {
        logger.error("Error in experimental.session.compacting:", error);
      }
    },
  };
}
