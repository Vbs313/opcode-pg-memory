/**
 * skill-reputation.ts — 跨项目技能声誉评分引擎 (v4.0)
 *
 * 参考模式:
 *   - Membrane: reinforce/penalize + decay (GitHub: membr-ai/membrane)
 *   - GrapeRank: weighted average with ceiling (GitHub: Pretty-Good-Freedom-Tech/graperank)
 *   - chat-knowledge: usage + validation + specificity 三信号评估
 *
 * 评分公式:
 *   rawScore = successRate × 0.5 + adoptionRate × 0.3 + recencyBoost × 0.2
 *   reputation = rawScore × log₁₀(migrationCount + 1)
 *
 * 维度:
 *   - successRate: 目标项目中有效使用的比例
 *   - adoptionRate: 被多少个不同项目采用
 *   - recencyBoost: 最近使用时间加权
 *   - migrationCount: 跨项目迁移次数（对数缩放防通胀）
 */

import { Pool } from "pg";
import { createLogger } from "./logger";

const logger = createLogger("skill-reputation");

// ── 类型 ──────────────────────────────────────────────

export interface ReputationScore {
  skill_name: string;
  reputation: number; // 综合声誉 0-10
  success_rate: number; // 成功率 0-1
  migration_count: number; // 跨项目迁移次数
  project_count: number; // 被多少不同项目采用
  last_used_at: string | null;
  effectiveness: string; // active | declining | deprecated
}

export interface ReputationEvent {
  skill_name: string;
  event_type: "migration" | "success" | "failure" | "deprecation";
  source_project_id: string;
  target_project_id?: string;
  metadata?: Record<string, unknown>;
}

// ── 表结构 ──────────────────────────────────────────

async function ensureReputationTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS skill_reputation (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      skill_name TEXT NOT NULL,
      source_project_id TEXT NOT NULL,
      target_project_id TEXT,
      event_type TEXT NOT NULL,
      event_at TIMESTAMPTZ DEFAULT NOW(),
      metadata JSONB DEFAULT '{}'
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_skill_reputation_name
    ON skill_reputation (skill_name)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_skill_reputation_project
    ON skill_reputation (source_project_id, target_project_id)
  `);
}

// ── 事件记录 ────────────────────────────────────────

/**
 * 记录技能声誉事件（迁移/成功/失败/废弃）。
 */
export async function recordReputationEvent(
  pool: Pool,
  event: ReputationEvent,
): Promise<void> {
  try {
    await ensureReputationTable(pool);

    await pool.query(
      `INSERT INTO skill_reputation (skill_name, source_project_id, target_project_id, event_type, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        event.skill_name,
        event.source_project_id,
        event.target_project_id || null,
        event.event_type,
        JSON.stringify(event.metadata || {}),
      ],
    );
  } catch (err) {
    logger.warn("Failed to record reputation event:", err);
  }
}

// ── 评分计算 ────────────────────────────────────────

/**
 * 计算单个技能的跨项目声誉评分。
 *
 * 算法:
 *   1. successRate = success / (success + failure) | 0
 *   2. adoptionRate = min(projectCount / 10, 1.0)
 *   3. recencyBoost = exp(-daysSinceLastUse / 30)
 *   4. rawScore = successRate×0.5 + adoptionRate×0.3 + recencyBoost×0.2
 *   5. reputation = round(rawScore × log10(migrationCount + 1) × 10)
 */
export async function computeReputation(
  pool: Pool,
  skillName: string,
): Promise<ReputationScore | null> {
  try {
    await ensureReputationTable(pool);

    // 统计事件
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE event_type = 'migration') as migrations,
         COUNT(*) FILTER (WHERE event_type = 'success') as successes,
         COUNT(*) FILTER (WHERE event_type = 'failure') as failures,
         COUNT(DISTINCT COALESCE(target_project_id, source_project_id)) as projects,
         MAX(event_at) as last_used
       FROM skill_reputation
       WHERE skill_name = $1`,
      [skillName],
    );

    const r = rows[0];
    const migrations = parseInt(r.migrations, 10) || 0;
    const successes = parseInt(r.successes, 10) || 0;
    const failures = parseInt(r.failures, 10) || 0;
    const projects = parseInt(r.projects, 10) || 1;
    const lastUsed: Date | null = r.last_used;

    // 成功率
    const total = successes + failures;
    const successRate = total > 0 ? successes / total : 0.5;

    // 采用率 (10 个项目为满分)
    const adoptionRate = Math.min(projects / 10, 1.0);

    // 最近使用加权 (30 天半衰期)
    const daysSinceLastUse = lastUsed
      ? (Date.now() - lastUsed.getTime()) / (1000 * 60 * 60 * 24)
      : 30;
    const recencyBoost = Math.exp(-daysSinceLastUse / 30);

    // 综合评分
    const rawScore =
      successRate * 0.5 + adoptionRate * 0.3 + recencyBoost * 0.2;

    // 迁移次数对数缩放（防止高频迁移通胀）
    const migrationMultiplier = Math.log10(Math.max(migrations, 1) + 1);

    const reputation = Math.round(rawScore * migrationMultiplier * 100) / 10;

    // 有效性判定
    let effectiveness = "active";
    if (failures > successes * 2) effectiveness = "declining";
    if (reputation < 1.0 && migrations >= 3) effectiveness = "deprecated";

    return {
      skill_name: skillName,
      reputation,
      success_rate: Math.round(successRate * 100) / 100,
      migration_count: migrations,
      project_count: projects,
      last_used_at: lastUsed?.toISOString() || null,
      effectiveness,
    };
  } catch (err) {
    logger.warn(`Failed to compute reputation for ${skillName}:`, err);
    return null;
  }
}

/**
 * 批量计算所有已索引技能的声誉评分，按 reputation 降序排列。
 */
export async function getTopReputationSkills(
  pool: Pool,
  options?: {
    limit?: number;
    minReputation?: number;
    excludeDeprecated?: boolean;
  },
): Promise<ReputationScore[]> {
  try {
    await ensureReputationTable(pool);

    const { rows } = await pool.query(
      `SELECT DISTINCT skill_name FROM skill_reputation`,
    );

    const scores: ReputationScore[] = [];
    for (const row of rows) {
      const score = await computeReputation(pool, row.skill_name);
      if (!score) continue;
      if (
        options?.excludeDeprecated !== false &&
        score.effectiveness === "deprecated"
      )
        continue;
      if (options?.minReputation && score.reputation < options.minReputation)
        continue;
      scores.push(score);
    }

    scores.sort((a, b) => b.reputation - a.reputation);
    return scores.slice(0, options?.limit || 20);
  } catch (err) {
    logger.warn("Failed to get top reputation skills:", err);
    return [];
  }
}

/**
 * 记录技能跨项目迁移事件。在 writeSkillDual 写入全局后调用。
 */
export async function recordMigration(
  pool: Pool,
  skillName: string,
  sourceProjectId: string,
  targetProjectId: string,
): Promise<void> {
  await recordReputationEvent(pool, {
    skill_name: skillName,
    event_type: "migration",
    source_project_id: sourceProjectId,
    target_project_id: targetProjectId,
  });
}

/**
 * 记录技能在目标项目中的使用效果。
 */
export async function recordEffectiveness(
  pool: Pool,
  skillName: string,
  projectId: string,
  effective: boolean,
): Promise<void> {
  await recordReputationEvent(pool, {
    skill_name: skillName,
    event_type: effective ? "success" : "failure",
    source_project_id: projectId,
    metadata: { effective, recorded_at: new Date().toISOString() },
  });
}
