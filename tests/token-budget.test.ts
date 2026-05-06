import {
  calculateTokenBudget,
  estimateTokens,
  formatEntity,
  formatReflection,
  truncateToTokenLimit,
  calculateTotalTokens,
  checkBudgetOverflow
} from '../src/utils/token-budget';

describe('Token Budget Utilities', () => {
  describe('calculateTokenBudget', () => {
    it('should calculate 5% of context limit', () => {
      expect(calculateTokenBudget(128000)).toBe(6400);
      expect(calculateTokenBudget(200000)).toBe(10000);
    });

    it('should respect min tokens limit', () => {
      expect(calculateTokenBudget(1000)).toBe(500); // min is 500
    });

    it('should respect max tokens limit', () => {
      expect(calculateTokenBudget(1000000)).toBe(4000); // max is 4000
    });

    it('should use custom config', () => {
      expect(calculateTokenBudget(100000, {
        contextLimitRatio: 0.1,
        minTokens: 100,
        maxTokens: 5000
      })).toBe(5000);
    });
  });

  describe('estimateTokens', () => {
    it('should estimate English text', () => {
      const text = 'Hello world';
      expect(estimateTokens(text)).toBeGreaterThan(0);
    });

    it('should estimate Chinese text', () => {
      const text = '你好世界';
      expect(estimateTokens(text)).toBeGreaterThan(0);
    });

    it('should handle empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('should handle mixed content', () => {
      const text = 'Hello 世界';
      expect(estimateTokens(text)).toBeGreaterThan(0);
    });
  });

  describe('formatEntity', () => {
    it('should format entity with description', () => {
      const entity = {
        name: 'testFunction',
        type: 'function',
        tier: 'session' as const,
        weight: 2.5,
        description: 'A test function'
      };
      
      const formatted = formatEntity(entity);
      expect(formatted).toContain('testFunction');
      expect(formatted).toContain('FUNCTION');
      expect(formatted).toContain('A test function');
    });

    it('should format entity without description', () => {
      const entity = {
        name: 'MyClass',
        type: 'class',
        tier: 'permanent' as const,
        weight: 5.0
      };
      
      const formatted = formatEntity(entity);
      expect(formatted).toContain('MyClass');
      expect(formatted).toContain('CLASS');
    });
  });

  describe('formatReflection', () => {
    it('should format reflection with pattern type', () => {
      const reflection = {
        summary: 'Test pattern summary',
        pattern_type: 'error_pattern',
        confidence: 0.85
      };
      
      const formatted = formatReflection(reflection);
      expect(formatted).toContain('Test pattern summary');
      expect(formatted).toContain('error_pattern');
      expect(formatted).toContain('0.85');
    });

    it('should format reflection without pattern type', () => {
      const reflection = {
        summary: 'Generic reflection',
        confidence: 0.75
      };
      
      const formatted = formatReflection(reflection);
      expect(formatted).toContain('Generic reflection');
    });
  });

  describe('truncateToTokenLimit', () => {
    it('should not truncate short text', () => {
      const text = 'Short text';
      expect(truncateToTokenLimit(text, 100)).toBe(text);
    });

    it('should truncate long text', () => {
      const text = 'A'.repeat(10000);
      const truncated = truncateToTokenLimit(text, 100);
      expect(truncated.length).toBeLessThan(text.length);
      expect(truncated).toContain('[truncated]');
    });
  });

  describe('calculateTotalTokens', () => {
    it('should sum tokens correctly', () => {
      const facts = [
        { type: 'entity' as const, content: 'test', tokens: 10, relevanceScore: 1, metadata: {} },
        { type: 'entity' as const, content: 'test2', tokens: 20, relevanceScore: 1, metadata: {} },
        { type: 'entity' as const, content: 'test3', tokens: 30, relevanceScore: 1, metadata: {} }
      ];
      
      expect(calculateTotalTokens(facts)).toBe(60);
    });

    it('should handle empty array', () => {
      expect(calculateTotalTokens([])).toBe(0);
    });
  });

  describe('checkBudgetOverflow', () => {
    it('should return within budget when under limit', () => {
      const facts = [
        { type: 'entity' as const, content: 'test', tokens: 100, relevanceScore: 1, metadata: {} }
      ];
      
      const result = checkBudgetOverflow(facts, 500);
      expect(result.withinBudget).toBe(true);
      expect(result.overflowTokens).toBe(0);
      expect(result.warning).toBeUndefined();
    });

    it('should detect overflow', () => {
      const facts = [
        { type: 'entity' as const, content: 'test', tokens: 600, relevanceScore: 1, metadata: {} }
      ];
      
      const result = checkBudgetOverflow(facts, 500);
      expect(result.withinBudget).toBe(false);
      expect(result.overflowTokens).toBe(100);
      expect(result.warning).toContain('exceeded');
    });
  });
});