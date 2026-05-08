/**
 * errors.ts — 可区分的 Error 类层次
 *
 * 所有自定义异常继承 PgMemoryError，支持 instanceof 区分。
 * 与 error-classifier.ts 配合使用：
 *   - classifier 处理外部错误 (PG driver, HTTP, 第三方 API)
 *   - 本模块 Error 类用于插件内部 throw / catch
 *
 * 用法:
 *   throw new ConnectionError("PG host unreachable", { host: "..." });
 *   catch (e) { if (e instanceof ConnectionError) { ... } }
 */

import type { ErrorCategory, ErrorSeverity } from "../utils/error-classifier";

// ============================================================
// Base class
// ============================================================

export class PgMemoryError extends Error {
  public readonly category: ErrorCategory;
  public readonly severity: ErrorSeverity;
  public readonly recoverable: boolean;
  public readonly context?: Record<string, unknown>;
  public readonly suggestion?: string;

  constructor(
    message: string,
    category: ErrorCategory = "internal",
    severity: ErrorSeverity = "error",
    recoverable = false,
    context?: Record<string, unknown>,
    suggestion?: string,
  ) {
    super(message);
    this.name = "PgMemoryError";
    this.category = category;
    this.severity = severity;
    this.recoverable = recoverable;
    this.context = context;
    this.suggestion = suggestion;
  }
}

// ============================================================
// Concrete error types
// ============================================================

/** PostgreSQL 连接失败 (服务器未运行、网络不可达、认证失败) */
export class ConnectionError extends PgMemoryError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
    suggestion = "检查 PostgreSQL 是否运行，端口和凭据是否正确",
  ) {
    super(message, "connection", "fatal", false, context, suggestion);
    this.name = "ConnectionError";
  }
}

/** SQL 查询执行失败 */
export class QueryError extends PgMemoryError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "query", "error", false, context);
    this.name = "QueryError";
  }
}

/** Embedding API 调用失败 (Ollama/OpenAI/DeepSeek 不可用或返回异常) */
export class EmbeddingError extends PgMemoryError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
    suggestion = "检查 Embedding 服务 (Ollama/OpenAI/DeepSeek) 是否可用",
  ) {
    super(message, "embedding", "error", true, context, suggestion);
    this.name = "EmbeddingError";
  }
}

/** 配置缺失或无效 (API key 未设置、Zod 校验失败) */
export class ConfigurationError extends PgMemoryError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
    suggestion = "检查 ~/.opencode-pg-memory/.env 配置",
  ) {
    super(message, "config", "fatal", false, context, suggestion);
    this.name = "ConfigurationError";
  }
}

/** 数据完整性违反 (唯一约束、外键失败) */
export class DataIntegrityError extends PgMemoryError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "data", "error", false, context);
    this.name = "DataIntegrityError";
  }
}

/** 外部服务 (非 Embedding) 调用异常 */
export class ExternalServiceError extends PgMemoryError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
    suggestion = "检查外部服务状态和网络连接",
  ) {
    super(message, "external", "error", true, context, suggestion);
    this.name = "ExternalServiceError";
  }
}

/** 记忆检索无结果 (非错误，仅信息) */
export class RetrievalEmptyError extends PgMemoryError {
  constructor(context?: Record<string, unknown>) {
    super("No relevant memories found", "internal", "info", true, context);
    this.name = "RetrievalEmptyError";
  }
}

// ============================================================
// Classifier bridge — 从任意 Error 获取结构化信息
// ============================================================

import { classifyError } from "../utils/error-classifier";

/**
 * 将任意 Error 转为结构化 ClassifiedError。
 * - 如果是 PgMemoryError 子类，直接从属性读取
 * - 否则回退到 error-classifier 的字符串模式匹配
 */
export function classify(error: unknown): {
  category: ErrorCategory;
  severity: ErrorSeverity;
  message: string;
  recoverable: boolean;
  suggestion?: string;
} {
  if (error instanceof PgMemoryError) {
    return {
      category: error.category,
      severity: error.severity,
      message: error.message,
      recoverable: error.recoverable,
      suggestion: error.suggestion,
    };
  }
  // Fallback to string-pattern classifier
  return classifyError(error);
}
