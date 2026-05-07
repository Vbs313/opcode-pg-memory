#!/usr/bin/env node
/**
 * Verify AsyncEmbedder can generate embeddings via Ollama and write to PG.
 *
 * Usage: node script/verify-embedder.js
 * Env: PG_PASSWORD (default: 123456), EMBEDDING_PROVIDER (default: ollama),
 *      EMBEDDING_MODEL (default: qwen3-embedding:0.6b), EMBEDDING_DIMENSIONS (default: 1024)
 */
const { Pool } = require("pg");
const pgvector = require("pgvector");

// Import compiled services from dist
const {
  initAsyncEmbedder,
  getAsyncEmbedder,
} = require("../dist/src/services/async-embedder");
const { getEmbeddingService } = require("../dist/src/utils/embedding");

const pool = new Pool({
  host: "localhost",
  port: 5432,
  database: "PGOMO",
  user: "opencode",
  password: process.env.PG_PASSWORD || "123456",
});

async function main() {
  console.log("=== AsyncEmbedder Verification ===\n");

  // 1. Check Ollama is reachable
  console.log("1. Testing Ollama connectivity...");
  const svc = getEmbeddingService();
  if (!svc) {
    console.log("  ✗ Embedding service not available");
    console.log("  Is Ollama running? Check: ollama list");
    await pool.end();
    process.exit(1);
  }

  try {
    const testEmb = await svc.generateEmbedding("test");
    console.log(`  ✓ Ollama responded (${testEmb.length} dims)`);
  } catch (e) {
    console.log(`  ✗ Ollama error: ${e.message}`);
    await pool.end();
    process.exit(1);
  }

  // 2. Initialize AsyncEmbedder with the pool
  initAsyncEmbedder(pool, { cooldownMs: 300000, minImportance: 3 });

  // 3. Insert test observation with importance=3 and NULL embedding
  console.log("\n2. Creating test observation...");
  const smResult = await pool.query("SELECT id FROM session_map LIMIT 1");
  if (smResult.rows.length === 0) throw new Error("No session_map entries");
  const smId = smResult.rows[0].id;

  const test = await pool.query(
    `
    INSERT INTO observations (session_map_id, tool_name, tool_input_summary, importance)
    VALUES ($1, '__embedder_test__', 'AsyncEmbedder verification test', 3)
    RETURNING id, created_at
  `,
    [smId],
  );
  const testId = test.rows[0].id;
  console.log(`  Created test observation: ${testId}`);

  // 4. Enqueue embedding via AsyncEmbedder
  console.log("\n3. Enqueuing embedding via AsyncEmbedder...");
  const embedder = getAsyncEmbedder();
  embedder.enqueue(
    "observations",
    testId,
    "AsyncEmbedder verification test",
    3,
  );
  console.log("  Enqueued. Queue length:", embedder.getQueueLength());

  // 5. Wait for processing
  console.log("\n4. Waiting 20s for embedding generation...");
  let qLen = embedder.getQueueLength();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    qLen = embedder.getQueueLength();
    process.stdout.write(`  ${19 - i}s remaining (queue: ${qLen})   \r`);
    if (qLen === 0) break;
  }
  console.log();

  // 6. Verify
  console.log("\n5. Verifying AsyncEmbedder result...");
  const check = await pool.query(
    "SELECT embedding IS NOT NULL as has_emb FROM observations WHERE id = $1",
    [testId],
  );
  const hasEmb = check.rows[0]?.has_emb;

  console.log(
    `  embedding IS NULL? ${!hasEmb} | IS NOT NULL? ${hasEmb} ${hasEmb ? "✅" : ""}`,
  );

  if (hasEmb) {
    const dim = await pool.query(
      "SELECT length(embedding::text) as len FROM observations WHERE id = $1",
      [testId],
    );
    console.log(`  Embedding stored (${dim.rows[0].len} chars)`);
    console.log("\n=== ASYNC EMBEDDER TEST PASSED ✅ ===");
    console.log(
      "  (AsyncEmbedder successfully generated and wrote embedding to PG)",
    );
  } else {
    // AsyncEmbedder likely failed due to vector format serialization
    // The pg driver serializes JS arrays as PG array literals {...} but
    // vector type expects [...] format. Fall back to direct write.
    console.log(
      "  ✗ AsyncEmbedder did not write embedding. Likely vector format issue.",
    );
    console.log(
      "  (pg driver serializes arrays as PG array format {...}, but vector expects [...])",
    );
    console.log();
    console.log("  Attempting direct write with correct vector format...");

    try {
      const emb = await svc.generateEmbedding(
        "AsyncEmbedder verification test",
      );
      const vecStr = pgvector.toSql(emb); // JSON.stringify -> "[0.1,0.2,...]"

      await pool.query(
        "UPDATE observations SET embedding = $1::vector WHERE id = $2 AND embedding IS NULL",
        [vecStr, testId],
      );

      const check2 = await pool.query(
        "SELECT embedding IS NOT NULL as has_emb FROM observations WHERE id = $1",
        [testId],
      );
      if (check2.rows[0]?.has_emb) {
        console.log(
          "  ✓ Direct write succeeded (vector format: JSON.stringify/[] style)",
        );
        console.log();
        console.log(
          "=== ASYNC EMBEDDER TEST FAILED ❌ (direct write WORKS though) ===",
        );
        console.log(
          "NOTE: The AsyncEmbedder source has a vector serialization bug.",
        );
        console.log(
          "It passes JS arrays directly to $1::vector, but the pg driver",
        );
        console.log(
          "serializes them as {...} (PG array format) instead of [...] (vector format).",
        );
        console.log();
        console.log(
          "Fix: Use pgvector.toSql(embedding) or format as string before passing to PG.",
        );
        console.log("See: dist/src/services/async-embedder.js line 55");
      } else {
        console.log("  ✗ Direct write also failed. Unknown issue.");
      }
    } catch (e) {
      console.log("  ✗ Direct write error:", e.message);
    }
  }

  // 7. Cleanup
  await pool.query("DELETE FROM observations WHERE id = $1", [testId]);
  await pool.end();

  // Exit 0 if embedding was stored (via either path)
  process.exit(hasEmb ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
