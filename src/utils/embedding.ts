import OpenAI from 'openai';

export interface EmbeddingConfig {
  provider: 'openai' | 'deepseek' | 'ollama';
  model: string;
  dimensions: number;
  batchSize: number;
}

// Ollama 默认参数
const DEFAULT_OLLAMA_MAX_TOKENS = 30000;  // 留 2K 安全余量
const AVG_CHARS_PER_TOKEN = 4;             // 平均每个 token 约 4 字符
const CHUNK_OVERLAP = 2000;                // 分段重叠 2K 字符，保证上下文连贯

export class EmbeddingService {
  private client: OpenAI | null;
  private config: EmbeddingConfig;

  constructor(config: EmbeddingConfig) {
    this.config = config;
    this.client = null;

    if (config.provider === 'deepseek') {
      this.client = new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      });
    } else if (config.provider === 'openai') {
      this.client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
    // ollama 不使用 OpenAI 客户端，直接调用本地 API
  }

  /**
   * 生成单个文本的 embedding
   * 对于长文本，自动分段嵌入后合并
   */
  async generateEmbedding(text: string): Promise<number[]> {
    try {
      // 1. 估算 token 数
      const estimatedTokens = Math.ceil(text.length / AVG_CHARS_PER_TOKEN);

      if (estimatedTokens <= DEFAULT_OLLAMA_MAX_TOKENS) {
        // 短文本：直接嵌入
        return this.embedSingleChunk(text);
      } else {
        // 长文本：分段嵌入 + 平均合并
        const maxChunkLength = DEFAULT_OLLAMA_MAX_TOKENS * AVG_CHARS_PER_TOKEN;
        const chunks = this.chunkText(text, maxChunkLength, CHUNK_OVERLAP);
        
        console.log(`[Embedding] Long text detected (${estimatedTokens} tokens), splitting into ${chunks.length} chunks`);
        
        const embeddings = await Promise.all(
          chunks.map(chunk => this.embedSingleChunk(chunk))
        );
        
        return this.averageEmbeddings(embeddings);
      }
    } catch (error) {
      console.error(`[Embedding] Failed to generate embedding:`, error);
      throw error;
    }
  }

  /**
   * 批量生成 embeddings
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    
    // 对于批量处理，我们仍然需要对每个文本单独处理（因为长度可能不同）
    for (const text of texts) {
      results.push(await this.generateEmbedding(text));
    }
    
    return results;
  }

  /**
   * 嵌入单个文本块
   */
  private async embedSingleChunk(text: string): Promise<number[]> {
    if (this.config.provider === 'ollama') {
      return await this.embedWithOllama(text);
    } else if (this.client) {
      const response = await this.client.embeddings.create({
        model: this.config.model,
        input: text,
        dimensions: this.config.dimensions,
      });
      return response.data[0].embedding;
    } else {
      throw new Error('No embedding client available');
    }
  }

  /**
   * 调用本地 Ollama API 生成 embedding
   */
  private async embedWithOllama(text: string): Promise<number[]> {
    const response = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        prompt: text,
        // qwen3-embedding 支持自定义维度 (32-1024)
        // 如果配置的维度在范围内，请求自定义；否则让模型使用默认维度
        ...(this.config.dimensions >= 32 && this.config.dimensions <= 1024 && {
          parameters: { output_dimension: this.config.dimensions }
        })
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${error}`);
    }

    const data = await response.json() as { embedding: number[] };
    return data.embedding;
  }

  /**
   * 将长文本切分成重叠的块
   */
  private chunkText(text: string, maxLength: number, overlap: number): string[] {
    const chunks: string[] = [];
    let start = 0;
    
    while (start < text.length) {
      const end = Math.min(start + maxLength, text.length);
      chunks.push(text.substring(start, end));
      start += maxLength - overlap;
    }
    
    return chunks;
  }

  /**
   * 平均合并多个 embeddings（向量的逐元素平均）
   */
  private averageEmbeddings(embeddings: number[][]): number[] {
    if (embeddings.length === 0) {
      return [];
    }

    const dim = embeddings[0].length;
    const avg = new Array(dim).fill(0);
    
    for (const emb of embeddings) {
      for (let i = 0; i < dim; i++) {
        avg[i] += emb[i];
      }
    }
    
    for (let i = 0; i < dim; i++) {
      avg[i] /= embeddings.length;
    }
    
    return avg;
  }
}

// 创建默认实例
export function createEmbeddingService(): EmbeddingService {
  const provider = (process.env.EMBEDDING_PROVIDER as 'openai' | 'deepseek' | 'ollama') || 'deepseek';
  const model = process.env.EMBEDDING_MODEL || 'deepseek-embedding';
  const dimensions = parseInt(process.env.EMBEDDING_DIMENSIONS || '1536', 10);
  const batchSize = parseInt(process.env.EMBEDDING_BATCH_SIZE || '100', 10);

  return new EmbeddingService({
    provider,
    model,
    dimensions,
    batchSize,
  });
}

// 共享单例实例（惰性初始化）
let _sharedService: EmbeddingService | null = null;

/**
 * 获取共享的 EmbeddingService 单例
 * 惰性初始化：首次调用时创建，后续调用返回同一实例。
 * 如果创建失败（如缺少 API Key），返回 null 而非抛出异常。
 */
export function getEmbeddingService(): EmbeddingService | null {
  if (!_sharedService) {
    try {
      _sharedService = createEmbeddingService();
      console.log(`[Embedding] Service initialized: provider=${process.env.EMBEDDING_PROVIDER || 'deepseek'}, model=${process.env.EMBEDDING_MODEL || 'deepseek-embedding'}, dimensions=${process.env.EMBEDDING_DIMENSIONS || '1536'}`);
    } catch (error) {
      console.warn('[Embedding] Failed to create embedding service:', error);
      return null;
    }
  }
  return _sharedService;
}