import { Pool } from "pg";
import {
  handleToolExecuteBefore,
  handleToolExecuteAfter,
} from "../../hooks/tool-execute";
import { createLogger } from "../logger";
import { compressOutput } from "../output-compressor";

/**
 * Build the tool.execute.before and tool.execute.after hook handlers.
 * Handles output compression, entity extraction, and short-term memory.
 */
export function buildToolHooks(
  pool: Pool,
  logger: ReturnType<typeof createLogger>,
) {
  return {
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
  };
}
