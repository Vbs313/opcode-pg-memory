/**
 * apply-reflection.ts — MCP 工具
 *
 * 将 hindsight_reflect 产出的可执行模式（ActionPlan）应用到 Agent 行为层：
 * 1. 读取 reflection + action_plan
 * 2. 追加到 ~/.config/opencode/rules.md
 * 3. 标记 reflections.applied_at
 *
 * 设计原则：
 * - 幂等：已应用的 pattern 不会重复写入
 * - 可逆：只追加，不删除
 * - 不阻塞：所有错误 try/catch，返回结构化错误
 */

import { Pool } from "pg";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { createLogger } from "../services/logger";

const logger = createLogger("apply-reflection");

// ── 路径 ────────────────────────────────────────────────

/** rules.md 路径：~/.config/opencode/rules.md */
function getRulesMdPath(): string {
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode");
  const path = join(configDir, "rules.md");
  logger.debug(`rules.md path: ${path}`);
  return path;
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

/**
 * 读取 rules.md 全文；文件不存在则返回空内容（含 # Project Rules 头）。
 */
function readRulesMd(path: string): string {
  try {
    if (!existsSync(path)) {
      return "# Project Rules\n";
    }
    return readFileSync(path, "utf-8");
  } catch (err) {
    logger.warn("Failed to read rules.md, starting fresh:", err);
    return "# Project Rules\n";
  }
}

/**
 * 在 rules.md 中追加一条规则。
 * 如果已有 "## Automated Rules" 区段则追加到该区段末尾，
 * 否则在文件末尾新建该区段。
 */
function appendRuleToRulesMd(path: string, ruleBullet: string): void {
  let content = readRulesMd(path);

  // 规范化换行
  if (!content.endsWith("\n")) content += "\n";

  const sectionStart = content.indexOf(AUTO_SECTION_HEADER);

  if (sectionStart === -1) {
    // 没有自动化规则区段 → 在末尾新建
    content += `\n${AUTO_SECTION_HEADER}\n${ruleBullet}\n`;
  } else {
    // 已有区段 → 在区段末尾追加（区段结束于下一个 ## 或文件末尾）
    const restAfterSection = content.slice(
      sectionStart + AUTO_SECTION_HEADER.length,
    );
    const nextSectionMatch = restAfterSection.match(/\n## /);

    let insertPos: number;
    if (nextSectionMatch) {
      insertPos =
        sectionStart + AUTO_SECTION_HEADER.length + nextSectionMatch.index!;
    } else {
      insertPos = content.length;
    }

    // 在 insertPos 之前插入新规则
    const before = content.slice(0, insertPos);
    const after = content.slice(insertPos);
    content = before + ruleBullet + "\n" + after;
  }

  // 确保父目录存在
  const parentDir = dirname(path);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  writeFileSync(path, content, "utf-8");
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

    // 4. 格式化并写入 rules.md
    const ruleMdPath = getRulesMdPath();
    const rule = formatRule(row.pattern_type, row.action_plan, row.summary);

    appendRuleToRulesMd(ruleMdPath, rule);

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
