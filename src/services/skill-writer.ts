/**
 * skill-writer.ts — agentskills.io 兼容技能写入器
 *
 * 将 hindsight_reflect 产出的高置信度 pattern 自动生成
 * agentskills.io 标准技能文件：
 *   ~/.config/opencode/skills/<name>/
 *   └── SKILL.md   (YAML frontmatter + Markdown)
 *
 * 命名规范：
 *   - 小写字母 + 数字 + 连字符
 *   - 1-64 字符
 *   - 不得以连字符开头或结尾
 *   - 不得有连续连字符
 */

import { writeFile, rename, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createLogger } from "./logger";

const logger = createLogger("skill-writer");

// ── 路径 ────────────────────────────────────────────────

function getSkillsDir(): string {
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode");
  return join(configDir, "skills");
}

// ── 命名工具 ──────────────────────────────────────────

/**
 * 将任意字符串转换为 agentskills.io 有效 name：
 * 小写 + 连字符，移除非法字符，截断 64 字符。
 */
function toValidSkillName(pattern_type: string, id: string): string {
  const base = `${pattern_type}-${id.substring(0, 8)}`
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 64);
  return base || `skill-${id.substring(0, 8)}`;
}

// ── 内容生成 ──────────────────────────────────────────

interface PatternInput {
  pattern_type?: string;
  summary: string;
  confidence: number;
  action_plan: {
    trigger?: { tool?: string; output_contains?: string[] };
    action?: { type: string; content: string; target?: string };
  };
  id?: string;
}

/**
 * 生成 agentskills.io 兼容的 SKILL.md 内容。
 */
function formatSkillContent(pattern: PatternInput, skillName: string): string {
  const { trigger, action } = pattern.action_plan;
  const toolName = trigger?.tool || "unknown";
  const markers = trigger?.output_contains?.length
    ? trigger.output_contains.join(", ")
    : "特定条件";
  const actionContent = action?.content || pattern.summary;

  return `---
name: ${skillName}
description: 自动生成: ${pattern.summary.length > 100 ? pattern.summary.substring(0, 97) + "..." : pattern.summary}
---

## Trigger

当 \`${toolName}\`${markers !== "特定条件" ? ` 输出包含: ${markers}` : ""} 时自动采用此策略。

## Steps

${actionContent}

---

_agentskills.io 格式 — 由 opcode-pg-memory v3.14+ 自动生成_
_来源: ${pattern.pattern_type || "pattern"}, 置信度: ${pattern.confidence}_
`;
}

// ── 写入 ──────────────────────────────────────────────

/**
 * 将一个 pattern 写入 skills/<name>/SKILL.md。
 * agentskills.io 兼容格式，目录结构 + YAML frontmatter。
 * 原子写入（tmp → rename），幂等（同名覆盖）。
 */
export async function writeSkillFromReflection(
  pattern: PatternInput,
): Promise<string | null> {
  try {
    const skillsDir = getSkillsDir();
    const skillName = toValidSkillName(
      pattern.pattern_type || "pattern",
      pattern.id || Date.now().toString(36),
    );
    const skillDir = join(skillsDir, skillName);
    const filePath = join(skillDir, "SKILL.md");

    // 确保目录存在
    if (!existsSync(skillDir)) {
      await mkdir(skillDir, { recursive: true });
    }

    const content = formatSkillContent(pattern, skillName);

    // 原子写入：tmp → rename
    const tmpPath = join(tmpdir(), `skill-${randomUUID()}.md.tmp`);
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, filePath);

    logger.info(`Skill written: ${filePath}`);
    return filePath;
  } catch (error) {
    logger.warn("Failed to write skill:", error);
    return null;
  }
}
