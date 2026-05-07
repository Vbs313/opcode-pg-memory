#!/usr/bin/env node
/**
 * doc-indexer.mjs — 文档知识库索引器
 *
 * 扫描项目文档 → 按语义边界分块 → 直连 PostgreSQL 导入 observations 表。
 * 与 import_document MCP 工具相同逻辑，但作为独立 CLI 运行。
 *
 * 用法：
 *   node .opencode/doc-indexer.mjs                    # 索引默认模式（docs/** *.md）
 *   node .opencode/doc-indexer.mjs --dir ./docs        # 指定目录
 *   node .opencode/doc-indexer.mjs --file README.md    # 指定单个文件
 *   node .opencode/doc-indexer.mjs --skip-embedding    # 不生成向量（纯文本索引）
 *
 * 依赖：pg（PostgreSQL 客户端），从 .env 读取数据库配置
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { resolve, relative, dirname, basename, extname, join } from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import pg from "pg"

// ── 配置 ──────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(__dirname, "..")
const ENV_FILE = resolve(PLUGIN_DIR, ".env")

// 默认扫描模式
const DEFAULT_PATTERNS = ["docs/**/*.md", "ARCHITECTURE.md", "CONTRIBUTING.md", "README.md", "*.md"]

/** 分块大小 */
const CHUNK_SIZE = 1500
const OVERLAP = 100

// ── .env 加载 ─────────────────────────────────────────

function loadEnv() {
  if (!existsSync(ENV_FILE)) {
    console.warn(`[doc-indexer] .env not found at ${ENV_FILE}, using process.env`)
    return
  }
  const content = readFileSync(ENV_FILE, "utf-8")
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (key && val && !process.env[key]) {
      process.env[key] = val
    }
  }
}

// ── 数据库 ─────────────────────────────────────────────

async function connectDB() {
  const pool = new pg.Pool({
    host: process.env.PG_HOST || "localhost",
    port: parseInt(process.env.PG_PORT || "5432"),
    database: process.env.PG_DATABASE || "PGOMO",
    user: process.env.PG_USER || "opencode",
    password: process.env.PG_PASSWORD || "123456",
    max: 1,
  })
  // 测试连接
  const client = await pool.connect()
  await client.query("SELECT 1")
  client.release()
  console.log(`[doc-indexer] connected to ${process.env.PG_HOST}:${process.env.PG_PORT}/${process.env.PG_DATABASE}`)
  return pool
}

// ── 文件发现 ──────────────────────────────────────────

function findFiles(baseDir, patterns) {
  const files = new Set()
  for (const pattern of patterns) {
    // 简单 glob 实现（匹配 **/*.md 和 *.md）
    if (pattern.includes("**")) {
      const [prefix] = pattern.split("/**")
      const searchDir = resolve(baseDir, prefix)
      walkDir(searchDir, (fp) => {
        if (fp.endsWith(".md")) files.add(fp)
      })
    } else {
      const fp = resolve(baseDir, pattern)
      if (existsSync(fp)) files.add(fp)
    }
  }
  return [...files].sort()
}

function walkDir(dir, callback) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    try {
      if (statSync(full).isDirectory()) {
        walkDir(full, callback)
      } else {
        callback(full)
      }
    } catch { /* skip */ }
  }
}

// ── Markdown 分块 ─────────────────────────────────────

function chunkMarkdown(content) {
  const chunks = []
  // 按 ## 或 ### 标题切分
  const lines = content.split("\n")
  let currentHeading = null
  let currentLines = []
  let currentLen = 0

  function flush() {
    if (currentLines.length === 0) return
    const text = currentLines.join("\n").trim()
    if (text.length > 0) {
      chunks.push({
        heading: currentHeading,
        text: currentHeading ? `# ${currentHeading}\n\n${text}` : text,
      })
    }
    currentLines = []
    currentLen = 0
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,3})\s+(.+)$/)
    if (headingMatch) {
      flush()
      currentHeading = headingMatch[2]
      // 包含标题行
      currentLines.push(line)
      currentLen += line.length + 1
    } else {
      currentLines.push(line)
      currentLen += line.length + 1
      // 如果当前块超过 chunkSize，强制切分
      if (currentLen > CHUNK_SIZE) {
        flush()
      }
    }
  }
  flush()

  // 如果没分出来块（没有标题），按段落切
  if (chunks.length <= 1) {
    chunks.length = 0
    const paragraphs = content.split(/\n\n+/).filter(p => p.trim())
    let current = ""
    for (const para of paragraphs) {
      if ((current + "\n\n" + para).length > CHUNK_SIZE) {
        if (current) chunks.push({ heading: null, text: current.trim() })
        current = para
      } else {
        current = current ? current + "\n\n" + para : para
      }
    }
    if (current) chunks.push({ heading: null, text: current.trim() })
  }

  return chunks
}

// ── Embedding（通过 ollama HTTP API） ─────────────────

async function generateEmbedding(text) {
  const provider = process.env.EMBEDDING_PROVIDER || "ollama"
  const model = process.env.EMBEDDING_MODEL || "qwen3-embedding:0.6b"

  if (provider === "ollama") {
    try {
      const resp = await fetch("http://localhost:11434/api/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
      })
      if (!resp.ok) throw new Error(`ollama returned ${resp.status}`)
      const data = await resp.json()
      return data.embedding
    } catch (e) {
      console.warn(`[doc-indexer] embedding failed: ${e.message}, skipping`)
      return null
    }
  }
  console.warn(`[doc-indexer] unknown embed provider: ${provider}, skipping embedding`)
  return null
}

// ── 导入 ───────────────────────────────────────────────

async function importDoc(pool, filePath, baseDir, skipEmbedding) {
  const relPath = relative(baseDir, filePath).replace(/\\/g, "/")
  const content = readFileSync(filePath, "utf-8")
  const chunks = chunkMarkdown(content)

  console.log(`[doc-indexer] ${relPath}: ${chunks.length} chunks`)

  const client = await pool.connect()
  try {
    await client.query("BEGIN")

    // 每个 chunk 一个 source 标识
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const source = `${relPath}#${chunk.heading || `chunk-${i + 1}`}`
      const sourceHash = createHash("sha256")
        .update(chunk.text + source)
        .digest("hex")

      // 删除旧记录（同一 source）
      await client.query("DELETE FROM observations WHERE source = $1", [source])

      // 生成 embedding
      let embedding = null
      if (!skipEmbedding) {
        embedding = await generateEmbedding(chunk.text)
      }

      if (embedding) {
        await client.query(`
          INSERT INTO observations
            (session_map_id, tool_name, tool_input_summary, embedding,
             importance, source, source_hash, metadata)
          VALUES (NULL, 'doc-indexer', $1, $2::vector, 4, $3, $4, $5)
        `, [
          chunk.text,
          embedding,
          source,
          sourceHash,
          JSON.stringify({ imported_at: new Date().toISOString(), file: relPath }),
        ])
      } else {
        await client.query(`
          INSERT INTO observations
            (session_map_id, tool_name, tool_input_summary,
             importance, source, source_hash, metadata)
          VALUES (NULL, 'doc-indexer', $1, 4, $2, $3, $4)
        `, [
          chunk.text,
          source,
          sourceHash,
          JSON.stringify({ imported_at: new Date().toISOString(), file: relPath }),
        ])
      }
    }

    await client.query("COMMIT")
    console.log(`[doc-indexer] ✓ ${relPath}: ${chunks.length} chunks indexed`)
    return chunks.length
  } catch (e) {
    await client.query("ROLLBACK")
    console.error(`[doc-indexer] ✗ ${relPath}: ${e.message}`)
    return 0
  } finally {
    client.release()
  }
}

// ── 主函数 ─────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const skipEmbedding = args.includes("--skip-embedding")
  const dirArg = args.find((a, i) => a === "--dir" && args[i + 1])
  const fileArg = args.find((a, i) => a === "--file" && args[i + 1])

  loadEnv()

  // 确定扫描根目录（默认当前工作目录）
  const baseDir = resolve(process.cwd())

  // 确定文件
  let files
  if (fileArg) {
    const fp = resolve(baseDir, fileArg)
    if (!existsSync(fp)) { console.error(`File not found: ${fp}`); process.exit(1) }
    files = [fp]
  } else if (dirArg) {
    const searchDir = resolve(baseDir, dirArg)
    files = findFiles(searchDir, ["**/*.md"])
  } else {
    files = findFiles(baseDir, DEFAULT_PATTERNS)
  }

  if (files.length === 0) {
    console.log("[doc-indexer] no matching files found")
    process.exit(0)
  }

  console.log(`[doc-indexer] found ${files.length} files, connecting to DB...`)

  const pool = await connectDB()
  let total = 0

  for (const file of files) {
    total += await importDoc(pool, file, baseDir, skipEmbedding)
  }

  await pool.end()
  console.log(`[doc-indexer] done: ${total} chunks from ${files.length} files`)
}

main().catch((e) => {
  console.error("[doc-indexer] fatal:", e.message)
  process.exit(1)
})
