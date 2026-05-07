import { aggregateConsecutiveSimilar } from '../src/mcp/recall-memory';

// InternalFact shape (as used by aggregateConsecutiveSimilar)
interface FactFixture {
  id?: string;
  type: 'entity' | 'observation' | 'reflection' | 'relation' | 'message';
  content: string;
  relevanceScore: number;
  metadata: Record<string, any>;
  tokens: number;
  _sessionId?: string;
  _topicSegmentId?: string;
  _timestamp?: string;
}

// Helper: cast fixture to the expected type
function toFacts(items: FactFixture[]): any[] {
  return items;
}

describe('aggregateConsecutiveSimilar', () => {
  it('returns empty array for empty input', () => {
    const result = aggregateConsecutiveSimilar([]);
    expect(result).toEqual([]);
  });

  it('keeps single observation unchanged', () => {
    const input = toFacts([{
      type: 'observation',
      content: '[bash] ls -la',
      relevanceScore: 0.8,
      tokens: 0,
      metadata: { toolName: 'bash', source: 'semantic' },
    }]);
    const result = aggregateConsecutiveSimilar(input);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('[bash] ls -la');
  });

  it('aggregates consecutive same-tool observations', () => {
    const input = toFacts([
      { type: 'observation', content: '[bash] git status', relevanceScore: 0.7, tokens: 0, metadata: { toolName: 'bash', source: 'semantic' } },
      { type: 'observation', content: '[bash] npm test', relevanceScore: 0.8, tokens: 0, metadata: { toolName: 'bash', source: 'semantic' } },
      { type: 'observation', content: '[bash] npm run build', relevanceScore: 0.6, tokens: 0, metadata: { toolName: 'bash', source: 'semantic' } },
    ]);
    const result = aggregateConsecutiveSimilar(input);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('×3');
    expect(result[0].content).toContain('npm run build');
    expect(result[0].relevanceScore).toBe(0.7); // Math.max(first, last) = max(0.7, 0.6)
    expect(result[0].metadata.aggregated).toBe(true);
    expect(result[0].metadata.aggregateCount).toBe(3);
  });

  it('does not aggregate different tool_names even if consecutive', () => {
    const input = toFacts([
      { type: 'observation', content: '[bash] npm test', relevanceScore: 0.8, tokens: 0, metadata: { toolName: 'bash', source: 'semantic' } },
      { type: 'observation', content: '[read] package.json', relevanceScore: 0.7, tokens: 0, metadata: { toolName: 'read', source: 'semantic' } },
    ]);
    const result = aggregateConsecutiveSimilar(input);
    expect(result).toHaveLength(2); // no aggregation
  });

  it('does not aggregate non-observation types', () => {
    const input = toFacts([
      { type: 'entity', content: '[CLASS] Database', relevanceScore: 0.9, tokens: 0, metadata: { entityType: 'class', source: 'semantic' } },
      { type: 'entity', content: '[CLASS] ConnectionPool', relevanceScore: 0.8, tokens: 0, metadata: { entityType: 'class', source: 'semantic' } },
    ]);
    const result = aggregateConsecutiveSimilar(input);
    expect(result).toHaveLength(2);
  });

  it('aggregates multiple separate blocks independently', () => {
    const input = toFacts([
      { type: 'observation', content: '[read] a.txt', relevanceScore: 0.5, tokens: 0, metadata: { toolName: 'read', source: 'semantic' } },
      { type: 'observation', content: '[read] b.txt', relevanceScore: 0.6, tokens: 0, metadata: { toolName: 'read', source: 'semantic' } },
      { type: 'entity', content: '[CLASS] Config', relevanceScore: 0.9, tokens: 0, metadata: { entityType: 'class', source: 'semantic' } },
      { type: 'observation', content: '[bash] ls', relevanceScore: 0.7, tokens: 0, metadata: { toolName: 'bash', source: 'semantic' } },
      { type: 'observation', content: '[bash] pwd', relevanceScore: 0.4, tokens: 0, metadata: { toolName: 'bash', source: 'semantic' } },
    ]);
    const result = aggregateConsecutiveSimilar(input);
    expect(result).toHaveLength(3); // [read×2], [entity], [bash×2]
    const reads = result[0];
    expect(reads.content).toContain('×2');
    expect(reads.content).toContain('b.txt');
    const bash = result[2];
    expect(bash.content).toContain('×2');
    expect(bash.content).toContain('pwd');
  });

  it('handles count === 1 (no aggregation) correctly', () => {
    const input = toFacts([
      { type: 'observation', content: '[bash] ls', relevanceScore: 0.7, tokens: 0, metadata: { toolName: 'bash', source: 'semantic' } },
      { type: 'observation', content: '[read] file.txt', relevanceScore: 0.5, tokens: 0, metadata: { toolName: 'read', source: 'semantic' } },
      { type: 'observation', content: '[bash] pwd', relevanceScore: 0.6, tokens: 0, metadata: { toolName: 'bash', source: 'semantic' } },
    ]);
    const result = aggregateConsecutiveSimilar(input);
    // bash(1) → read(1) → bash(1): all single, none have >=2 same-tool consecutive
    expect(result).toHaveLength(3);
    expect(result[0].content).toBe('[bash] ls');
    expect(result[1].content).toBe('[read] file.txt');
    expect(result[2].content).toBe('[bash] pwd');
  });
});
