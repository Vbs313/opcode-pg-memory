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

const logger = createLogger("output-compressor");

// ============================================================
// Config
// ============================================================

const MAX_LENGTH = 10_000;
const MAX_LINES = 200;
const REPEATED_LINE_LIMIT = 5;

// ============================================================
// Command-specific filter definitions
// 对标 rtk 的 TOML filter: match_command + strip_lines + max_lines + on_empty
// ============================================================

interface CommandFilter {
  match: RegExp;
  stripLines?: RegExp[];
  maxLines?: number;
  onEmpty?: string;
}

const COMMAND_FILTERS: CommandFilter[] = [
  {
    // npm install / ci / i: 去噪行, 保留 warning/error
    match: /^npm\s+(install|ci|i)\b/,
    stripLines: [
      /^\s*$/,
      /^npm (notice|warn|info) /,
      /^up to date/i,
      /^added \d+/,
      /^removed \d+/,
      /^\d+ packages?( are| is)/i,
      /^found \d+/i,
      /^audited \d+/i,
    ],
    maxLines: 60,
    onEmpty: "npm install completed",
  },
  {
    // pnpm install
    match: /^pnpm\s+(install|i|add)\b/,
    stripLines: [
      /^\s*$/,
      /^\+[\w@]/,
      /^(Progress|Resolving|Fetching|Downloading|Extracting)/i,
    ],
    maxLines: 40,
    onEmpty: "pnpm install completed",
  },
  {
    // ls / list: 只保留文件名
    match: /^(ls|list)\b/,
    stripLines: [/^total \d+$/, /^\s*$/],
    maxLines: 80,
    onEmpty: "(empty directory)",
  },
  {
    // find: 路径列表
    match: /^find\b/,
    maxLines: 100,
    onEmpty: "(no files found)",
  },
  {
    // grep: 匹配行
    match: /^grep\b/,
    maxLines: 100,
    onEmpty: "(no matches)",
  },
  {
    // cat / read: 大文件
    match: /^(cat|read)\b/,
    stripLines: [/^\s*$/],
    maxLines: 150,
  },
  {
    // git diff: 去文件头, 保留实际 diff
    match: /^git\s+diff\b/,
    stripLines: [
      /^diff --git /,
      /^index [0-9a-f]+\.\./,
      /^--- a\//,
      /^\+\+\+ b\//,
    ],
    maxLines: 150,
    onEmpty: "(no diff)",
  },
  {
    // git log
    match: /^git\s+log\b/,
    maxLines: 60,
  },
  {
    // git status
    match: /^git\s+status\b/,
    maxLines: 40,
  },
  {
    // cargo build / check / test
    match: /^cargo\s+(build|check|test)\b/,
    stripLines: [/^\s*$/, /^(Compiling|Checking|Finished| Downloaded)/],
    maxLines: 80,
    onEmpty: "cargo completed",
  },
  {
    // dotnet build
    match: /^dotnet\s+build\b/,
    stripLines: [/^\s*$/, /^(MSBuild|Build |Determining)/, /^\s+\w+ -> /],
    maxLines: 60,
  },
  {
    // psql: 去除连接噪音
    match: /^psql\b/,
    stripLines: [/^\s*$/, /^sslmode/i, /^SSL connection/i],
    maxLines: 80,
  },
];

// ============================================================
// Duplicate read prevention (openwolf 思路)
// ============================================================

const fileReadRegistry = new Map<string, Map<string, number>>();

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

export function clearReadRegistry(sessionId: string): void {
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
): CompressionResult | null {
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
  let mf: CommandFilter | undefined;
  for (const f of COMMAND_FILTERS) {
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
      `\n... [truncated at ${(ml3 / 1024).toFixed(0)}KB]`;
  }

  const saved = originalChars - result.length;
  if (saved < 100) return null;
  logger.info(
    `[${tool}] ${(originalChars / 1024).toFixed(0)}KB→${(result.length / 1024).toFixed(0)}KB (-${(saved / 1024) | 0}KB, ${Math.round((saved / originalChars) * 100)}%)`,
  );
  return {
    compressed: result,
    originalChars,
    compressedChars: result.length,
    savedChars: saved,
  };
}
