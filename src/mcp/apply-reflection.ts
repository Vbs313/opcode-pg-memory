/**
 * apply-reflection.ts — MCP 工具
 *
 * 将 hindsight_reflect 产出的可执行模式（ActionPlan）应用到 Agent 行为层：
 * 1. 读取 reflection + action_plan
 * 2. 追加到 ~/.config/opencode/rules.md（异步原子写入）
 * 3. 标记 reflections.applied_at
 *
 * 设计原则：
 * - 幂等：已应用的 pattern 不会重复写入
 * - 可逆：只追加，不删除
 * - 原子：使用临时文件 + rename 防止并发写入破坏
 * - 不阻塞：所有错误 try/catch，返回结构化错误
 *
 * 管道函数：
 * - checkDuplicate() → checkCooldown() → formatRule() → writeRuleAtomic() → markApplied()
 */

import { Pool } from "pg";
import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createLogger } from "../services/logger";

const logger = createLogger("apply-reflection");

// ── 路径 ────────────────────────────────────────────────

function getRulesMdPath(): string {
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode");
  return join(configDir, "rules.md");
}

// ── 输入输出类型 ──────────────────────────────────────

export interface ApplyReflectionInput {
  pattern_id: string;
}

export interface ApplyReflectionOutput {
  success: boolean;
  applied: boolean;
  pattern_type?: string;
  summary?: string;
  target_section?: string;
  error?: string;
}

// ── 管道：五大独立函数 ─────────────────────────────────

const AUTO_SECTION_HEADER = "## Automated Rules (from opcode-pg-memory)";
const DEFAULT_RULES_CONTENT = "# Project Rules\n";

interface ReflectionRow {
  id: string;
  pattern_type: string;
  summary: string;
  action_plan: any;
  applied_at: string | null;
  confidence: number;
}

/**
 * checkDuplicate — 检查该反射是否已被应用
 */
function checkDuplicate(row: ReflectionRow): ApplyReflectionOutput | null {
  if (row.applied_at) {
    return {
      success: true,
      applied: false,
      pattern_type: row.pattern_type,
      summary: row.summary,
      error: "Already applied",
    };
  }
  return null;
}

/**
 * checkCooldown — 检查同类 pattern 是否在 7 天内被应用过
 */
async function checkCooldown(
  pool: Pool,
  row: ReflectionRow,
): Promise<ApplyReflectionOutput | null> {
  if (!row.pattern_type) return null;

  const cooldownCheck = await pool.query(
    `SELECT COUNT(*) as cnt FROM reflections
     WHERE pattern_type = $1
       AND applied_at IS NOT NULL
       AND applied_at > NOW() - INTERVAL '7 days'`,
    [row.pattern_type],
  );
  if (parseInt(cooldownCheck.rows[0].cnt, 10) > 0) {
    return {
      success: true,
      applied: false,
      pattern_type: row.pattern_type,
      summary: row.summary,
      error: "Cooldown active — same pattern_type was applied within 7 days",
    };
  }
  return null;
}

/**
 * formatRule — 将 ActionPlan 格式化为 rules.md bullet point
 */
function formatRule(
  pattern_type: string,
  plan: any,
  description: string,
): string {
  const parts: string[] = [];

  if (plan.trigger?.tool) {
    const markers = plan.trigger.output_contains?.length
      ? ` (output contains: ${plan.trigger.output_contains.join(", ")})`
      : "";
    parts.push(`- **When** \`${plan.trigger.tool}\`${markers}`);
  }

  const actionContent = plan.action?.content || description;
  parts.push(`  **Then** ${actionContent}`);

  if (plan.constraints?.platforms?.length) {
    parts.push(`  **Platforms** ${plan.constraints.platforms.join(", ")}`);
  }

  parts.push(`  _Source: ${pattern_type} reflection_`);
  return parts.join("\n");
}

/**
 * writeRuleAtomic — 原子写入 rules.md（临时文件 + rename）
 */
async function writeRuleAtomic(
  path: string,
  ruleBullet: string,
): Promise<void> {
  const content = await readRulesMd(path);
  const normalized = content.endsWith("\n") ? content : content + "\n";

  // 去重：标准化比较
  const whenLine = ruleBullet.split("\n")[0]?.trim();
  if (whenLine) {
    const normalizedWhen = whenLine.replace(/\s+/g, " ");
    const normalizedContent = content.replace(/\s+/g, " ");
    if (normalizedContent.includes(normalizedWhen)) {
      logger.info("Rule already exists in rules.md, skipping dedup append");
      return;
    }
  }

  const sectionStart = normalized.indexOf(AUTO_SECTION_HEADER);
  let newContent: string;

  if (sectionStart === -1) {
    newContent = normalized + `\n${AUTO_SECTION_HEADER}\n${ruleBullet}\n`;
  } else {
    const afterHeader = normalized.slice(
      sectionStart + AUTO_SECTION_HEADER.length,
    );
    const nextSection = afterHeader.match(/\n## /);
    const insertPos = nextSection
      ? sectionStart + AUTO_SECTION_HEADER.length + nextSection.index!
      : normalized.length;
    newContent =
      normalized.slice(0, insertPos) +
      ruleBullet +
      "\n" +
      normalized.slice(insertPos);
  }

  const parentDir = dirname(path);
  if (!existsSync(parentDir)) {
    await mkdir(parentDir, { recursive: true });
  }

  const tmpPath = join(tmpdir(), `rules-${randomUUID()}.md.tmp`);
  await writeFile(tmpPath, newContent, "utf-8");
  await rename(tmpPath, path);
  logger.info(`Wrote rule to ${path}`);
}

async function readRulesMd(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return DEFAULT_RULES_CONTENT;
    logger.warn("Failed to read rules.md, starting fresh:", err);
    return DEFAULT_RULES_CONTENT;
  }
}

/**
 * markApplied — 标记 applied_at 时间戳
 */
async function markApplied(pool: Pool, patternId: string): Promise<void> {
  await pool.query(`UPDATE reflections SET applied_at = NOW() WHERE id = $1`, [
    patternId,
  ]);
}

// ── 主处理函数（协调器） ────────────────────────────────

export async function applyReflection(
  input: ApplyReflectionInput,
  pool: Pool,
): Promise<ApplyReflectionOutput> {
  try {
    // 1. 查询 reflections 表
    const { rows } = await pool.query(
      `SELECT id, pattern_type, summary, action_plan, applied_at, confidence
       FROM reflections WHERE id = $1`,
      [input.pattern_id],
    );

    if (rows.length === 0) {
      return { success: false, applied: false, error: "Pattern not found" };
    }

    const row: ReflectionRow = rows[0];

    // 2. 管道：逐级检查
    const dupResult = checkDuplicate(row);
    if (dupResult) return dupResult;

    const cooldownResult = await checkCooldown(pool, row);
    if (cooldownResult) return cooldownResult;

    // 3. 检查 action_plan
    if (!row.action_plan) {
      return {
        success: false,
        applied: false,
        pattern_type: row.pattern_type,
        summary: row.summary,
        error: "No actionable plan — pattern has no trigger/action metadata",
      };
    }

    // 4. 格式化 & 原子写入
    const rule = formatRule(row.pattern_type, row.action_plan, row.summary);
    await writeRuleAtomic(getRulesMdPath(), rule);

    // 5. 标记已应用
    await markApplied(pool, input.pattern_id);

    logger.info(`Applied reflection ${input.pattern_id} (${row.pattern_type})`);

    return {
      success: true,
      applied: true,
      pattern_type: row.pattern_type,
      summary: row.summary,
      target_section: AUTO_SECTION_HEADER,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error("applyReflection failed:", msg);
    return { success: false, applied: false, error: msg };
  }
}
