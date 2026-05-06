import { Pool } from 'pg';
import * as crypto from 'crypto';
import { SemanticCache, CacheResult } from '../types';

export interface SemanticCacheConfig {
  initialThreshold: number;
  adjustmentStep: number;
  minThreshold: number;
  maxThreshold: number;
  queryWindowSize: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: SemanticCacheConfig = {
  initialThreshold: 0.92,
  adjustmentStep: 0.02,
  minThreshold: 0.85,
  maxThreshold: 0.97,
  queryWindowSize: 100,
  enabled: true
};

/**
 * 语义缓存管理器
 * 
 * 功能：
 * 1. 使用 HNSW 索引实现亚 10ms 级检索
 * 2. 动态阈值调整（初始 0.92，每 100 次查询根据命中率 ±0.02）
 * 3. 与 DCP 协同，设置最高检索优先级
 * 4. 缓存命中后直接返回，零 token 消耗
 */
export class SemanticCacheManager {
  private pool: Pool;
  private config: SemanticCacheConfig;
  private currentThreshold: number;
  private queryCount: number;
  private hitCount: number;

  constructor(pool: Pool, config: Partial<SemanticCacheConfig> = {}) {
    this.pool = pool;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentThreshold = this.config.initialThreshold;
    this.queryCount = 0;
    this.hitCount = 0;
  }

  /**
   * 检查缓存
   * 
   * 流程：
   * 1. 生成查询哈希
   * 2. 使用 HNSW 索引快速检索候选
   * 3. 检查相似度是否达到阈值
   * 4. 更新命中统计
   */
  async checkCache(queryText: string): Promise<CacheResult & { 
    cached?: boolean;
    cacheId?: string;
    similarity?: number;
  }> {
    if (!this.config.enabled) {
      return { hit: false };
    }

    const startTime = Date.now();
    
    try {
      // 1. 生成查询哈希
      const queryHash = this.generateQueryHash(queryText);
      
      // 2. 首先尝试精确匹配（哈希匹配）
      const exactMatch = await this.pool.query(`
        SELECT id, response_text, hit_count, similarity_threshold
        FROM semantic_cache
        WHERE query_hash = $1 AND is_pruned = FALSE
      `, [queryHash]);
      
      if (exactMatch.rows.length > 0) {
        const cached = exactMatch.rows[0];
        
        // 更新命中统计
        await this.recordHit(cached.id);
        
        console.log(`[PG Memory] Cache HIT (exact): ${queryText.substring(0, 50)}...`);
        
        return {
          hit: true,
          response: cached.response_text,
          similarity: 1.0,
          cached: true,
          cacheId: cached.id
        };
      }
      
      // 3. 语义相似度匹配
      // 注意：实际应生成 embedding，这里简化处理
      const queryEmbedding = await this.generateQueryEmbedding(queryText);
      
      // 使用 HNSW 索引快速检索候选
      const candidates = await this.pool.query(`
        SELECT id, query_text, response_text, query_embedding <=> $1 as distance,
               similarity_threshold
        FROM semantic_cache
        WHERE is_pruned = FALSE
        ORDER BY query_embedding <=> $1
        LIMIT 5
      `, [queryEmbedding]);
      
      // 4. 检查是否命中
      for (const candidate of candidates.rows) {
        const similarity = 1 - candidate.distance; // 距离转相似度
        
        if (similarity >= this.currentThreshold) {
          // 命中：更新统计
          await this.recordHit(candidate.id);
          
          const retrievalTime = Date.now() - startTime;
          console.log(`[PG Memory] Cache HIT (semantic): similarity=${similarity.toFixed(3)}, time=${retrievalTime}ms`);
          
          return {
            hit: true,
            response: candidate.response_text,
            similarity,
            cached: true,
            cacheId: candidate.id
          };
        }
      }
      
      // 未命中
      await this.recordMiss();
      
      console.log(`[PG Memory] Cache MISS: ${queryText.substring(0, 50)}...`);
      
      return {
        hit: false,
        cached: false
      };
      
    } catch (error) {
      console.error('[PG Memory] Cache check error:', error);
      return { hit: false };
    }
  }

  /**
   * 存储缓存
   */
  async storeCache(
    queryText: string,
    responseText: string,
    sessionId?: string
  ): Promise<string | null> {
    if (!this.config.enabled) {
      return null;
    }

    try {
      const queryHash = this.generateQueryHash(queryText);
      const queryEmbedding = await this.generateQueryEmbedding(queryText);
      
      // 检查是否已存在
      const existing = await this.pool.query(
        'SELECT id FROM semantic_cache WHERE query_hash = $1',
        [queryHash]
      );
      
      if (existing.rows.length > 0) {
        // 更新现有记录
        await this.pool.query(`
          UPDATE semantic_cache
          SET response_text = $1,
              hit_count = hit_count + 1,
              last_hit_at = NOW(),
              is_pruned = FALSE
          WHERE id = $2
        `, [responseText, existing.rows[0].id]);
        
        return existing.rows[0].id;
      }
      
      // 创建新记录
      const result = await this.pool.query(`
        INSERT INTO semantic_cache (
          query_hash, query_text, query_embedding, response_text,
          similarity_threshold, session_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [
        queryHash,
        queryText,
        queryEmbedding,
        responseText,
        this.currentThreshold,
        sessionId || null
      ]);
      
      console.log(`[PG Memory] Cache stored: ${queryText.substring(0, 50)}...`);
      
      return result.rows[0].id;
      
    } catch (error) {
      console.error('[PG Memory] Cache store error:', error);
      return null;
    }
  }

  /**
   * 记录缓存命中
   */
  private async recordHit(cacheId: string): Promise<void> {
    this.hitCount++;
    this.queryCount++;
    
    await this.pool.query(`
      UPDATE semantic_cache
      SET hit_count = hit_count + 1,
          last_hit_at = NOW()
      WHERE id = $1
    `, [cacheId]);
    
    await this.maybeAdjustThreshold();
  }

  /**
   * 记录缓存未命中
   */
  private async recordMiss(): Promise<void> {
    this.queryCount++;
    await this.maybeAdjustThreshold();
  }

  /**
   * 动态调整阈值
   * 
   * 策略：
   * - 每 100 次查询检查一次
   * - 命中率 < 30%：降低阈值（提高命中率）
   * - 命中率 > 80%：提高阈值（提高精确度）
   */
  private async maybeAdjustThreshold(): Promise<void> {
    if (this.queryCount % this.config.queryWindowSize !== 0) {
      return;
    }
    
    const hitRate = this.hitCount / this.queryCount;
    let adjustment: 'increase' | 'decrease' | 'none' = 'none';
    let newThreshold = this.currentThreshold;
    
    if (hitRate < 0.3 && this.currentThreshold > this.config.minThreshold) {
      // 命中率过低，降低阈值
      newThreshold = Math.max(
        this.config.minThreshold,
        this.currentThreshold - this.config.adjustmentStep
      );
      adjustment = 'decrease';
    } else if (hitRate > 0.8 && this.currentThreshold < this.config.maxThreshold) {
      // 命中率过高，提高阈值（避免过度匹配）
      newThreshold = Math.min(
        this.config.maxThreshold,
        this.currentThreshold + this.config.adjustmentStep
      );
      adjustment = 'increase';
    }
    
    if (adjustment !== 'none' && newThreshold !== this.currentThreshold) {
      this.currentThreshold = newThreshold;
      
      // 记录调整日志
      await this.pool.query(`
        INSERT INTO cache_threshold_log (threshold_value, hit_rate, query_count, adjustment_reason)
        VALUES ($1, $2, $3, $4)
      `, [
        this.currentThreshold,
        hitRate,
        this.queryCount,
        `auto_${adjustment}`
      ]);
      
      console.log(`[PG Memory] Cache threshold adjusted: ${adjustment} to ${this.currentThreshold.toFixed(2)} (hit rate: ${(hitRate * 100).toFixed(1)}%)`);
    }
    
    // 重置计数器
    this.hitCount = 0;
    this.queryCount = 0;
  }

  /**
   * 生成查询哈希
   */
  private generateQueryHash(queryText: string): string {
    // 规范化查询文本
    const normalized = queryText
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    
    return crypto
      .createHash('sha256')
      .update(normalized)
      .digest('hex');
  }

  /**
   * 生成查询向量
   * 
   * 注意：实际应调用 embedding API
   */
  private async generateQueryEmbedding(queryText: string): Promise<number[]> {
    // 实际应调用 embedding API
    // 例如：return await openai.embeddings.create({ input: queryText, model: 'text-embedding-3-small' });
    
    // 简化版：返回随机向量（仅用于演示）
    return new Array(1536).fill(0).map(() => (Math.random() - 0.5) * 0.1);
  }

  /**
   * 标记缓存为已压缩（DCP 协同）
   */
  async markAsPruned(cacheId: string): Promise<void> {
    await this.pool.query(`
      UPDATE semantic_cache
      SET is_pruned = TRUE
      WHERE id = $1
    `, [cacheId]);
  }

  /**
   * 批量标记缓存为已压缩
   */
  async markMultipleAsPruned(cacheIds: string[]): Promise<void> {
    if (cacheIds.length === 0) return;
    
    await this.pool.query(`
      UPDATE semantic_cache
      SET is_pruned = TRUE
      WHERE id = ANY($1)
    `, [cacheIds]);
  }

  /**
   * 获取缓存统计
   */
  async getStats(): Promise<{
    totalEntries: number;
    prunedEntries: number;
    totalHits: number;
    currentThreshold: number;
    averageHitCount: number;
  }> {
    const result = await this.pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE is_pruned = TRUE) as pruned,
        COALESCE(SUM(hit_count), 0) as total_hits,
        AVG(hit_count) as avg_hits
      FROM semantic_cache
    `);
    
    return {
      totalEntries: parseInt(result.rows[0].total, 10),
      prunedEntries: parseInt(result.rows[0].pruned, 10),
      totalHits: parseInt(result.rows[0].total_hits, 10),
      currentThreshold: this.currentThreshold,
      averageHitCount: parseFloat(result.rows[0].avg_hits || 0)
    };
  }

  /**
   * 清理过期缓存
   */
  async cleanupExpiredCache(maxAgeDays: number = 30): Promise<number> {
    const result = await this.pool.query(`
      DELETE FROM semantic_cache
      WHERE last_hit_at < NOW() - INTERVAL '${maxAgeDays} days'
        AND hit_count < 5
      RETURNING id
    `);
    
    console.log(`[PG Memory] Cleaned up ${result.rowCount} expired cache entries`);
    
    return result.rowCount;
  }

  /**
   * 获取当前阈值
   */
  getCurrentThreshold(): number {
    return this.currentThreshold;
  }

  /**
   * 手动设置阈值
   */
  async setThreshold(threshold: number): Promise<void> {
    if (threshold < this.config.minThreshold || threshold > this.config.maxThreshold) {
      throw new Error(`Threshold must be between ${this.config.minThreshold} and ${this.config.maxThreshold}`);
    }
    
    this.currentThreshold = threshold;
    
    // 记录手动调整
    await this.pool.query(`
      INSERT INTO cache_threshold_log (threshold_value, adjustment_reason)
      VALUES ($1, $2)
    `, [threshold, 'manual']);
    
    console.log(`[PG Memory] Cache threshold manually set to: ${threshold}`);
  }
}

/**
 * 带缓存优先级的查询包装器
 * 
 * 使用方式：
 * 1. 首先检查语义缓存
 * 2. 缓存命中：直接返回，零 token 消耗
 * 3. 缓存未命中：执行实际查询，并存入缓存
 */
export async function queryWithCachePriority<T>(
  queryText: string,
  actualQuery: () => Promise<T>,
  cacheManager: SemanticCacheManager,
  shouldCache?: (result: T) => boolean
): Promise<{
  result: T;
  fromCache: boolean;
  similarity?: number;
}> {
  // 1. 首先检查语义缓存
  const cacheResult = await cacheManager.checkCache(queryText);
  
  if (cacheResult.hit && cacheResult.response) {
    // 缓存命中：直接返回
    return {
      result: JSON.parse(cacheResult.response) as T,
      fromCache: true,
      similarity: cacheResult.similarity
    };
  }
  
  // 2. 缓存未命中：执行实际查询
  const result = await actualQuery();
  
  // 3. 存入缓存（如果符合条件）
  const shouldStore = shouldCache ? shouldCache(result) : true;
  if (shouldStore) {
    await cacheManager.storeCache(queryText, JSON.stringify(result));
  }
  
  return {
    result,
    fromCache: false
  };
}

/**
 * 创建缓存管理器实例
 */
export function createCacheManager(
  pool: Pool,
  config?: Partial<SemanticCacheConfig>
): SemanticCacheManager {
  return new SemanticCacheManager(pool, config);
}