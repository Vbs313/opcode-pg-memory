import { createLogger } from "../logger";
import { detectMemoryKeyword, MEMORY_NUDGE_MESSAGE } from "../keyword";

/**
 * Build the chat.message hook handler.
 * Detects memory keywords in user messages and injects a nudge
 * as a lightweight reminder that pg-memory is available.
 */
export function buildChatHooks(logger: ReturnType<typeof createLogger>) {
  return {
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
  };
}
