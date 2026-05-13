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

/** rules.md 路径：~/.config/opencode/rules.md */
function getRulesMdPath(): string {
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode");
  return join(configDir, "rules.md");
}

// ── 输入输出类型 ──────────────────────────────────────

export interface ApplyReflectionInput {
  /** reflections 表 UUID */
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

// ── rules.md 操作 ─────────────────────────────────────

const AUTO_SECTION_HEADER = "## Automated Rules (from opcode-pg-memory)";

/** rules.md 不存在时返回的默认内容 */
const DEFAULT_RULES_CONTENT = "# Project Rules\n";

/**
 * 异步读取 rules.md；文件不存在则返回默认内容。
 */
async function readRulesMd(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return DEFAULT_RULES_CONTENT;
    }
    logger.warn("Failed to read rules.md, starting fresh:", err);
    return DEFAULT_RULES_CONTENT;
  }
}

/**
 * 在 rules.md 中追加一条规则。
 * 使用 写入临时文件 → rename 的原子写模式防止并发破坏。
 */
async function appendRuleToRulesMd(
  path: string,
  ruleBullet: string,
): Promise<void> {
  const content = await readRulesMd(path);
  const normalized = content.endsWith("\n") ? content : content + "\n";

  const sectionStart = normalized.indexOf(AUTO_SECTION_HEADER);
  let newContent: string;

  if (sectionStart === -1) {
    // 没有自动化规则区段 → 在末尾新建
    newContent = normalized + `\n${AUTO_SECTION_HEADER}\n${ruleBullet}\n`;
  } else {
    // 已有区段 → 在区段末尾追加
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

  // 确保父目录存在
  const parentDir = dirname(path);
  if (!existsSync(parentDir)) {
    await mkdir(parentDir, { recursive: true });
  }

  // 原子写入：写临时文件 → rename 覆盖目标
  const tmpPath = join(tmpdir(), `rules-${randomUUID()}.md.tmp`);
  await writeFile(tmpPath, newContent, "utf-8");
  await rename(tmpPath, path);

  logger.info(`Wrote rule to ${path}`);
}

/**
 * 将一条 ActionPlan 格式化为 rules.md 的 bullet point。
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

// ── 主处理函数 ────────────────────────────────────────

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

    const row = rows[0];

    // 2. 检查是否已应用
    if (row.applied_at) {
      return {
        success: true,
        applied: false,
        pattern_type: row.pattern_type,
        summary: row.summary,
        error: "Already applied",
      };
    }

    // 3. 检查是否有 action_plan
    if (!row.action_plan) {
      return {
        success: false,
        applied: false,
        pattern_type: row.pattern_type,
        summary: row.summary,
        error: "No actionable plan — pattern has no trigger/action metadata",
      };
    }

    // 4. 格式化并异步原子写入 rules.md
    const ruleMdPath = getRulesMdPath();
    const rule = formatRule(row.pattern_type, row.action_plan, row.summary);

    await appendRuleToRulesMd(ruleMdPath, rule);

    // 5. 标记 applied_at
    await pool.query(
      `UPDATE reflections SET applied_at = NOW() WHERE id = $1`,
      [input.pattern_id],
    );

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
