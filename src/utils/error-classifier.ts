/**
 * error-classifier.ts — 错误分类系统
 *
 * 对标 oh-my-openagent 的 52 钩子防御网。
 * 每类错误有明确分类、严重级别和推荐动作。
 * 不再静默吞异常——至少写 stderr 让用户知道。
 */

// ── 错误严重级别 ──────────────────────────────────────

export type ErrorSeverity = "fatal" | "error" | "warn" | "info";

// ── 错误分类 ──────────────────────────────────────────

export type ErrorCategory =
  | "connection" // 数据库连接失败
  | "query" // SQL 查询异常（语法、约束违反）
  | "embedding" // Embedding 服务调用失败
  | "config" // 配置错误或缺失
  | "data" // 数据完整性异常（如 source_hash 冲突）
  | "internal" // 插件内部逻辑 bug
  | "external"; // 外部服务（ollama, deepseek）返回异常

// ── 结构化错误类型 ─────────────────────────────────────

export interface ClassifiedError {
  category: ErrorCategory;
  severity: ErrorSeverity;
  message: string;
  context?: Record<string, unknown>;
  /** 该错误是否可自动恢复 */
  recoverable: boolean;
  /** 建议的用户操作 */
  suggestion?: string;
}

// ── 分类器 ────────────────────────────────────────────

const CATEGORY_PATTERNS: [
  RegExp,
  ErrorCategory,
  ErrorSeverity,
  boolean,
  string?,
][] = [
  // 连接类
  [
    /connect ECONNREFUSED/i,
    "connection",
    "fatal",
    false,
    "检查 PostgreSQL 是否运行，端口是否正确",
  ],
  [
    /connect ETIMEDOUT/i,
    "connection",
    "error",
    true,
    "检查网络连接或防火墙设置",
  ],
  [
    /password authentication failed/i,
    "connection",
    "fatal",
    true,
    "检查 PG_PASSWORD 环境变量或 .env 文件",
  ],
  [
    /database ".+" does not exist/i,
    "connection",
    "fatal",
    false,
    "创建数据库: CREATE DATABASE PGOMO",
  ],
  [
    /.+ database ".*" does not exist/i,
    "connection",
    "fatal",
    false,
    "数据库不存在，请运行初始化脚本",
  ],
  [
    /getaddrinfo ENOTFOUND/i,
    "connection",
    "fatal",
    true,
    "检查 PG_HOST 地址是否正确",
  ],

  // 查询类
  [
    /relation ".+" does not exist/i,
    "query",
    "error",
    false,
    "运行初始化 SQL 创建表结构",
  ],
  [/duplicate key value/i, "query", "warn", true, "数据已存在，跳过"],
  [
    /violates foreign key/i,
    "query",
    "error",
    false,
    "引用的 session 记录不存在",
  ],

  // Embedding 类
  [
    /ollama.*connection refused/i,
    "embedding",
    "warn",
    true,
    "检查 ollama 是否运行: ollama serve。降级为无向量检索",
  ],
  [
    /embedding.*timeout/i,
    "embedding",
    "warn",
    true,
    "embedding 请求超时，降级为无向量检索",
  ],
  [
    /qwen3-embedding.*not found/i,
    "embedding",
    "error",
    true,
    "ollama pull qwen3-embedding:0.6b",
  ],

  // 配置类
  [/invalid.*api.*key/i, "config", "error", true, "检查 API key 配置"],
  [
    /EMBEDDING_PROVIDER.*invalid/i,
    "config",
    "warn",
    true,
    "emebdding provider 只能是 ollama/deepseek/openai",
  ],

  // 外部服务
  [/5\d{2}/, "external", "error", true, "上游服务返回 5xx，等待后重试"],
  [/429/, "external", "warn", true, "请求限流，减速重试"],

  // 插件内部
  [
    /assertion failed/i,
    "internal",
    "fatal",
    false,
    "请联系开发者并提供错误日志",
  ],
  [
    /cannot read property/i,
    "internal",
    "error",
    false,
    "插件内部错误，请提交 issue",
  ],
];

/**
 * 对错误进行分类。
 * 优先匹配已知模式，未知错误归为 internal。
 */
export function classifyError(
  error: unknown,
  defaultCategory: ErrorCategory = "internal",
): ClassifiedError {
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  const stack = error instanceof Error ? error.stack : undefined;

  for (const [
    pattern,
    category,
    severity,
    recoverable,
    suggestion,
  ] of CATEGORY_PATTERNS) {
    if (pattern.test(message)) {
      return {
        category,
        severity,
        message: message.slice(0, 500),
        context: { stack },
        recoverable,
        suggestion,
      };
    }
  }

  return {
    category: defaultCategory,
    severity: "error",
    message: message.slice(0, 500),
    context: { stack },
    recoverable: false,
  };
}

// ── 日志输出 ──────────────────────────────────────────

/**
 * 记录一条已分类的错误。
 * 不再静默 swallow——至少写入 stderr。
 * 严重错误同时输出上下文帮助调试。
 */
export function reportError(classified: ClassifiedError): void {
  const tag = `[pg-memory] [${classified.severity.toUpperCase()}] [${classified.category}]`;

  if (classified.severity === "fatal" || classified.severity === "error") {
    console.error(`${tag} ${classified.message}`);
    if (classified.suggestion) console.error(`  → ${classified.suggestion}`);
  } else {
    console.warn(`${tag} ${classified.message}`);
  }
}

/**
 * 方便的 try/catch 包装器。
 * 用法：const result = await guard(pool.query(...), "query");
 */
export async function guard<T>(
  promise: Promise<T>,
  category: ErrorCategory = "internal",
): Promise<[T | null, ClassifiedError | null]> {
  try {
    const result = await promise;
    return [result, null];
  } catch (error) {
    const classified = classifyError(error, category);
    reportError(classified);
    return [null, classified];
  }
}

/**
 * 同步版 guard
 */
export function guardSync<T>(
  fn: () => T,
  category: ErrorCategory = "internal",
): [T | null, ClassifiedError | null] {
  try {
    return [fn(), null];
  } catch (error) {
    const classified = classifyError(error, category);
    reportError(classified);
    return [null, classified];
  }
}
