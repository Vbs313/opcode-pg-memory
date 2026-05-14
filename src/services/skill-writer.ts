/**
 * skill-writer.ts — agentskills.io 兼容技能写入器 (v3.16 P4增强)
 *
 * 双路径写入:
 *   1. skills/auto/<name>/SKILL.md   (项目内，版本控制，Agent 渐进式披露)
 *   2. ~/.config/opencode/skills/<name>/SKILL.md  (全局，跨项目复用)
 *
 * 质量门控 (shouldWriteSkill):
 *   - confidence ≥ 0.85
 *   - action_plan.action.type ∈ {"template", "suggestion"}  → skill
 *   - action_plan.action.type = "rule"                        → rules.md only
 *   - 无 action_plan                                         → rules.md only
 *
 * 命名规范 (agentskills.io):
 *   - auto- 前缀表示自动生成
 *   - 小写字母 + 数字 + 连字符
 *   - 1-64 字符，不得以连字符开头/结尾，不得有连续连字符
 */

import { writeFile, rename, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createLogger } from "./logger";

const logger = createLogger("skill-writer");

// ── 路径 ────────────────────────────────────────────────

function getGlobalSkillsDir(): string {
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode");
  return join(configDir, "skills");
}

/** 项目内 skills/auto/ 目录 — Agent 渐进式披露加载 */
function getProjectAutoSkillsDir(): string {
  // 优先使用环境变量，fallback 到 CWD
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

// ── 质量门控 ──────────────────────────────────────────

/**
 * 判断一个 reflection pattern 是否应生成为 Skill（而非仅 rules.md）。
 *
 * 条件:
 *   1. confidence ≥ 0.85
 *   2. action_plan 存在
 *   3. action.type ∈ {"template", "suggestion"}（非 "rule"）
 */
export function shouldWriteSkill(pattern: PatternInput): boolean {
  if (pattern.confidence < 0.85) return false;
  const plan = pattern.action_plan;
  if (!plan) return false;
  const actionType = plan.action?.type;
  // "rule" 类型适合平面追加到 rules.md，不适合作为独立 Skill
  return actionType === "template" || actionType === "suggestion";
}

// ── 命名工具 ──────────────────────────────────────────

/**
 * 生成 agentskills.io 兼容的 skill name。
 * auto- 前缀 + 模式类型 + UUID 前8位。
 */
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

// ── 内容生成 (渐进式披露格式) ─────────────────────────

/**
 * 生成 agentskills.io + 渐进式披露兼容的 SKILL.md 内容。
 *
 * 渐进式披露: Agent 启动时只加载 name + description (YAML frontmatter)。
 * 正文（Trigger / Steps / Examples）仅在 Agent 决策加载该 Skill 后读取。
 */
function formatSkillContent(pattern: PatternInput, skillName: string): string {
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

  return `---
name: ${skillName}
description: ${desc}
metadata:
  source: opcode-pg-memory
  pattern_type: ${pattern.pattern_type || "unknown"}
  confidence: ${pattern.confidence}
  auto_generated: true
  generated_at: ${new Date().toISOString()}
license: MIT
---

# ${pattern.pattern_type || "Automated Skill"}

> 由 opcode-pg-memory 自主反思引擎自动生成。置信度: ${pattern.confidence}

## Trigger

当 \`${toolName}\`${markers ? ` 输出包含 \`${markers}\`` : " 工具执行"} 时，采用以下策略。

## Steps

${actionContent}

## Verification

执行后检查:
- 工具输出是否符合预期结果
- 错误是否已消除（若为修复型策略）
- 是否需要在后续会话中调整策略参数

---

_agentskills.io 渐进式披露格式 — opcode-pg-memory v3.16+_
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

// ── 公共 API ──────────────────────────────────────────

/**
 * 写入项目 skills/auto/ 目录 — Agent 渐进式披露优先加载。
 */
export async function writeSkillToProject(
  pattern: PatternInput,
): Promise<string | null> {
  try {
    const skillsDir = getProjectAutoSkillsDir();
    const skillName = toValidSkillName(
      pattern.pattern_type || "pattern",
      pattern.id || Date.now().toString(36),
    );
    const skillDir = join(skillsDir, skillName);
    const filePath = join(skillDir, "SKILL.md");
    const content = formatSkillContent(pattern, skillName);

    await atomicWrite(filePath, content);

    logger.info(`Skill written to project: ${filePath}`);
    return filePath;
  } catch (error) {
    logger.warn("Failed to write project skill:", error);
    return null;
  }
}

/**
 * 写入全局 ~/.config/opencode/skills/ — 跨项目复用。
 */
export async function writeSkillToGlobal(
  pattern: PatternInput,
): Promise<string | null> {
  try {
    const skillsDir = getGlobalSkillsDir();
    const skillName = toValidSkillName(
      pattern.pattern_type || "pattern",
      pattern.id || Date.now().toString(36),
    );
    const skillDir = join(skillsDir, skillName);
    const filePath = join(skillDir, "SKILL.md");
    const content = formatSkillContent(pattern, skillName);

    await atomicWrite(filePath, content);

    logger.info(`Skill written to global: ${filePath}`);
    return filePath;
  } catch (error) {
    logger.warn("Failed to write global skill:", error);
    return null;
  }
}

/**
 * 双路径写入: skills/auto/ + ~/.config/opencode/skills/
 *
 * @returns 写入成功的路径数组，空数组表示全部失败
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

/**
 * 保留向后兼容: 原 writeSkillFromReflection 行为 = 写入全局目录。
 * @deprecated 使用 writeSkillDual() 获取双路径写入。
 */
export { writeSkillToGlobal as writeSkillFromReflection };
