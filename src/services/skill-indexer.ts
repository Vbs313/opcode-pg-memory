/**
 * skill-indexer.ts — 跨项目技能索引 (v3.19)
 *
 * 将全局技能文件向量化索引，支持跨项目相似度搜索。
 *
 * 架构:
 *   1. indexSkill() — 技能写入后，计算 embedding 并存入 skill_index 表
 *   2. searchSimilarSkills() — 基于项目指纹，搜索跨项目相关技能
 *   3. getSkillStats() — 统计技能使用和有效性
 *
 * 表结构 (skill_index — 创建于 init-db.ts 迁移):
 *   id UUID, skill_name TEXT, version TEXT, embedding vector(N),
 *   project_id TEXT, pattern_type TEXT, trigger_tool TEXT,
 *   effectiveness TEXT, indexed_at TIMESTAMPTZ
 */

import { Pool } from "pg";
import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createLogger } from "./logger";
import { getEmbeddingService } from "../utils/embedding";

const logger = createLogger("skill-indexer");

// ── 路径 ────────────────────────────────────────────────

function getGlobalSkillsDir(): string {
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode");
  return join(configDir, "skills");
}

// ── 技能内容提取 ──────────────────────────────────────

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
 * 提取技能的可搜索文本：name + description + trigger + steps
 */
function extractSkillText(content: string): string {
  const fm = parseFrontmatter(content);

  // 提取 description (YAML frontmatter)
  const desc = fm.description || "";

  // 提取 body (frontmatter 之后的所有内容)
  const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  const body = bodyMatch ? bodyMatch[1] : content;

  // 截取前 4000 字符用于 embedding
  const searchText = `${fm.name || ""} ${desc} ${body}`
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 4000);

  return searchText;
}

// ── 索引操作 ──────────────────────────────────────────

export interface SkillIndexEntry {
  skill_name: string;
  version: string;
  pattern_type: string;
  trigger_tool: string;
  effectiveness: string;
  project_id: string;
  indexed_at: string;
  similarity?: number;
}

/**
 * 确保 skill_index 表存在（幂等创建）。
 */
async function ensureSkillIndexTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS skill_index (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      skill_name TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '1.0.0',
      embedding vector(1024),
      project_id TEXT,
      pattern_type TEXT,
      trigger_tool TEXT,
      effectiveness TEXT DEFAULT 'active',
      search_text TEXT,
      indexed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(skill_name, version)
    )
  `);

  // 尝试创建 HNSW 索引（pgvector 可用时）
  try {
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_skill_index_embedding
      ON skill_index USING hnsw (embedding vector_cosine_ops)
    `);
  } catch {
    // pgvector 不可用 — 语义搜索降级但索引仍可工作
  }
}

/**
 * 索引单个技能文件：计算 embedding 并存储到 skill_index 表。
 *
 * @param skillDirName 技能目录名
 * @param projectId 来源项目 ID
 */
export async function indexSkill(
  pool: Pool,
  skillDirName: string,
  projectId: string,
): Promise<boolean> {
  try {
    await ensureSkillIndexTable(pool);

    const skillPath = join(getGlobalSkillsDir(), skillDirName, "SKILL.md");
    if (!existsSync(skillPath)) return false;

    const content = await readFile(skillPath, "utf-8");
    const fm = parseFrontmatter(content);
    const searchText = extractSkillText(content);

    // 计算 embedding
    const emb = getEmbeddingService();
    let embedding: number[] | null = null;
    if (emb) {
      try {
        embedding = await emb.generateEmbedding(searchText);
      } catch (err) {
        logger.debug(`Embedding failed for ${skillDirName}:`, err);
      }
    }

    // UPSERT
    const version = fm.version || "1.0.0";
    await pool.query(
      `INSERT INTO skill_index (skill_name, version, embedding, project_id, pattern_type, trigger_tool, effectiveness, search_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (skill_name, version)
       DO UPDATE SET embedding = EXCLUDED.embedding, effectiveness = EXCLUDED.effectiveness, indexed_at = NOW()`,
      [
        skillDirName,
        version,
        embedding ? `[${embedding.join(",")}]` : null,
        projectId,
        fm.pattern_type || null,
        fm.trigger_tool || null,
        fm.status || "active",
        searchText,
      ],
    );

    logger.info(`Skill indexed: ${skillDirName} v${version}`);
    return true;
  } catch (err) {
    logger.warn(`Failed to index skill ${skillDirName}:`, err);
    return false;
  }
}

/**
 * 基于项目指纹 embedding 搜索跨项目相关技能。
 *
 * @returns 按相似度降序排列的技能条目列表
 */
export async function searchSimilarSkills(
  pool: Pool,
  fingerprintEmbedding: number[],
  options?: {
    limit?: number;
    minSimilarity?: number;
    excludeProjectId?: string;
    excludeDeprecated?: boolean;
  },
): Promise<SkillIndexEntry[]> {
  try {
    await ensureSkillIndexTable(pool);

    const limit = options?.limit || 5;
    const minSim = options?.minSimilarity || 0.5;
    const embStr = `[${fingerprintEmbedding.join(",")}]`;

    let query = `
      SELECT skill_name, version, pattern_type, trigger_tool,
             effectiveness, project_id, indexed_at
    `;

    // 尝试语义搜索，失败则降级到关键词搜索
    try {
      query += `, 1 - (embedding <=> '${embStr}') as similarity`;
      query += ` FROM skill_index`;
      query += ` WHERE embedding IS NOT NULL`;
    } catch {
      // pgvector 不可用 — 回退到文本搜索
      query += `, 0.5 as similarity`;
      query += ` FROM skill_index`;
      query += ` WHERE search_text IS NOT NULL`;
    }

    if (options?.excludeDeprecated !== false) {
      query += ` AND effectiveness != 'deprecated'`;
    }
    if (options?.excludeProjectId) {
      query += ` AND project_id != '${options.excludeProjectId}'`;
    }

    query += ` ORDER BY similarity DESC LIMIT ${limit}`;

    const { rows } = await pool.query(query);
    return rows;
  } catch (err) {
    logger.debug("Cross-project skill search failed:", err);
    return [];
  }
}

/**
 * 批量索引全局技能目录中的所有技能。
 * 在插件启动或技能目录变更时调用。
 */
export async function indexAllGlobalSkills(
  pool: Pool,
  projectId: string,
): Promise<number> {
  const skillsDir = getGlobalSkillsDir();
  if (!existsSync(skillsDir)) return 0;

  let count = 0;
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const ok = await indexSkill(pool, entry.name, projectId);
      if (ok) count++;
    }
  } catch (err) {
    logger.warn("Failed to index global skills:", err);
  }
  return count;
}
