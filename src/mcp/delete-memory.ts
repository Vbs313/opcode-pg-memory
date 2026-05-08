/**
 * delete-memory.ts
 *
 * Delete specific memories by ID. Supports observations, reflections, and entities.
 * Privacy/hygiene tool — allows users to remove sensitive or incorrect memories.
 */

import { Pool } from "pg";
import { createLogger } from "../services/logger";

const logger = createLogger("delete-memory");

export interface DeleteMemoryInput {
  /** Memory ID to delete */
  id: string;
  /** Memory type hint. If not provided, tries all types. */
  type?: "observation" | "reflection" | "entity";
}

export async function deleteMemory(
  input: DeleteMemoryInput,
  pool: Pool,
): Promise<{ deleted: boolean; type?: string }> {
  const { id, type } = input;

  try {
    if (type === "observation" || !type) {
      const result = await pool.query(
        "DELETE FROM observations WHERE id = $1",
        [id],
      );
      if (result.rowCount && result.rowCount > 0) {
        logger.info(`Deleted observation: ${id}`);
        return { deleted: true, type: "observation" };
      }
    }

    if (type === "reflection" || !type) {
      const result = await pool.query("DELETE FROM reflections WHERE id = $1", [
        id,
      ]);
      if (result.rowCount && result.rowCount > 0) {
        logger.info(`Deleted reflection: ${id}`);
        return { deleted: true, type: "reflection" };
      }
    }

    if (type === "entity" || !type) {
      const result = await pool.query("DELETE FROM entities WHERE id = $1", [
        id,
      ]);
      if (result.rowCount && result.rowCount > 0) {
        logger.info(`Deleted entity: ${id}`);
        return { deleted: true, type: "entity" };
      }
    }

    return { deleted: false };
  } catch (error) {
    logger.error("Failed to delete memory", error);
    return { deleted: false };
  }
}
