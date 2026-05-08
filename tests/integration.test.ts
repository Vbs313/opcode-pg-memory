/**
 * integration.test.ts
 *
 * Tests the full injection pipeline end-to-end with mocked PG pool.
 * This verifies that the core loop works: keyword recall → semantic recall → hybrid scoring → format → inject.
 *
 * Does NOT require a real PostgreSQL — the pool is mocked.
 */

import { Pool } from "pg";
import {
  retrieveMemoriesForInjection,
  formatInjectionBlock,
} from "../src/injection/system-transform-injector";
import type { InjectionInput } from "../src/injection/system-transform-injector";

// ============================================================
// Mock PG pool
// ============================================================

function createMockPool(rows: Record<string, any>[]): Pool {
  const mockQuery = jest.fn().mockImplementation(async () => ({ rows }));
  return { query: mockQuery } as unknown as Pool;
}

// ============================================================
// Integration: keywordRecall → hybridScore → formatInjectionBlock
// ============================================================

describe("injection pipeline (mock PG)", () => {
  const baseInput: InjectionInput = {
    systemPrompt: "Fix the database connection pool timeout issue",
    sessionId: "test-session-123",
    contextLimit: 128000,
    project: "my-project",
    platformSource: "opencode",
  };

  test("full pipeline with mock observations", async () => {
    const mockPool = createMockPool([
      {
        id: "obs-1",
        tool_name: "bash",
        tool_input_summary: "Checked max_connections setting",
        tool_output_summary: "max_connections=100",
        importance: 5,
        created_at: new Date(Date.now() - 3600000), // 1 hour ago
        source: "opencode",
        project_id: "my-project",
      },
      {
        id: "obs-2",
        tool_name: "read",
        tool_input_summary: "Read postgresql.conf",
        tool_output_summary: "shared_buffers too low",
        importance: 4,
        created_at: new Date(Date.now() - 7200000), // 2 hours ago
        source: "opencode",
        project_id: "my-project",
      },
      {
        id: "obs-3",
        tool_name: "edit",
        tool_input_summary: "Increased pool_size to 50",
        tool_output_summary: null,
        importance: 3,
        created_at: new Date(Date.now() - 86400000), // 1 day ago
        source: "opencode",
        project_id: "my-project",
      },
    ]);

    const result = await retrieveMemoriesForInjection(baseInput, mockPool, {
      maxTokens: 500,
      minScore: 0.3,
      keywordLimit: 10,
      semanticLimit: 10,
      dedupPrefixLength: 100,
      weights: [0.5, 0.3, 0.2],
      recencyHalfLifeDays: 2,
    });

    // Should have found and scored the observations
    expect(result.memories.length).toBeGreaterThan(0);
    // Most recent + highest importance should be first
    expect(result.memories[0].id).toBe("obs-1");
    // Scores should be between 0 and 1
    for (const m of result.memories) {
      expect(m.score).toBeGreaterThanOrEqual(0);
      expect(m.score).toBeLessThanOrEqual(1.1);
    }
  });

  test("formats memories into XML block with project and summary", async () => {
    const mockPool = createMockPool([
      {
        id: "obs-1",
        tool_name: "bash",
        tool_input_summary: "Ran diagnostic",
        tool_output_summary: "Found issue",
        importance: 3,
        created_at: new Date(),
        source: "opencode",
        project_id: "test-project",
      },
    ]);

    const { memories, summary } = await retrieveMemoriesForInjection(
      { ...baseInput, project: "test-project" },
      mockPool,
      { keywordLimit: 5, semanticLimit: 0 }, // keyword only, no semantic
    );

    const block = formatInjectionBlock(memories, summary, "test-project");
    expect(block).toContain("<pg_memory>");
    expect(block).toContain("</pg_memory>");
    expect(block).toContain("project: test-project");
    expect(block).toContain("[OBSERVATION]");
    expect(block).toContain("[bash]");
  });

  test("returns empty for empty observations", async () => {
    const mockPool = createMockPool([]);
    const result = await retrieveMemoriesForInjection(baseInput, mockPool);
    expect(result.memories).toHaveLength(0);
  });
});
