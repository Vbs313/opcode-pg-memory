import { Pool } from "pg";
import { PluginConfig } from "../types";
import { createLogger } from "./logger";
import { buildChatHooks } from "./hooks/chat-hooks";
import { buildToolHooks } from "./hooks/tool-hooks";
import { buildSessionHooks, SessionHookContext } from "./hooks/session-hooks";

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
 * Delegates to chat, tool, and session sub-modules.
 */
export function buildHooks(state: PluginState, ctx: HookBuilderContext) {
  const { pool, config: _config } = state;
  const logger = createLogger("plugin");

  return {
    ...buildSessionHooks(pool, ctx, logger),
    ...buildChatHooks(logger),
    ...buildToolHooks(pool, logger),
  };
}
