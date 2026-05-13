/**
 * skill-writer.ts — 反思模式 → oh-my-openagent 技能文件
 *
 * 将 hindsight_reflect 产出的高置信度 pattern 自动写入
 * ~/.config/opencode/skills/ 目录，使 oh-my-openagent 的 skill-loader
 * 自动加载为 Agent 可用技能。
 *
 * 流程：
 *   hindsight_reflect → confidence >= 0.8 + action_plan
 *     → writeSkillFromReflection()
 *       → formatSkillContent() → 原子写入 skills/<name>.md
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

/** skills 目录路径：~/.config/opencode/skills/ */
function getSkillsDir(): string {
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode");
  return join(configDir, "skills");
}

// ── 技能内容生成 ──────────────────────────────────────

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
 * 将 pattern 格式化为 oh-my-openagent 技能文件内容。
 * 格式匹配现有 skills/ 目录中的 .md 文件规范。
 */
function formatSkillContent(pattern: PatternInput): string {
  const { trigger, action } = pattern.action_plan;
  const toolName = trigger?.tool || "unknown";
  const markers = trigger?.output_contains?.length
    ? trigger.output_contains.join(", ")
    : "特定条件";
  const actionContent = action?.content || pattern.summary;

  const title = `Auto Skill: ${toolName} ${(pattern.pattern_type || "pattern").replace(/_/g, " ")}`;
  const slug = `pg-memory-auto-${pattern.pattern_type || "unknown"}-${(pattern.id || Date.now().toString(36)).substring(0, 8)}`;

  // 描述行限制 100 字符
  const desc =
    pattern.summary.length > 100
      ? pattern.summary.substring(0, 97) + "..."
      : pattern.summary;

  return `---
name: ${slug}
description: 自动从反思中生成: ${desc}
---

# ${title}

从 hindsight_reflect 的 ${pattern.pattern_type || "pattern"} 模式自动生成的 Agent 技能。
置信度: ${Math.round(pattern.confidence * 100)}%

## Trigger

当 \`${toolName}\`${markers !== "特定条件" ? ` 输出包含以下特征: ${markers}` : ""} 时：

## Action

${actionContent}

## Source

- 模式类型: ${pattern.pattern_type || "unknown"}
- 置信度: ${pattern.confidence}
- 反射 ID: ${pattern.id || "N/A"}
- 生成时间: ${new Date().toISOString()}
`;
}

// ── 写入技能文件 ──────────────────────────────────────

/**
 * 将一个 pattern 写入 skills/ 目录作为技能文件。
 * 原子写入（tmp → rename），幂等（同名覆盖）。
 * @returns 写入成功时返回技能文件名，否则返回 null
 */
export async function writeSkillFromReflection(
  pattern: PatternInput,
): Promise<string | null> {
  try {
    const skillsDir = getSkillsDir();
    const slug = `pg-memory-auto-${pattern.pattern_type}-${(pattern.id || Date.now().toString(36)).substring(0, 8)}`;
    const filePath = join(skillsDir, `${slug}.md`);

    // 确保目录存在
    if (!existsSync(skillsDir)) {
      await mkdir(skillsDir, { recursive: true });
    }

    const content = formatSkillContent(pattern);

    // 原子写入
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
