import { SemanticCacheManager } from '../src/cache/semantic-cache';

// Mock Pool
const mockQuery = jest.fn();
const mockPool = {
  query: mockQuery
} as any;

describe('SemanticCacheManager', () => {
  let cacheManager: SemanticCacheManager;

  beforeEach(() => {
    mockQuery.mockClear();
    cacheManager = new SemanticCacheManager(mockPool, {
      initialThreshold: 0.92,
      adjustmentStep: 0.02,
      minThreshold: 0.85,
      maxThreshold: 0.97,
      queryWindowSize: 100,
      enabled: true
    });
  });

  describe('checkCache', () => {
    it('should return miss when disabled', async () => {
      const disabledManager = new SemanticCacheManager(mockPool, { enabled: false } as any);
      const result = await disabledManager.checkCache('test query');
      expect(result.hit).toBe(false);
    });

    it('should return exact match hit', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'cache-1',
          response_text: JSON.stringify({ result: 'cached response' }),
          hit_count: 5,
          similarity_threshold: 0.92
        }]
      });

      const result = await cacheManager.checkCache('test query');
      
      expect(result.hit).toBe(true);
      expect(result.response).toBe(JSON.stringify({ result: 'cached response' }));
      expect(result.similarity).toBe(1.0);
    });

    it('should return miss when no match found', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // exact match
        .mockResolvedValueOnce({ rows: [] }); // semantic match

      const result = await cacheManager.checkCache('test query');
      
      expect(result.hit).toBe(false);
    });

    it('should handle semantic match', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // exact match
        .mockResolvedValueOnce({
          rows: [{
            id: 'cache-2',
            query_text: 'similar query',
            response_text: JSON.stringify({ result: 'semantic match' }),
            distance: 0.05 // 0.95 similarity
          }]
        });

      const result = await cacheManager.checkCache('test query');
      
      expect(result.hit).toBe(true);
      expect(result.similarity).toBe(0.95);
    });
  });

  describe('storeCache', () => {
    it('should store new cache entry', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // check existing
        .mockResolvedValueOnce({
          rows: [{ id: 'new-cache-id' }]
        });

      const id = await cacheManager.storeCache('query', 'response');
      
      expect(id).toBe('new-cache-id');
    });

    it('should update existing cache entry', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'existing-id' }]
      });

      const id = await cacheManager.storeCache('query', 'new response');
      
      expect(id).toBe('existing-id');
    });

    it('should return null when disabled', async () => {
      const disabledManager = new SemanticCacheManager(mockPool, { enabled: false } as any);
      const id = await disabledManager.storeCache('query', 'response');
      expect(id).toBeNull();
    });
  });

  describe('dynamic threshold adjustment', () => {
    it('should decrease threshold when hit rate is low', async () => {
      // Setup: 100 queries with 10 hits (10% hit rate)
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // exact match
        .mockResolvedValueOnce({ rows: [] }) // semantic match
        .mockResolvedValueOnce({ rows: [] }); // threshold log

      // Simulate 90 misses and 10 hits
      for (let i = 0; i < 90; i++) {
        mockQuery
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] });
        await cacheManager.checkCache(`miss query ${i}`);
      }

      for (let i = 0; i < 10; i++) {
        mockQuery
          .mockResolvedValueOnce({
            rows: [{
              id: `hit-${i}`,
              response_text: 'response',
              hit_count: i + 1
            }]
          });
        await cacheManager.checkCache(`hit query ${i}`);
      }

      // Threshold should have been decreased
      expect(cacheManager.getCurrentThreshold()).toBeLessThan(0.92);
    });
  });

  describe('getStats', () => {
    it('should return cache statistics', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          total: '100',
          pruned: '10',
          total_hits: '500',
          avg_hits: '5.0'
        }]
      });

      const stats = await cacheManager.getStats();
      
      expect(stats.totalEntries).toBe(100);
      expect(stats.prunedEntries).toBe(10);
      expect(stats.totalHits).toBe(500);
      expect(stats.averageHitCount).toBe(5.0);
    });
  });

  describe('cleanupExpiredCache', () => {
    it('should remove expired entries', async () => {
      mockQuery.mockResolvedValueOnce({
        rowCount: 5,
        rows: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }]
      });

      const removed = await cacheManager.cleanupExpiredCache(30);
      
      expect(removed).toBe(5);
    });
  });

  describe('setThreshold', () => {
    it('should update threshold', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await cacheManager.setThreshold(0.90);
      
      expect(cacheManager.getCurrentThreshold()).toBe(0.90);
    });

    it('should reject invalid threshold', async () => {
      await expect(cacheManager.setThreshold(0.5)).rejects.toThrow();
      await expect(cacheManager.setThreshold(1.0)).rejects.toThrow();
    });
  });
});