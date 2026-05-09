/**
 * knowledge-corpus.ts
 *
 * Named knowledge corpora — filter-based memory collections that can be
 * built, queried, primed, and rebuilt on demand.
 *
 * Inspired by claude-mem's knowledge corpus system (build_corpus, query_corpus,
 * prime_corpus, list_corpora, rebuild_corpus).
 *
 * A corpus is a named collection of observations defined by a saved filter query.
 * Once built, it can be queried semantically or injected into sessions via priming.
 */

import { Pool } from "pg";
import { v4 as uuid } from "uuid";
import { createLogger } from "../services/logger";

const logger = createLogger("knowledge-corpus");

// ============================================================
// Types
// ============================================================

export interface BuildCorpusInput {
  /** Corpus name (unique identifier) */
  name: string;
  /** Free-text search filter (applied to observation content) */
  query?: string;
  /** Filter by project */
  project?: string;
  /** Filter by platform source */
  platform?: string;
  /** Filter by minimum importance (1-5) */
  min_importance?: number;
  /** Maximum results to store in corpus. Default: 100 */
  max_results?: number;
  /** Optional description */
  description?: string;
}

export interface QueryCorpusInput {
  /** Corpus name */
  name: string;
  /** Optional semantic search query within corpus */
  query?: string;
  /** Max results. Default: 10 */
  limit?: number;
}

export interface PrimeCorpusInput {
  /** Corpus name to prime */
  name: string;
  /** Max context items to include. Default: 10 */
  max_items?: number;
}

// ============================================================
// Internal corpus storage (PostgreSQL JSONB)
// Uses the existing session_map metadata for lightweight storage.
// For production, a dedicated corpora table would be better.
// ============================================================

const CORPUS_META_TABLE = "corpus_meta";
const CORPUS_ENTRY_TABLE = "corpus_entries";

async function ensureCorpusTables(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${CORPUS_META_TABLE} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) UNIQUE NOT NULL,
      description TEXT,
      filter_query TEXT,
      filter_project VARCHAR(255),
      filter_platform VARCHAR(50),
      filter_min_importance INTEGER DEFAULT 1,
      max_results INTEGER DEFAULT 100,
      result_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${CORPUS_ENTRY_TABLE} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      corpus_id UUID REFERENCES ${CORPUS_META_TABLE}(id) ON DELETE CASCADE,
      observation_id UUID,
      score FLOAT DEFAULT 0,
      added_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_corpus_entries_corpus
      ON ${CORPUS_ENTRY_TABLE}(corpus_id)
  `);
}

// ============================================================
// build_corpus — create or rebuild a named knowledge corpus
// ============================================================

export async function buildCorpus(
  input: BuildCorpusInput,
  pool: Pool,
): Promise<{ name: string; count: number }> {
  const {
    name,
    query,
    project,
    platform,
    min_importance,
    max_results = 100,
    description,
  } = input;

  try {
    await ensureCorpusTables(pool);

    // Build the search query to find matching observations
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (query) {
      conditions.push(
        `(o.tool_input_summary ILIKE $${idx} OR o.tool_output_summary ILIKE $${idx})`,
      );
      params.push(`%${query}%`);
      idx++;
    }
    if (project) {
      conditions.push(`sm.project_id = $${idx++}`);
      params.push(project);
    }
    if (platform) {
      conditions.push(`o.platform_source = $${idx++}`);
      params.push(platform);
    }
    if (min_importance) {
      conditions.push(`o.importance >= $${idx++}`);
      params.push(min_importance);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(max_results);

    const { rows } = await pool.query(
      `SELECT o.id, o.importance, o.created_at
       FROM observations o
       LEFT JOIN session_map sm ON o.session_map_id = sm.id
       ${whereClause}
       ORDER BY o.importance DESC, o.created_at DESC
       LIMIT $${idx}`,
      params,
    );

    // Upsert corpus metadata
    const metaResult = await pool.query(
      `INSERT INTO ${CORPUS_META_TABLE}
       (name, description, filter_query, filter_project, filter_platform,
        filter_min_importance, max_results, result_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (name)
       DO UPDATE SET
         description = EXCLUDED.description,
         filter_query = EXCLUDED.filter_query,
         result_count = EXCLUDED.result_count,
         updated_at = NOW()
       RETURNING id`,
      [
        name,
        description || null,
        query || null,
        project || null,
        platform || null,
        min_importance || 1,
        max_results,
        rows.length,
      ],
    );
    const corpusId = metaResult.rows[0].id;

    // Replace entries: delete old, batch insert new
    await pool.query(`DELETE FROM ${CORPUS_ENTRY_TABLE} WHERE corpus_id = $1`, [
      corpusId,
    ]);
    if (rows.length > 0) {
      const values = rows
        .map((_: any, i: number) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`)
        .join(",");
      const flatParams = rows.flatMap((r: any) => [r.id, r.importance / 5]);
      await pool.query(
        `INSERT INTO ${CORPUS_ENTRY_TABLE} (corpus_id, observation_id, score) VALUES ${values}`,
        [corpusId, ...flatParams],
      );
    }

    logger.info(`Corpus "${name}" built with ${rows.length} entries`);
    return { name, count: rows.length };
  } catch (error) {
    logger.error(`Failed to build corpus "${name}"`, error);
    return { name, count: 0 };
  }
}

// ============================================================
// query_corpus — search within a built corpus
// ============================================================

export async function queryCorpus(
  input: QueryCorpusInput,
  pool: Pool,
): Promise<{ name: string; results: any[] }> {
  const { name, query, limit = 10 } = input;

  try {
    await ensureCorpusTables(pool);

    const meta = await pool.query(
      `SELECT id FROM ${CORPUS_META_TABLE} WHERE name = $1`,
      [name],
    );
    if (meta.rows.length === 0) {
      return { name, results: [] };
    }

    const corpusId = meta.rows[0].id;

    const { rows } = await pool.query(
      `SELECT o.id, o.tool_name, o.tool_input_summary, o.tool_output_summary,
              o.importance, o.created_at, ce.score
       FROM ${CORPUS_ENTRY_TABLE} ce
       JOIN observations o ON ce.observation_id = o.id
       WHERE ce.corpus_id = $1
         AND (o.tool_input_summary ILIKE $2 OR o.tool_output_summary ILIKE $2 OR $2 = '%%')
       ORDER BY ce.score DESC, o.created_at DESC
       LIMIT $3`,
      [corpusId, `%${query || ""}%`, limit],
    );

    const results = rows.map((r: any) => ({
      id: r.id,
      tool: r.tool_name,
      summary: (r.tool_input_summary || "").substring(0, 200),
      output: (r.tool_output_summary || "").substring(0, 200),
      importance: r.importance,
      score: r.score,
      created_at: r.created_at,
    }));

    return { name, results };
  } catch (error) {
    logger.error(`Failed to query corpus "${name}"`, error);
    return { name, results: [] };
  }
}

// ============================================================
// list_corpora — list all named corpora
// ============================================================

export async function listCorpora(pool: Pool): Promise<{
  corpora: {
    name: string;
    count: number;
    description?: string;
    updated_at: string;
  }[];
}> {
  try {
    await ensureCorpusTables(pool);

    const { rows } = await pool.query(
      `SELECT name, description, result_count, updated_at
       FROM ${CORPUS_META_TABLE}
       ORDER BY updated_at DESC`,
    );

    return {
      corpora: rows.map((r: any) => ({
        name: r.name,
        count: r.result_count,
        description: r.description,
        updated_at: r.updated_at,
      })),
    };
  } catch (error) {
    logger.error("Failed to list corpora", error);
    return { corpora: [] };
  }
}

// ============================================================
// rebuild_corpus — re-run the original filter to refresh
// ============================================================

export async function rebuildCorpus(
  input: { name: string },
  pool: Pool,
): Promise<{ name: string; count: number }> {
  try {
    const meta = await pool.query(
      `SELECT * FROM ${CORPUS_META_TABLE} WHERE name = $1`,
      [input.name],
    );
    if (meta.rows.length === 0) {
      logger.warn(`Corpus "${input.name}" not found`);
      return { name: input.name, count: 0 };
    }

    const m = meta.rows[0];
    return await buildCorpus(
      {
        name: m.name,
        query: m.filter_query,
        project: m.filter_project,
        platform: m.filter_platform,
        min_importance: m.filter_min_importance,
        max_results: m.max_results,
        description: m.description,
      },
      pool,
    );
  } catch (error) {
    logger.error(`Failed to rebuild corpus "${input.name}"`, error);
    return { name: input.name, count: 0 };
  }
}

// ============================================================
// delete_corpus — remove a named corpus
// ============================================================

export async function deleteCorpus(
  input: { name: string },
  pool: Pool,
): Promise<{ deleted: boolean }> {
  try {
    await pool.query(`DELETE FROM ${CORPUS_META_TABLE} WHERE name = $1`, [
      input.name,
    ]);
    return { deleted: true };
  } catch (error) {
    logger.error(`Failed to delete corpus "${input.name}"`, error);
    return { deleted: false };
  }
}

// ============================================================
// prime_corpus — fetch corpus entries as formatted text for injection
// ============================================================

export interface PrimeCorpusInput {
  /** Corpus name to prime */
  name: string;
  /** Max entries to include. Default: 10 */
  max_items?: number;
}

export async function primeCorpus(
  input: PrimeCorpusInput,
  pool: Pool,
): Promise<{ name: string; content: string; count: number }> {
  const { name, max_items = 10 } = input;

  try {
    const meta = await pool.query(
      `SELECT id, description FROM ${CORPUS_META_TABLE} WHERE name = $1`,
      [name],
    );
    if (meta.rows.length === 0) {
      return { name, content: "", count: 0 };
    }
    const corpusId = meta.rows[0].id;
    const description = meta.rows[0].description;

    const { rows } = await pool.query(
      `SELECT o.tool_name, o.tool_input_summary, o.tool_output_summary,
              o.importance, o.created_at, ce.score
       FROM ${CORPUS_ENTRY_TABLE} ce
       JOIN observations o ON ce.observation_id = o.id
       WHERE ce.corpus_id = $1
       ORDER BY ce.score DESC, o.created_at DESC
       LIMIT $2`,
      [corpusId, max_items],
    );

    if (rows.length === 0) {
      return { name, content: "", count: 0 };
    }

    const lines: string[] = [];
    lines.push(`<corpus name="${name}">`);
    if (description) lines.push(`description: ${description}`);
    for (const r of rows) {
      const pct = Math.round((r.score || 0.5) * 100);
      const inp = (r.tool_input_summary || "").substring(0, 150);
      const out = (r.tool_output_summary || "").substring(0, 100);
      lines.push(
        `- [${r.tool_name}] (${pct}%) ${inp}${out ? ` → ${out}` : ""}`,
      );
    }
    lines.push("</corpus>");

    return { name, content: lines.join("\n"), count: rows.length };
  } catch (error) {
    logger.error(`Failed to prime corpus "${name}"`, error);
    return { name, content: "", count: 0 };
  }
}

/**
 * reprime_corpus — rebuild then prime (refresh corpus entries before injecting).
 */
export async function reprimeCorpus(
  input: PrimeCorpusInput,
  pool: Pool,
): Promise<{ name: string; content: string; count: number }> {
  // First rebuild to refresh entries
  await rebuildCorpus({ name: input.name }, pool);
  // Then prime
  return primeCorpus(input, pool);
}
