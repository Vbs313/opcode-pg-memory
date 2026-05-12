/**
 * output-compressor.ts
 *
 * 在 tool.execute.after 钩子中压缩工具输出，减少送入 LLM 上下文的 token。
 * 对标 rtk 的"减少工具输出膨胀"思路，但在 OpenCode Plugin 层面实现。
 *
 * 策略：
 *   1. 超长截断（默认 10KB）
 *   2. 连续重复行折叠（"重复了 15 次"）
 *   3. 连续空行压缩为最多 2 行
 *   4. npm/build 日志的去冗
 */

import { getConfig } from "../config";
import { createLogger } from "../services/logger";

const logger = createLogger("output-compressor");

// ============================================================
// Config
// ============================================================

const DEFAULT_MAX_LENGTH = 10_000; // 10KB
const MAX_LINES = 200; // 最多保留 200 行
const REPEATED_LINE_LIMIT = 5; // 连续重复超过 5 行就折叠

// ============================================================
// Public API
// ============================================================

export interface CompressionResult {
  compressed: string;
  originalChars: number;
  compressedChars: number;
  savedChars: number;
}

/**
 * 压缩工具输出。修改 output.output 前调用。
 */
export function compressOutput(output: string): CompressionResult | null {
  if (!output || output.length < 1000) return null; // 短输出不处理

  const originalChars = output.length;

  // 配置阈值（可通过 settings.json 覆盖）
  const maxLen = getConfig().maxOutputLength || DEFAULT_MAX_LENGTH;
  const maxLines = getConfig().maxOutputLines || MAX_LINES;

  let result = output;

  // 1. 折叠重复空行
  result = result.replace(/\n{3,}/g, "\n\n");

  // 2. 折叠连续重复行（同一行重复 5 次以上）
  const lines = result.split("\n");
  const deduped: string[] = [];
  let repeatCount = 1;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && lines[i] === lines[i - 1]) {
      repeatCount++;
      if (repeatCount > REPEATED_LINE_LIMIT) continue;
    } else {
      repeatCount = 1;
    }
    deduped.push(lines[i]);
  }
  if (deduped.length < lines.length) {
    const folded = lines.length - deduped.length;
    logger.debug(`Folded ${folded} repeated lines`);
  }
  result = deduped.join("\n");

  // 3. 截断行数
  const finalLines = result.split("\n");
  if (finalLines.length > maxLines) {
    result = finalLines.slice(0, maxLines).join("\n");
    result += `\n... [${finalLines.length - maxLines} more lines truncated]`;
  }

  // 4. 截断长度
  if (result.length > maxLen) {
    result = result.substring(0, maxLen);
    result += `\n... [output truncated at ${(maxLen / 1024).toFixed(0)}KB]`;
  }

  const compressedChars = result.length;
  const savedChars = originalChars - compressedChars;

  if (savedChars < 100) return null; // 节省太少就不报告

  logger.info(
    `Output compressed: ${(originalChars / 1024).toFixed(0)}KB → ${(compressedChars / 1024).toFixed(0)}KB (saved ${(savedChars / 1024).toFixed(0)}KB)`,
  );

  return { compressed: result, originalChars, compressedChars, savedChars };
}
