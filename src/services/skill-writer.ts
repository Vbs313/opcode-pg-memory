/**
 * skill-writer.ts — agentskills.io 兼容技能写入器 (v3.17 自我改进增强)
 *
 * 双路径写入:
 *   1. skills/auto/<name>/SKILL.md   (项目内，版本控制，Agent 渐进式披露)
 *   2. ~/.config/opencode/skills/<name>/SKILL.md  (全局，跨项目复用)
 *
 * 技能生命周期 (v3.17):
 *   - 生成: reflection → shouldWriteSkill() → findExistingSkill()
 *   - 修补: 相似技能存在 → patchSkill() 合并内容 + 版本递增
 *   - 新建: 无相似技能 → writeSkillToProject/Global 创建 v1.0.0
 *
 * 质量门控 (shouldWriteSkill):
 *   - confidence ≥ 0.85
 *   - action_plan.action.type ∈ {"template", "suggestion"}
 */

import { readFile, writeFile, rename, mkdir, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { createLogger } from "./logger";

const logger = createLogger("skill-writer");

// ── 路径 ────────────────────────────────────────────────

function getGlobalSkillsDir(): string {
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode");
  return join(configDir, "skills");
}

function getProjectAutoSkillsDir(): string {
  const projectRoot = process.env.PG_MEMORY_PROJECT_ROOT || process.cwd();
  return join(projectRoot, "skills", "auto");
}

// ── 类型 ──────────────────────────────────────────────

export interface PatternInput {
  pattern_type?: string;
  summary: string;
  confidence: number;
  action_plan?: {
    trigger?: { tool?: string; output_contains?: string[] };
    action?: { type: string; content: string; target?: string };
  };
  id?: string;
}

interface SkillFrontmatter {
  name: string;
  version: string;
  updated_at?: string;
  pattern_type?: string;
  trigger_tool?: string;
}

// ── 质量门控 ──────────────────────────────────────────

export function shouldWriteSkill(pattern: PatternInput): boolean {
  if (pattern.confidence < 0.85) return false;
  const plan = pattern.action_plan;
  if (!plan) return false;
  const actionType = plan.action?.type;
  return actionType === "template" || actionType === "suggestion";
}

// ── 命名工具 ──────────────────────────────────────────

function toValidSkillName(pattern_type: string, id: string): string {
  const base = `auto-${pattern_type}-${id.substring(0, 8)}`
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 64);
  return base || `auto-skill-${id.substring(0, 8)}`;
}

// ── YAML frontmatter 解析 ─────────────────────────────

/**
 * 从 SKILL.md 中提取 YAML frontmatter 字段。
 * 简单解析器 — 只提取 --- 之间的键值对。
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

/**
 * 递增 semver 补丁版本号。若格式无效，返回 "1.0.0"。
 */
function bumpVersion(version: string): string {
  const parts = version.split(".").map(Number);
  if (parts.length === 3 && parts.every((n) => !isNaN(n))) {
    return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
  return "1.0.0";
}

// ── 相似度匹配 ────────────────────────────────────────

/**
 * 在 skills/auto/ 中查找与给定 pattern 相似的已有技能。
 * 匹配条件: pattern_type 相同 或 trigger.tool 相同。
 *
 * @returns 匹配到的技能目录名，或 null
 */
async function findExistingSkill(
  pattern: PatternInput,
): Promise<string | null> {
  const autoDir = getProjectAutoSkillsDir();
  if (!existsSync(autoDir)) return null;

  try {
    const entries = await readdir(autoDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(autoDir, entry.name, "SKILL.md");
      if (!existsSync(skillPath)) continue;

      try {
        const content = await readFile(skillPath, "utf-8");
        const fm = parseFrontmatter(content);

        // 匹配 pattern_type
        if (pattern.pattern_type && fm.pattern_type === pattern.pattern_type) {
          logger.info(`Found existing skill by pattern_type: ${entry.name}`);
          return entry.name;
        }

        // 匹配 trigger tool
        const patternTool = pattern.action_plan?.trigger?.tool;
        if (patternTool && fm.trigger_tool === patternTool) {
          logger.info(`Found existing skill by trigger_tool: ${entry.name}`);
          return entry.name;
        }
      } catch {
        // 跳过无法读取的 skill
      }
    }
  } catch (err) {
    logger.debug("Failed to scan skills/auto/:", err);
  }
  return null;
}

// ── 内容生成 ──────────────────────────────────────────

function formatSkillContent(
  pattern: PatternInput,
  skillName: string,
  version = "1.0.0",
  existingContent?: string,
): string {
  const { trigger, action } = pattern.action_plan || {};
  const toolName = trigger?.tool || "unknown";
  const markers = trigger?.output_contains?.length
    ? trigger.output_contains.join(", ")
    : "";
  const actionContent = action?.content || pattern.summary;
  const desc =
    pattern.summary.length > 100
      ? pattern.summary.substring(0, 97) + "..."
      : pattern.summary;
  const now = new Date().toISOString();

  // 如果有已有内容，提取其 ## Steps 部分以保留手动修改
  let stepsContent = actionContent;
  if (existingContent) {
    const stepsMatch = existingContent.match(
      /## Steps\n\n([\s\S]*?)(?=\n## |\n---\n|$)/,
    );
    if (stepsMatch && stepsMatch[1].trim()) {
      // 保留手动编辑的内容，附加新反思
      stepsContent = `${stepsMatch[1].trim()}\n\n### v${version} 更新\n\n${actionContent}`;
    }
  }

  return `---
name: ${skillName}
description: ${desc}
version: ${version}
updated_at: ${now}
pattern_type: ${pattern.pattern_type || "unknown"}
trigger_tool: ${toolName}
confidence: ${pattern.confidence}
source: opcode-pg-memory
auto_generated: true
license: MIT
---

# ${pattern.pattern_type || "Automated Skill"}

> 由 opcode-pg-memory 自主反思引擎生成。
> 版本: ${version} | 更新: ${now} | 置信度: ${pattern.confidence}

## Trigger

当 \`${toolName}\`${markers ? ` 输出包含 \`${markers}\`` : " 工具执行"} 时，采用以下策略。

## Steps

${stepsContent}

## Verification

执行后检查:
- 工具输出是否符合预期结果
- 错误是否已消除（若为修复型策略）
- 是否需要在后续会话中调整策略参数

---

_agentskills.io 渐进式披露格式 — opcode-pg-memory v3.17+_
`;
}

// ── 原子写入 ──────────────────────────────────────────

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const parentDir = dirname(filePath);
  if (!existsSync(parentDir)) {
    await mkdir(parentDir, { recursive: true });
  }
  const tmpPath = join(tmpdir(), `skill-${randomUUID()}.md.tmp`);
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, filePath);
}

// ── Skill 修补 ────────────────────────────────────────

/**
 * 修补已有技能: 读取现有 SKILL.md，版本递增，合并内容。
 *
 * @param skillDirName 技能目录名（如 auto-error_pattern-abc12345）
 * @param pattern 新的反思模式
 * @returns 写入的文件路径，或 null
 */
async function patchSkill(
  skillDirName: string,
  pattern: PatternInput,
  skillsBaseDir: string,
): Promise<string | null> {
  const skillDir = join(skillsBaseDir, skillDirName);
  const filePath = join(skillDir, "SKILL.md");

  try {
    const existingContent = await readFile(filePath, "utf-8");
    const fm = parseFrontmatter(existingContent);
    const oldVersion = fm.version || "1.0.0";
    const newVersion = bumpVersion(oldVersion);

    const content = formatSkillContent(
      pattern,
      skillDirName,
      newVersion,
      existingContent,
    );

    await atomicWrite(filePath, content);

    logger.info(`Skill patched: ${filePath} (${oldVersion} → ${newVersion})`);
    return filePath;
  } catch (error) {
    logger.warn("Failed to patch skill:", error);
    return null;
  }
}

// ── 公共 API ──────────────────────────────────────────

export async function writeSkillToProject(
  pattern: PatternInput,
): Promise<string | null> {
  try {
    const skillsDir = getProjectAutoSkillsDir();

    // v3.17: 检查是否有相似技能可修补
    const existingName = await findExistingSkill(pattern);
    if (existingName) {
      return patchSkill(existingName, pattern, skillsDir);
    }

    // 新建技能
    const skillName = toValidSkillName(
      pattern.pattern_type || "pattern",
      pattern.id || Date.now().toString(36),
    );
    const skillDir = join(skillsDir, skillName);
    const filePath = join(skillDir, "SKILL.md");
    const content = formatSkillContent(pattern, skillName, "1.0.0");

    await atomicWrite(filePath, content);
    logger.info(`Skill created: ${filePath}`);
    return filePath;
  } catch (error) {
    logger.warn("Failed to write project skill:", error);
    return null;
  }
}

export async function writeSkillToGlobal(
  pattern: PatternInput,
): Promise<string | null> {
  try {
    const skillsDir = getGlobalSkillsDir();

    // v3.17: 全局目录也尝试修补
    const existingName = await findExistingSkill(pattern);
    if (existingName) {
      return patchSkill(existingName, pattern, skillsDir);
    }

    const skillName = toValidSkillName(
      pattern.pattern_type || "pattern",
      pattern.id || Date.now().toString(36),
    );
    const skillDir = join(skillsDir, skillName);
    const filePath = join(skillDir, "SKILL.md");
    const content = formatSkillContent(pattern, skillName, "1.0.0");

    await atomicWrite(filePath, content);
    logger.info(`Skill created (global): ${filePath}`);
    return filePath;
  } catch (error) {
    logger.warn("Failed to write global skill:", error);
    return null;
  }
}

/**
 * 双路径写入: skills/auto/ + ~/.config/opencode/skills/
 * v3.17: 自动检测相似技能 → 修补而非新建
 */
export async function writeSkillDual(pattern: PatternInput): Promise<string[]> {
  const results = await Promise.allSettled([
    writeSkillToProject(pattern),
    writeSkillToGlobal(pattern),
  ]);
  const paths: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) paths.push(r.value);
  }
  return paths;
}

/** @deprecated 使用 writeSkillDual() 获取双路径写入 */
export { writeSkillToGlobal as writeSkillFromReflection };

// ============================================================
// v3.18: 技能可观测性 — 追踪 / 有效性验证 / 废弃
// ============================================================

/**
 * 技能有效性状态
 */
export type SkillEffectiveness = "active" | "declining" | "deprecated";

export interface SkillHealth {
  name: string;
  version: string;
  patchCount: number;
  effectiveness: SkillEffectiveness;
  lastErrorSeen?: string;
}

/**
 * 统计技能被修补的次数（从 version 字段推断）。
 * version "1.0.3" → 3 次修补（major.minor 不变时，patch 递增）。
 */
function getPatchCount(version: string): number {
  const parts = version.split(".").map(Number);
  if (parts.length === 3 && !isNaN(parts[2])) {
    return parts[2];
  }
  return 0;
}

/**
 * 记录技能使用事件到 observations 表。
 * 在 Agent 加载技能时调用，用于追踪技能使用频率和效果。
 */
export async function recordSkillUsage(
  pool: Pool,
  sessionId: string,
  skillName: string,
  version: string,
): Promise<void> {
  try {
    // 获取 session 内部 ID
    const { rows } = await pool.query(
      "SELECT id FROM session_map WHERE opencode_session_id = $1",
      [sessionId],
    );
    if (rows.length === 0) return;
    const sessionMapId = rows[0].id;

    await pool.query(
      `INSERT INTO observations (session_map_id, tool_name, tool_output_summary, importance, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        sessionMapId,
        "skill_loaded",
        `Loaded skill: ${skillName} v${version}`,
        2, // 低重要性 — 仅用于统计
        JSON.stringify({
          event: "skill.loaded",
          skill_name: skillName,
          skill_version: version,
        }),
      ],
    );
  } catch (err) {
    // Non-fatal: 追踪失败不影响主流程
  }
}

/**
 * 检查技能有效性：若同一 pattern_type 的技能被修补后仍出现同类错误，
 * 返回 "declining" 或 "deprecated" 状态。
 *
 * @param pool PG 连接池
 * @param patternType 模式类型（如 "error_pattern"）
 * @param skillDirName 技能目录名（可选，用于精确匹配）
 */
export async function checkSkillEffectiveness(
  pool: Pool,
  patternType: string,
  skillDirName?: string,
): Promise<SkillHealth | null> {
  try {
    const autoDir = getProjectAutoSkillsDir();
    if (!existsSync(autoDir)) return null;

    const entries = await readdir(autoDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skillDirName && entry.name !== skillDirName) continue;

      const skillPath = join(autoDir, entry.name, "SKILL.md");
      if (!existsSync(skillPath)) continue;

      try {
        const content = await readFile(skillPath, "utf-8");
        const fm = parseFrontmatter(content);

        // 匹配 pattern_type
        if (fm.pattern_type !== patternType) continue;

        const version = fm.version || "1.0.0";
        const patchCount = getPatchCount(version);
        const status = fm.status as SkillEffectiveness | undefined;

        // 已废弃的技能跳过
        if (status === "deprecated") {
          return {
            name: entry.name,
            version,
            patchCount,
            effectiveness: "deprecated",
          };
        }

        // 检查修补后是否仍有错误
        const { rows: errorRows } = await pool.query(
          `SELECT COUNT(*) as cnt FROM observations
           WHERE tool_output_summary ILIKE '%error%'
             AND importance >= 3
             AND created_at > (
               SELECT COALESCE(
                 (SELECT created_at FROM observations
                  WHERE metadata->>'event' = 'skill.loaded'
                    AND metadata->>'skill_name' = $1
                  ORDER BY created_at DESC LIMIT 1),
                 NOW() - INTERVAL '30 days'
               )
             )`,
          [entry.name],
        );

        const recentErrors = parseInt(errorRows[0]?.cnt || "0", 10);

        if (status === "declining" && recentErrors > 0 && patchCount >= 3) {
          // 连续 3 次修补 + 仍无效 → 废弃
          await deprecateSkill(entry.name, "3+ patches with no improvement");
          return {
            name: entry.name,
            version,
            patchCount,
            effectiveness: "deprecated",
          };
        }

        if (recentErrors > 0 && patchCount >= 1) {
          // 修补后仍有错误 → 标记 declining
          if (status !== "declining") {
            await markSkillEffectiveness(entry.name, "declining");
          }
          return {
            name: entry.name,
            version,
            patchCount,
            effectiveness: "declining",
            lastErrorSeen: `${recentErrors} errors since last load`,
          };
        }
      } catch {
        // 跳过无法读取的技能
      }
    }
  } catch (err) {
    logger.debug("Skill effectiveness check skipped:", err);
  }
  return null;
}

/**
 * 标记技能有效性状态（更新 SKILL.md frontmatter）。
 */
async function markSkillEffectiveness(
  skillDirName: string,
  effectiveness: SkillEffectiveness,
): Promise<void> {
  const autoDir = getProjectAutoSkillsDir();
  const filePath = join(autoDir, skillDirName, "SKILL.md");
  if (!existsSync(filePath)) return;

  try {
    const content = await readFile(filePath, "utf-8");
    const now = new Date().toISOString();

    // 添加/更新 frontmatter 字段
    let newContent: string;
    if (content.includes("status:")) {
      newContent = content.replace(/^status:.*$/m, `status: ${effectiveness}`);
    } else {
      newContent = content.replace(
        /^license:.*$/m,
        `status: ${effectiveness}\nlicense: MIT`,
      );
    }

    // 更新 updated_at
    newContent = newContent.replace(/^updated_at:.*$/m, `updated_at: ${now}`);

    await atomicWrite(filePath, newContent);
    logger.info(`Skill ${skillDirName} marked as ${effectiveness}`);
  } catch (err) {
    logger.warn(`Failed to mark skill effectiveness:`, err);
  }
}

/**
 * 废弃技能：标记 status: deprecated + 记录原因。
 * 废弃的技能不再从活跃注入中加载。
 */
async function deprecateSkill(
  skillDirName: string,
  reason: string,
): Promise<void> {
  const autoDir = getProjectAutoSkillsDir();
  const filePath = join(autoDir, skillDirName, "SKILL.md");
  if (!existsSync(filePath)) return;

  try {
    const content = await readFile(filePath, "utf-8");
    const now = new Date().toISOString();

    let newContent = content;

    // 添加/更新状态
    if (content.includes("status:")) {
      newContent = newContent.replace(/^status:.*$/m, "status: deprecated");
    } else {
      newContent = newContent.replace(
        /^license:.*$/m,
        "status: deprecated\nlicense: MIT",
      );
    }

    // 添加废弃原因
    if (!newContent.includes("deprecated_reason:")) {
      newContent = newContent.replace(
        /^source:.*$/m,
        `source: opcode-pg-memory\ndeprecated_reason: ${reason}\ndeprecated_at: ${now}`,
      );
    }

    newContent = newContent.replace(/^updated_at:.*$/m, `updated_at: ${now}`);

    await atomicWrite(filePath, newContent);
    logger.info(`Skill ${skillDirName} deprecated: ${reason}`);
  } catch (err) {
    logger.warn(`Failed to deprecate skill:`, err);
  }
}
