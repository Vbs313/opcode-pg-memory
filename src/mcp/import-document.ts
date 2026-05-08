/**
 * import-document MCP 工具
 *
 * 原子性地将外部文档导入到 observations 表。
 * 事务内完成：DELETE 旧 source → INSERT 新分块。避免并发导入造成的数据窗口。
 *
 * 使用方式：
 *   import_document({
 *     source: "docs/ARCHITECTURE.md#section-3",
 *     content: "项目架构说明...",
 *     session_id: "ses_xxx"  // 可选，不传则使用默认 session
 *   })
 *
 * 外部调用方（doc-indexer.mjs）也会直接操作 PostgreSQL，
 * 该工具提供给 oh-my-openagent 的 skill-mcp-manager 调用。
 */

import { Pool } from "pg";
import { createHash } from "crypto";
import { createLogger } from "../services/logger";
import { getEmbeddingService } from "../utils/embedding";
import { getConfig } from "../config";

const logger = createLogger("import-document");

// ── 公共接口 ───────────────────────────────────────

export interface ImportDocumentInput {
  /** 文档唯一标识，推荐格式：相对路径#段落标识（如 "docs/ARCHITECTURE.md#section-3"） */
  source: string;
  /** 文档内容（纯文本，将由服务端按语义边界自动分块） */
  content: string;
  /** 可选的 session_id，不传则插入到默认/首个可用 session */
  session_id?: string;
  /** 语义边界标识之间的重叠字符数（默认 100） */
  overlap?: number;
  /** 每个分块的最大字符数（默认 1500） */
  chunk_size?: number;
}

export interface ImportDocumentResult {
  success: boolean;
  chunks_imported: number;
  chunks_deleted: number;
  source: string;
}

// ── 分块逻辑 ───────────────────────────────────────

/**
 * 按 markdown heading 语义边界分块，fallback 到硬性字符数。
 *
 * 优先按 ## 或 ### 标题切分，如果段落太长则按段落（空行）切分，
 * 最后 fallback 到 chunk_size 硬切。
 */
function chunkBySemanticBoundaries(
  content: string,
  chunkSize: number,
  overlap: number,
): string[] {
  const chunks: string[] = [];

  // 1. 按 markdown heading 切分（## 或 ###）
  const headingRegex = /^(#{2,3})\s+.+$/gm;
  const headingMatches: { index: number; heading: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(content)) !== null) {
    headingMatches.push({ index: match.index, heading: match[0] });
  }

  if (headingMatches.length > 1) {
    // 按标题边界切分
    for (let i = 0; i < headingMatches.length; i++) {
      const start = headingMatches[i].index;
      const end =
        i + 1 < headingMatches.length
          ? headingMatches[i + 1].index
          : content.length;
      const section = content.slice(start, end).trim();
      if (section.length > 0) {
        // 如果段落太长，进一步切分
        if (section.length > chunkSize) {
          chunks.push(...chunkByParagraphs(section, chunkSize, overlap));
        } else {
          chunks.push(section);
        }
      }
    }
  } else {
    // 2. 没有足够标题，按段落切分
    chunks.push(...chunkByParagraphs(content, chunkSize, overlap));
  }

  return chunks;
}

/**
 * 按段落（连续两个换行）切分，单个段落超过 chunkSize 则硬切。
 */
function chunkByParagraphs(
  text: string,
  chunkSize: number,
  overlap: number,
): string[] {
  const paragraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (para.length > chunkSize) {
      // 单个段落太长，按句子或硬切
      if (current) {
        chunks.push(current);
        current = "";
      }
      // 将长段落按 chunkSize 切分
      for (let i = 0; i < para.length; i += chunkSize - overlap) {
        const chunk = para.slice(i, i + chunkSize).trim();
        if (chunk.length > 0) chunks.push(chunk);
      }
    } else if ((current + "\n\n" + para).length > chunkSize) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

// ── 核心函数 ───────────────────────────────────────

/**
 * 原子性导入文档。
 *
 * 在单个事务中：
 * 1. DELETE 所有 source = $1 的旧记录
 * 2. 分块 content
 * 3. INSERT 新记录（含 embedding）
 *
 * 提交后才 REINDEX（事务外异步）。
 */
export async function importDocument(
  input: ImportDocumentInput,
  pool: Pool,
): Promise<ImportDocumentResult> {
  const { source, content, overlap = 100, chunk_size = 1500 } = input;

  if (!source || source.trim().length === 0) {
    throw new Error("source is required");
  }
  if (!content || content.trim().length === 0) {
    throw new Error("content is required");
  }

  // 获取 embedding 服务
  const embedder = getEmbeddingService();
  if (!embedder) {
    throw new Error(
      "Embedding service is not available. Check EMBEDDING_PROVIDER and API keys.",
    );
  }
  const embeddingDim = getConfig().embeddingDimensions;

  // 分块
  const chunks = chunkBySemanticBoundaries(content, chunk_size, overlap);
  logger.info(
    `Document split into ${chunks.length} chunks for source: ${source}`,
  );

  // 获取默认 session
  let targetSessionId: string | undefined;
  if (input.session_id) {
    const sessionResult = await pool.query(
      "SELECT id FROM session_map WHERE opencode_session_id = $1",
      [input.session_id],
    );
    if (sessionResult.rows.length > 0) {
      targetSessionId = sessionResult.rows[0].id;
    }
  }
  if (!targetSessionId) {
    // 使用第一个可用 session
    const firstSession = await pool.query(
      "SELECT id FROM session_map ORDER BY created_at ASC LIMIT 1",
    );
    if (firstSession.rows.length > 0) {
      targetSessionId = firstSession.rows[0].id;
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. 删除旧数据
    const deleteResult = await client.query(
      "DELETE FROM observations WHERE source = $1",
      [source],
    );
    const deletedCount = deleteResult.rowCount ?? 0;
    logger.info(`Deleted ${deletedCount} old chunks for source: ${source}`);

    // 2. 逐块插入
    let importedCount = 0;
    for (const chunk of chunks) {
      const sourceHash = createHash("sha256")
        .update(chunk + source)
        .digest("hex");

      // 生成 embedding（异步但在此同步等待）
      let embedding: number[] | null = null;
      try {
        const rawEmbedding = await embedder.generateEmbedding(chunk);
        // 确保 embedding 维度匹配
        embedding = Array.isArray(rawEmbedding)
          ? rawEmbedding.slice(0, embeddingDim)
          : null;
      } catch (embedErr) {
        logger.warn(
          `Embedding failed for chunk, inserting without embedding: ${embedErr}`,
        );
      }

      if (embedding) {
        await client.query(
          `
          INSERT INTO observations (
            session_map_id, tool_name, tool_input_summary, embedding,
            importance, source, source_hash, metadata
          ) VALUES ($1, 'import_document', $2, $3::vector, 4, $4, $5, $6)
        `,
          [
            targetSessionId || null,
            chunk,
            embedding,
            source,
            sourceHash,
            JSON.stringify({ imported_at: new Date().toISOString() }),
          ],
        );
      } else {
        // 无 embedding 时插入空向量或跳过
        await client.query(
          `
          INSERT INTO observations (
            session_map_id, tool_name, tool_input_summary,
            importance, source, source_hash, metadata
          ) VALUES ($1, 'import_document', $2, 4, $3, $4, $5)
        `,
          [
            targetSessionId || null,
            chunk,
            source,
            sourceHash,
            JSON.stringify({ imported_at: new Date().toISOString() }),
          ],
        );
      }

      importedCount++;
    }

    await client.query("COMMIT");

    // 3. 事务外异步 REINDEX（避免事务内阻塞）
    pool
      .query(
        `
      REINDEX INDEX CONCURRENTLY idx_observations_embedding
    `,
      )
      .catch((err) => {
        logger.warn(`REINDEX failed (non-fatal): ${err}`);
      });

    logger.info(
      `Import complete: ${importedCount} chunks for source: ${source}`,
    );
    return {
      success: true,
      chunks_imported: importedCount,
      chunks_deleted: deletedCount,
      source,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    logger.error(`Import failed for source ${source}:`, error);
    throw error;
  } finally {
    client.release();
  }
}
