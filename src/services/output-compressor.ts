/**
 * output-compressor.ts
 *
 * 在 tool.execute.after 钩子中压缩工具输出，减少送入 LLM 上下文的 token。
 *
 * 设计参考:
 *   - rtk (Rust Token Killer): 命令特定 filter, strip_lines_matching + max_lines + on_empty
 *   - openwolf: pre-read 钩子检测重复文件读取，避免浪费
 *
 * 三层压缩:
 *   1. 命令特定模式 (npm/git/bash/ls/cat/find): 去噪行 + 保留关键结果
 *   2. 重复文件读取检测: 同一 session 内同一文件多次读取时拦截
 *   3. 通用规则 (所有命令): 空行折叠 + 重复行折叠 + 截断
 */

import { createLogger } from "../services/logger";
import { CompressionRule, getCompressionRules } from "../config";

const logger = createLogger("output-compressor");

// ============================================================
// Config
// ============================================================

const MAX_LENGTH = parseInt(
  process.env.PG_MEMORY_OUTPUT_MAX_CHARS || "10000",
  10,
);
const MAX_LINES = 200;
const REPEATED_LINE_LIMIT = 5;

// ============================================================
// Duplicate read prevention (openwolf 思路)
// ============================================================

const fileReadRegistry = new Map<string, Map<string, number>>();
const FILE_READ_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟

// 定期清理 fileReadRegistry，防止内存泄漏
let fileReadCleanupTimer: ReturnType<typeof setInterval> | null = null;
function ensureFileReadCleanup(): void {
  if (fileReadCleanupTimer) return;
  fileReadCleanupTimer = setInterval(() => {
    const size = fileReadRegistry.size;
    if (size === 0) return;
    fileReadRegistry.clear();
    logger.debug(`Cleared fileReadRegistry (was ${size} sessions)`);
  }, FILE_READ_CLEANUP_INTERVAL_MS);
  fileReadCleanupTimer.unref();
}
ensureFileReadCleanup();

function registerRead(
  sessionId: string,
  filePath: string,
): { isDuplicate: boolean; readCount: number } {
  if (!sessionId || !filePath) return { isDuplicate: false, readCount: 0 };
  if (!fileReadRegistry.has(sessionId))
    fileReadRegistry.set(sessionId, new Map());
  const session = fileReadRegistry.get(sessionId)!;
  const count = (session.get(filePath) || 0) + 1;
  session.set(filePath, count);
  return { isDuplicate: count > 2, readCount: count };
}

function clearReadRegistry(sessionId: string): void {
  fileReadRegistry.delete(sessionId);
}

// ============================================================
// Main
// ============================================================

export interface CompressionResult {
  compressed: string;
  originalChars: number;
  compressedChars: number;
  savedChars: number;
}

function detectTool(toolName?: string): string {
  return toolName || "unknown";
}

export function compressOutput(
  output: string,
  options?: { toolName?: string; sessionId?: string; filePath?: string },
  rules?: CompressionRule[],
): CompressionResult | null {
  const effectiveRules = rules || getCompressionRules();
  if (!output || output.length < 500) return null;
  const originalChars = output.length;
  let result = output;
  const tool = detectTool(options?.toolName);
  const filters: string[] = [];

  // ── Stage 1: 重复文件读取检测 ──
  if (options?.sessionId && options?.filePath && tool === "read") {
    const { isDuplicate, readCount } = registerRead(
      options.sessionId,
      options.filePath,
    );
    if (isDuplicate) {
      result = `[${options.filePath} already read ${readCount - 1}x this session — see above]`;
      return {
        compressed: result,
        originalChars,
        compressedChars: result.length,
        savedChars: originalChars - result.length,
      };
    }
  }

  // ── Stage 2: 命令特定 filter ──
  let mf: CompressionRule | undefined;
  for (const f of effectiveRules) {
    if (f.match.test(tool)) {
      mf = f;
      break;
    }
  }
  if (!mf) {
    // 通过内容判断常见命令
    const fl = output.split("\n")[0] || "";
    if (/^(error|Error|FAIL)/.test(fl))
      mf = { match: /^/, stripLines: [/^\s*$/], maxLines: 100 };
  }

  if (mf) {
    filters.push("cmd");
    const lines = result.split("\n");
    const patterns = mf!.stripLines || [];
    const kept = lines.filter((l) => !patterns.some((p) => p.test(l)));
    result = kept.length === 0 && mf.onEmpty ? mf.onEmpty : kept.join("\n");
    const ml = mf.maxLines || MAX_LINES;
    const la = result.split("\n");
    if (la.length > ml) {
      result = la.slice(0, ml).join("\n") + `\n... [${la.length - ml} lines]`;
    }
  }

  // ── Stage 3: 通用规则 ──
  filters.push("generic");
  result = result.replace(/\n{3,}/g, "\n\n"); // 空行折叠
  const lns = result.split("\n"); // 重复行折叠
  const dd: string[] = [];
  let rc = 1;
  for (let i = 0; i < lns.length; i++) {
    if (
      i > 0 &&
      lns[i].trim() &&
      lns[i].trim() === (lns[i - 1]?.trim() || "")
    ) {
      rc++;
      if (rc > REPEATED_LINE_LIMIT) continue;
    } else {
      rc = 1;
    }
    dd.push(lns[i]);
  }
  result = dd.join("\n");

  const ml2 = mf?.maxLines || MAX_LINES;
  const ml3 = MAX_LENGTH;
  let la2 = result.split("\n");
  if (la2.length > ml2) {
    la2 = la2.slice(0, ml2);
    la2.push(`... [${result.split("\n").length - ml2} lines]`);
    result = la2.join("\n");
  }
  if (result.length > ml3) {
    result =
      result.substring(0, ml3) +
      `\n... [truncated at ${(ml3 / 1024).toFixed(0)}KB by opcode-pg-memory]`;
  }

  const saved = originalChars - result.length;
  if (saved < 100) return null;
  logger.info(
    `[${tool}] ${(originalChars / 1024).toFixed(0)}KB→${(result.length / 1024).toFixed(0)}KB (-${(saved / 1024) | 0}KB, ${Math.round((saved / originalChars) * 100)}%)`,
  );
  // 若压缩后仍超过典型 truncation 阈值，记录警告
  if (result.length > 4000) {
    logger.warn(
      `[${tool}] compressed output ${result.length}chars may still be truncated by platform`,
    );
  }
  return {
    compressed: result,
    originalChars,
    compressedChars: result.length,
    savedChars: saved,
  };
}
