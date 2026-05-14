/**
 * project-fingerprinter.ts — 项目指纹提取 (v3.19)
 *
 * 从项目元数据生成 embedding，用于跨项目技能推荐。
 *
 * 指纹组成:
 *   1. 依赖信息 (package.json / requirements.txt / Cargo.toml)
 *   2. 文件类型分布 (扩展名统计)
 *   3. 知识图谱实体类型 (entities 表)
 *   4. 项目名 + 描述
 *
 * 输出: 文本描述 → embedding → 与全局技能索引做相似度搜索
 */

import { Pool } from "pg";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { createLogger } from "./logger";
import { getEmbeddingService } from "../utils/embedding";

const logger = createLogger("project-fingerprinter");

// ── 依赖提取 ──────────────────────────────────────────

interface ProjectDeps {
  name?: string;
  runtime: string; // "node" | "python" | "rust" | "unknown"
  dependencies: string[];
  devDependencies: string[];
}

async function extractDeps(projectDir: string): Promise<ProjectDeps> {
  const result: ProjectDeps = {
    runtime: "unknown",
    dependencies: [],
    devDependencies: [],
  };

  // package.json (Node.js)
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
      result.runtime = "node";
      result.name = pkg.name;
      result.dependencies = Object.keys(pkg.dependencies || {});
      result.devDependencies = Object.keys(pkg.devDependencies || {});
      return result;
    } catch {
      /* 损坏的 JSON */
    }
  }

  // requirements.txt (Python)
  const reqPath = join(projectDir, "requirements.txt");
  if (existsSync(reqPath)) {
    try {
      const content = await readFile(reqPath, "utf-8");
      result.runtime = "python";
      result.dependencies = content
        .split("\n")
        .map((l) => l.split("==")[0].split(">=")[0].trim())
        .filter((l) => l && !l.startsWith("#"));
      return result;
    } catch {
      /* 无法读取 */
    }
  }

  // Cargo.toml (Rust)
  const cargoPath = join(projectDir, "Cargo.toml");
  if (existsSync(cargoPath)) {
    try {
      const content = await readFile(cargoPath, "utf-8");
      result.runtime = "rust";
      const depMatch = content.match(/\[dependencies\]([\s\S]*?)(?=\[|$)/);
      if (depMatch) {
        result.dependencies = depMatch[1]
          .split("\n")
          .map((l) => l.split("=")[0].trim())
          .filter((l) => l && !l.startsWith("#"));
      }
      return result;
    } catch {
      /* 无法读取 */
    }
  }

  return result;
}

// ── 实体类型分布 ──────────────────────────────────────

async function extractEntityProfile(
  pool: Pool,
  projectId: string,
): Promise<string[]> {
  try {
    const { rows } = await pool.query(
      `SELECT e.type, COUNT(*) as cnt
       FROM entities e
       JOIN session_map sm ON e.session_map_id = sm.id
       WHERE sm.project_id = $1
       GROUP BY e.type
       ORDER BY cnt DESC
       LIMIT 10`,
      [projectId],
    );
    return rows.map((r) => `${r.type}(${r.cnt})`);
  } catch {
    return [];
  }
}

// ── 指纹生成 ──────────────────────────────────────────

export interface ProjectFingerprint {
  text: string;
  embedding: number[] | null;
  runtime: string;
  topDeps: string[];
  topEntities: string[];
}

/**
 * 生成项目指纹: 文本描述 + embedding。
 */
export async function computeProjectFingerprint(
  pool: Pool,
  projectId: string,
  projectDir?: string,
): Promise<ProjectFingerprint> {
  const dir = projectDir || process.cwd();
  const deps = await extractDeps(dir);
  const entities = await extractEntityProfile(pool, projectId);

  // 构建文本描述
  const parts: string[] = [];
  parts.push(`Runtime: ${deps.runtime}`);
  if (deps.name) parts.push(`Project: ${deps.name}`);
  parts.push(`Project ID: ${projectId}`);

  const topDeps = [...deps.dependencies, ...deps.devDependencies].slice(0, 20);
  if (topDeps.length > 0) {
    parts.push(`Dependencies: ${topDeps.join(", ")}`);
  }
  if (entities.length > 0) {
    parts.push(`Entity types: ${entities.join(", ")}`);
  }

  const text = parts.join(". ");

  // 计算 embedding
  let embedding: number[] | null = null;
  const emb = getEmbeddingService();
  if (emb) {
    try {
      embedding = await emb.generateEmbedding(text);
    } catch (err) {
      logger.debug("Fingerprint embedding failed:", err);
    }
  }

  logger.info(
    `Project fingerprint: ${deps.runtime}, ${topDeps.length} deps, ${entities.length} entity types`,
  );

  return {
    text,
    embedding,
    runtime: deps.runtime,
    topDeps,
    topEntities: entities,
  };
}
