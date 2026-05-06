import { recallMemory, RecallMemoryInput } from '../src/mcp/recall-memory';
import { hindsightReflect, HindsightReflectInput } from '../src/mcp/hindsight-reflect';

// Mock Pool
const mockQuery = jest.fn();
const mockPool = {
  query: mockQuery
} as any;

describe('MCP Tools', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  describe('recall_memory', () => {
    it('should retrieve memories with semantic search', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'session-internal-id' }]
        }) // get session
        .mockResolvedValueOnce({
          rows: [{
            id: 'entity-1',
            name: 'TestEntity',
            type: 'function',
            tier: 'session',
            weight: 3.0,
            description: 'A test function',
            similarity: 0.95,
            confidence: 0.9,
            created_at: new Date()
          }]
        }) // semantic search entities
        .mockResolvedValueOnce({ rows: [] }) // observations
        .mockResolvedValueOnce({ rows: [] }); // reflections

      const input: RecallMemoryInput = {
        query: 'test function',
        session_id: 'session-123',
        retrieval_strategies: ['semantic' as const],
        max_results: 5
      };

      const result = await recallMemory(input, mockPool);
      
      expect(result.success).not.toBe(false);
      expect(result.results).toBeDefined();
      expect(result.strategies_used).toContain('semantic');
    });

    it('should apply filters correctly', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'session-internal-id' }]
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const input: RecallMemoryInput = {
        query: 'test',
        session_id: 'session-123',
        filters: {
          entity_types: ['function', 'class'],
          tier_levels: ['permanent' as const, 'project' as const],
          min_confidence: 0.7,
          time_range_days: 7
        }
      };

      await recallMemory(input, mockPool);
      
      // Verify filters were applied in queries
      const entityQuery = mockQuery.mock.calls[1][0];
      expect(entityQuery).toContain('type = ANY');
      expect(entityQuery).toContain('tier = ANY');
      expect(entityQuery).toContain('confidence >=');
    });

    it('should handle missing session', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const input: RecallMemoryInput = {
        query: 'test',
        session_id: 'non-existent-session'
      };

      await expect(recallMemory(input, mockPool)).rejects.toThrow('Session not found');
    });
  });

  describe('hindsight_reflect', () => {
    it('should perform reflection when threshold met', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'session-internal-id',
            reflection_last_at: null
          }]
        }) // get session
        .mockResolvedValueOnce({
          rows: Array(35).fill(null).map((_, i) => ({
            id: `obs-${i}`,
            tool_name: 'test_tool',
            tool_input_summary: 'input',
            tool_output_summary: 'output',
            importance: 3,
            created_at: new Date(),
            metadata: {}
          }))
        }) // get observations
        .mockResolvedValueOnce({
          rows: [{ id: 'reflection-1' }]
        }) // insert reflection
        .mockResolvedValueOnce({ rows: [] }) // update session
        .mockResolvedValueOnce({ rows: [] }); // clear pending

      const input: HindsightReflectInput = {
        session_id: 'session-123',
        trigger_type: 'manual' as const
      };

      const result = await hindsightReflect(input, mockPool);
      
      expect(result.success).toBe(true);
      expect(result.observations_processed).toBe(35);
    });

    it('should skip reflection when below threshold', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'session-internal-id',
            reflection_last_at: null
          }]
        })
        .mockResolvedValueOnce({
          rows: Array(10).fill(null).map((_, i) => ({
            id: `obs-${i}`,
            tool_name: 'test_tool',
            tool_output_summary: 'output',
            importance: 3,
            created_at: new Date()
          }))
        });

      const input: HindsightReflectInput = {
        session_id: 'session-123',
        observation_threshold: 30
      };

      const result = await hindsightReflect(input, mockPool);
      
      expect(result.success).toBe(true);
      expect(result.error).toContain('below threshold');
    });

    it('should handle reflection errors', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'session-internal-id',
            reflection_last_at: null
          }]
        })
        .mockRejectedValueOnce(new Error('DB error'));

      const input: HindsightReflectInput = {
        session_id: 'session-123',
        trigger_type: 'manual' as const
      };

      const result = await hindsightReflect(input, mockPool);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should support different model sizes', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'session-internal-id',
            reflection_last_at: null
          }]
        })
        .mockResolvedValueOnce({
          rows: Array(40).fill(null).map((_, i) => ({
            id: `obs-${i}`,
            tool_name: 'test_tool',
            tool_output_summary: 'output',
            importance: 3,
            created_at: new Date()
          }))
        })
        .mockResolvedValueOnce({ rows: [{ id: 'reflection-1' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const input: HindsightReflectInput = {
        session_id: 'session-123',
        trigger_type: 'manual' as const,
        model_size: '14b' as const
      };

      const result = await hindsightReflect(input, mockPool);
      
      expect(result.success).toBe(true);
    });
  });
});
