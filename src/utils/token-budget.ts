import { EntityTier, RetrievedFact } from '../types';

export interface TokenBudgetConfig {
  contextLimitRatio: number;
  minTokens: number;
  maxTokens: number;
  tierWeights: {
    permanent: number;
    project: number;
    session: number;
  };
}

export const DEFAULT_TOKEN_BUDGET_CONFIG: TokenBudgetConfig = {
  contextLimitRatio: 0.05,
  minTokens: 500,
  maxTokens: 4000,
  tierWeights: {
    permanent: 0.5,
    project: 0.3,
    session: 0.2
  }
};

/**
 * 计算 Token 预算
 * Formula: MAX_INJECT_TOKENS = clamp(modelContextLimit * 0.05, 500, 4000)
 */
export function calculateTokenBudget(
  modelContextLimit: number,
  config: Partial<TokenBudgetConfig> = {}
): number {
  const mergedConfig = { ...DEFAULT_TOKEN_BUDGET_CONFIG, ...config };
  const rawBudget = Math.floor(modelContextLimit * mergedConfig.contextLimitRatio);
  return Math.max(
    mergedConfig.minTokens,
    Math.min(mergedConfig.maxTokens, rawBudget)
  );
}

/**
 * 估算文本的 token 数量
 * 简化版：假设平均每个 token 约 4 个字符（英文）或 2 个字符（中文）
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  
  // 检测中文字符比例
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const totalChars = text.length;
  const chineseRatio = chineseChars / totalChars;
  
  // 混合计算
  if (chineseRatio > 0.5) {
    // 主要中文：每个汉字约 1-2 tokens
    return Math.ceil(totalChars * 0.8);
  } else {
    // 主要英文：每个 token 约 4 个字符
    return Math.ceil(totalChars / 4);
  }
}

/**
 * 格式化实体为注入文本
 */
export function formatEntity(entity: {
  name: string;
  type: string;
  description?: string;
  tier: EntityTier;
  weight: number;
}): string {
  let formatted = `[${entity.type.toUpperCase()}] ${entity.name}`;
  
  if (entity.description) {
    formatted += `: ${entity.description}`;
  }
  
  formatted += ` (tier: ${entity.tier}, weight: ${entity.weight.toFixed(2)})`;
  
  return formatted;
}

/**
 * 格式化反思为注入文本
 */
export function formatReflection(reflection: {
  summary: string;
  pattern_type?: string;
  confidence: number;
}): string {
  let formatted = '[REFLECTION]';
  
  if (reflection.pattern_type) {
    formatted += ` (${reflection.pattern_type})`;
  }
  
  formatted += `: ${reflection.summary}`;
  formatted += ` (confidence: ${reflection.confidence.toFixed(2)})`;
  
  return formatted;
}

/**
 * 按 token 预算检索事实
 * 优先顺序：permanent > project > session
 */
export async function retrieveFactsWithBudget<T>(
  sessionId: string,
  modelContextLimit: number,
  fetchers: {
    fetchByTier: (sessionId: string, tier: EntityTier, limit: number) => Promise<T[]>;
    extractContent: (item: T) => { text: string; tokens: number };
  },
  config: Partial<TokenBudgetConfig> = {}
): Promise<RetrievedFact[]> {
  const mergedConfig = { ...DEFAULT_TOKEN_BUDGET_CONFIG, ...config };
  const budget = calculateTokenBudget(modelContextLimit, mergedConfig);
  const facts: RetrievedFact[] = [];
  let usedTokens = 0;
  
  // 按 tier 优先级检索
  const tierOrder: EntityTier[] = ['permanent', 'project', 'session'];
  const tierAllocation = {
    permanent: Math.floor(budget * mergedConfig.tierWeights.permanent),
    project: Math.floor(budget * mergedConfig.tierWeights.project),
    session: Math.floor(budget * mergedConfig.tierWeights.session)
  };
  
  for (const tier of tierOrder) {
    const tierBudget = tierAllocation[tier];
    let tierUsed = 0;
    
    // 获取候选列表（足够大的限制以确保我们有足够的选择）
    const candidates = await fetchers.fetchByTier(sessionId, tier, 100);
    
    for (const candidate of candidates) {
      const { text, tokens } = fetchers.extractContent(candidate);
      
      // 检查是否超出预算
      if (tierUsed + tokens <= tierBudget && usedTokens + tokens <= budget) {
        facts.push({
          id: `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          type: 'entity',
          content: text,
          tier,
          tokens,
          relevanceScore: 1.0, // 初始分数，后续可调整
          metadata: { source: candidate }
        });
        tierUsed += tokens;
        usedTokens += tokens;
      } else {
        break;
      }
    }
  }
  
  return facts;
}

/**
 * 截断文本以适应 token 预算
 */
export function truncateToTokenLimit(text: string, maxTokens: number): string {
  const estimatedTokens = estimateTokens(text);
  
  if (estimatedTokens <= maxTokens) {
    return text;
  }
  
  // 按比例截断
  const ratio = maxTokens / estimatedTokens;
  const targetLength = Math.floor(text.length * ratio);
  
  return text.substring(0, targetLength) + '... [truncated]';
}

/**
 * 计算注入内容的总 token 数
 */
export function calculateTotalTokens(facts: RetrievedFact[]): number {
  return facts.reduce((sum, fact) => sum + fact.tokens, 0);
}

/**
 * 检查是否超出预算并提供警告
 */
export function checkBudgetOverflow(
  facts: RetrievedFact[],
  budget: number
): { withinBudget: boolean; overflowTokens: number; warning?: string } {
  const totalTokens = calculateTotalTokens(facts);
  const overflowTokens = Math.max(0, totalTokens - budget);
  
  return {
    withinBudget: overflowTokens === 0,
    overflowTokens,
    warning: overflowTokens > 0 
      ? `Token budget exceeded by ${overflowTokens} tokens (${totalTokens}/${budget})`
      : undefined
  };
}