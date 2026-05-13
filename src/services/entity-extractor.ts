/**
 * entity-extractor.ts — 从工具输出中提取实体（纯规则，零 LLM）
 *
 * 从 read/edit/write/ls/find/grep/lsp 等工具的输出中提取：
 * - 文件路径 → file 实体
 * - 类/函数/接口定义 → class/function/interface 实体
 * - 模块导入 → module 实体
 * - 文件→符号包含关系 → DEFINES 关系
 */

import type { EntitySeed, RelationSeed } from "./entity-store";

// ── 正则模式 ────────────────────────────────────────────

/** 匹配代码文件路径 (相对/绝对，常见扩展名) */
const FILE_PATH_RE =
  /(?:^|\s)((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|kt|swift|c|cpp|h|hpp|cs|rb|php|vue|svelte|css|scss|json|md|yaml|yml|toml|sql))/g;

/** 匹配函数/方法定义 */
const FUNCTION_DEF_RE =
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;

/** 匹配箭头函数常量定义 */
const ARROW_FUNC_RE =
  /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\(|function\s*\()/g;

/** 匹配类定义 */
const CLASS_DEF_RE = /(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;

/** 匹配接口定义 */
const INTERFACE_DEF_RE = /(?:^|\n)\s*(?:export\s+)?interface\s+(\w+)/g;

/** 匹配 ES module 导入 */
const IMPORT_RE =
  /(?:^|\n)\s*import\s+(?:\{\s*(\w+)[^}]*\}\s+)?(?:type\s+)?from\s+['"]([@\w\-/.]+)['"]/g;

/** 匹配 CommonJS require */
const REQUIRE_RE =
  /(?:^|\n)\s*(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([@\w\-/.]+)['"]\s*\)/g;

/** 匹配文件头部注释中的文件名提示（如 vim modeline, @file 等） */
const FILE_HINT_RE = /@file\s+(\S+)|@filename\s+(\S+)/gi;

/** 匹配 TypeScript 类型/类型别名定义 */
const TYPE_ALIAS_RE = /(?:^|\n)\s*(?:export\s+)?type\s+(\w+)\s*=/g;

/** 匹配枚举定义 */
const ENUM_DEF_RE = /(?:^|\n)\s*(?:export\s+)?enum\s+(\w+)/g;

// ── 工具分类 ────────────────────────────────────────────

const FILE_TOOLS = new Set(["read", "edit", "write", "create"]);
const BASH_TOOLS = new Set(["bash", "shell", "powershell"]);
const LSP_TOOLS = new Set([
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_symbols",
  "lsp_prepare_rename",
]);

/**
 * 从工具调用中提取实体和关系。
 * @param toolName 工具名
 * @param input 工具输入参数
 * @param output 工具输出文本
 * @returns 提取的实体和关系种子
 */
export function extractEntities(
  toolName: string,
  input: Record<string, unknown>,
  output: string,
): { entities: EntitySeed[]; relations: RelationSeed[] } {
  const entities: EntitySeed[] = [];
  const relations: RelationSeed[] = [];

  // ── 从文件路径工具提取（即使输出为空也提取文件路径） ──
  if (FILE_TOOLS.has(toolName)) {
    const filePath = (input?.filePath || input?.path || "") as string;
    if (filePath && filePath.length > 3) {
      entities.push({
        name: filePath,
        type: "file",
        description: `File: ${filePath}`,
      });
    }
  }

  if (!output || output.length < 3) return { entities, relations };

  // ── 从任意文本中提取文件路径 ──
  let match: RegExpExecArray | null;
  const seenPaths = new Set<string>();
  while ((match = FILE_PATH_RE.exec(output)) !== null) {
    const path = match[1];
    if (path.length > 3 && !seenPaths.has(path)) {
      seenPaths.add(path);
      entities.push({ name: path, type: "file" });
    }
  }

  // ── 提取符号定义（函数、类、接口等）─川
  const extractByRegex = (
    re: RegExp,
    type: "function" | "class" | "interface" | "type",
  ): void => {
    const seen = new Set<string>();
    while ((match = re.exec(output)) !== null) {
      const name = match[1];
      if (name.length >= 2 && !seen.has(name)) {
        seen.add(name);
        entities.push({ name, type });
      }
    }
  };

  extractByRegex(FUNCTION_DEF_RE, "function");
  extractByRegex(ARROW_FUNC_RE, "function");
  extractByRegex(CLASS_DEF_RE, "class");
  extractByRegex(INTERFACE_DEF_RE, "interface");
  extractByRegex(TYPE_ALIAS_RE, "type");
  extractByRegex(ENUM_DEF_RE, "class");

  // ── 提取模块导入 ──
  const seenModules = new Set<string>();
  while ((match = IMPORT_RE.exec(output)) !== null) {
    const moduleName = match[2];
    if (moduleName && moduleName.length > 2 && !seenModules.has(moduleName)) {
      seenModules.add(moduleName);
      entities.push({ name: moduleName, type: "module" });
    }
  }
  while ((match = REQUIRE_RE.exec(output)) !== null) {
    const moduleName = match[2];
    if (moduleName && moduleName.length > 2 && !seenModules.has(moduleName)) {
      seenModules.add(moduleName);
      entities.push({ name: moduleName, type: "module" });
    }
  }

  // ── LSP 工具特殊处理 ──
  if (LSP_TOOLS.has(toolName)) {
    const symbolRE = /['"`]([A-Za-z_]\w+)['"`]/g;
    while ((match = symbolRE.exec(output)) !== null) {
      const name = match[1];
      if (name.length >= 3) {
        // 智能猜测：首字母大写的可能是 class/interface，否则是 function
        const type = /^[A-Z]/.test(name) ? "class" : "function";
        entities.push({ name, type, weight: 0.5 }); // LSP 结果权重略低
      }
    }
  }

  // ── 关系生成：文件→符号 DEFINES ──
  const fileEntities = entities.filter((e) => e.type === "file");
  const symbolEntities = entities.filter(
    (e) => e.type !== "file" && e.type !== "module",
  );
  for (const file of fileEntities) {
    for (const sym of symbolEntities) {
      // 只有在文本中符号紧跟在文件路径后才认为是包含关系
      // 简化实现：只要在同一工具调用中出现就建立弱关联
      relations.push({
        sourceName: file.name,
        sourceType: "file",
        targetName: sym.name,
        targetType: sym.type,
        relationType: "references",
      });
    }
  }

  return { entities, relations };
}
