import { Pool } from "pg";
import { initAsyncEmbedder } from "./async-embedder";
import { setPool } from "./memory-buffer";
import { createLogger } from "./logger";

/**
 * Initialize plugin services after database connection is established.
 * Sets up async embedder, cleanup handlers, and memory buffer.
 *
 * @param pool - Active database pool
 * @param onClose - Optional cleanup callback called on process exit/SIGINT/SIGTERM
 */
export function initializeServices(
  pool: Pool,
  onClose?: () => Promise<void>,
): void {
  const logger = createLogger("plugin");

  // Initialize async embedder for observations
  initAsyncEmbedder(pool, {
    cooldownMs: parseInt(process.env.PG_MEMORY_EMBED_COOLDOWN || "300000"),
    minImportance: parseInt(process.env.PG_MEMORY_EMBED_MIN_IMPORTANCE || "3"),
  });

  // Cleanup on process exit
  if (onClose) {
    const cleanup = () => {
      onClose().catch((err) => logger.error("Cleanup error:", err));
    };
    process.on("exit", cleanup);
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }

  // Initialize memory buffer with pool reference
  setPool(pool);

  logger.info("Plugin services initialized (async embedder, memory buffer)");
}
