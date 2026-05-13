/**
 * entity-store.ts — 实体与关系的持久化存储
 *
 * 职责：
 * - upsertEntity: 按 session_map_id + name + type 去重写入 entities 表
 * - upsertRelation: 按 source + target + relation_type 去重写入 relations 表
 *
 * 与 message-updated.ts 的区别：
 * - message-updated 从用户消息中提取实体（命名实体识别）
 * - 本模块从工具输出中提取实体（文件路径、符号、模块依赖）
 */

import { Pool, PoolClient } from "pg";
import { createLogger } from "./logger";

const logger = createLogger("entity-store");

export interface EntitySeed {
  name: string;
  type:
    | "file"
    | "function"
    | "class"
    | "interface"
    | "module"
    | "tool"
    | "type"
    | "enum";
  /** 默认 1.0，同一实体多次出现自动递增，上限 10 */
  weight?: number;
  description?: string;
}

export interface RelationSeed {
  sourceName: string;
  sourceType: string;
  targetName: string;
  targetType: string;
  /** 必须匹配 PostgreSQL relation_type 枚举 */
  relationType:
    | "references"
    | "depends_on"
    | "implements"
    | "uses"
    | "belongs_to"
    | "custom";
  description?: string;
}

/**
 * 批量写入实体和关系。
 * 所有操作在同一事务中，失败整批回滚。
 */
export async function storeEntitiesAndRelations(
  seeds: { entities: EntitySeed[]; relations: RelationSeed[] },
  sessionMapId: string,
  pool: Pool,
): Promise<void> {
  if (seeds.entities.length === 0 && seeds.relations.length === 0) return;

  // 非真实 pool（mock/testing）则静默跳过
  if (typeof (pool as any).connect !== "function") return;

  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // 1. 写入实体（去重：session_map_id + name + type）
    const nameToId = new Map<string, string>();
    for (const seed of seeds.entities) {
      const id = await upsertEntity(client, seed, sessionMapId);
      if (id) nameToId.set(`${seed.name}:${seed.type}`, id);
    }

    // 2. 写入关系（需要实体已存在）
    for (const rel of seeds.relations) {
      const srcKey = `${rel.sourceName}:${rel.sourceType}`;
      const tgtKey = `${rel.targetName}:${rel.targetType}`;
      const srcId = nameToId.get(srcKey);
      const tgtId = nameToId.get(tgtKey);
      if (srcId && tgtId) {
        await upsertRelation(client, srcId, tgtId, rel, sessionMapId);
      }
    }

    // client 在 try 块开始时已被 pool.connect() 赋值，此处不可能为 undefined
    await client!.query("COMMIT");
  } catch (error) {
    if (client) await client!.query("ROLLBACK").catch(() => {});
    logger.warn("Entity store transaction failed:", error);
  } finally {
    if (client && typeof client.release === "function") client.release();
  }
}

async function upsertEntity(
  client: PoolClient,
  seed: EntitySeed,
  sessionMapId: string,
): Promise<string | null> {
  const weight = seed.weight ?? 1.0;
  const tier =
    seed.type === "file"
      ? "project"
      : ["function", "class", "interface", "module", "type", "enum"].includes(
            seed.type,
          )
        ? "project"
        : "session";
  const description = seed.description || `${seed.type}: ${seed.name}`;

  try {
    // 乐观 INSERT — 数据库唯一约束防重复
    const result = await client.query(
      `INSERT INTO entities
       (session_map_id, name, type, tier, weight, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        sessionMapId,
        seed.name,
        seed.type,
        tier,
        weight,
        description,
        JSON.stringify({ source: "tool-execute" }),
      ],
    );
    return result.rows[0].id;
  } catch (error: any) {
    // 23505 = unique_violation (PG 错误码)
    if (error?.code === "23505") {
      try {
        await client.query(
          `UPDATE entities
           SET weight = LEAST(weight + $1, 10.0),
               last_seen_at = NOW()
           WHERE name = $2 AND type = $3
             AND session_map_id IS NOT DISTINCT FROM $4`,
          [weight, seed.name, seed.type, sessionMapId],
        );
        // 返回已存在实体的 ID
        const existing = await client.query(
          `SELECT id FROM entities
           WHERE name = $1 AND type = $2
             AND session_map_id IS NOT DISTINCT FROM $3`,
          [seed.name, seed.type, sessionMapId],
        );
        return existing.rows[0]?.id ?? null;
      } catch (updateErr) {
        logger.warn(
          `Failed to update existing entity ${seed.name}:`,
          updateErr,
        );
        return null;
      }
    }
    logger.warn(`Failed to upsert entity ${seed.name}:`, error);
    return null;
  }
}

async function upsertRelation(
  client: PoolClient,
  sourceId: string,
  targetId: string,
  seed: RelationSeed,
  sessionMapId: string,
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO relations
       (source_entity_id, target_entity_id, relation_type, description, session_map_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        sourceId,
        targetId,
        seed.relationType,
        seed.description || seed.relationType,
        sessionMapId,
      ],
    );
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as any).code === "23505"
    ) {
      // 已存在 — 增加置信度（限同 session 范围）
      await client.query(
        `UPDATE relations SET confidence = LEAST(confidence + 0.1, 1.0)
         WHERE source_entity_id = $1 AND target_entity_id = $2 AND relation_type = $3
           AND session_map_id IS NOT DISTINCT FROM $4`,
        [sourceId, targetId, seed.relationType, sessionMapId],
      );
      return;
    }
    logger.warn(`Failed to upsert relation ${seed.relationType}:`, error);
  }
}
