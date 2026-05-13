import { handleSessionCreated } from "../src/hooks/session-created";
import {
  handleToolExecuteBefore,
  handleToolExecuteAfter,
  clearSessionCache,
} from "../src/hooks/tool-execute";
import { handleMessageUpdated } from "../src/hooks/message-updated";

// Mock Pool
const mockQuery = jest.fn();
const mockPool = {
  query: mockQuery,
} as any;

describe("OpenCode Hooks", () => {
  beforeEach(() => {
    mockQuery.mockClear();
    clearSessionCache("session-123");
  });

  describe("session.created", () => {
    it("should create session and retrieve facts", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // upsert session
        .mockResolvedValueOnce({
          rows: [
            {
              id: "entity-1",
              name: "TestEntity",
              type: "class",
              tier: "permanent",
              weight: 5.0,
              description: "A test entity",
              confidence: 0.9,
            },
          ],
        }) // retrieve entities (permanent)
        .mockResolvedValueOnce({ rows: [] }) // retrieve reflections (permanent)
        .mockResolvedValueOnce({ rows: [] }) // retrieve entities (project)
        .mockResolvedValueOnce({ rows: [] }) // retrieve reflections (project)
        .mockResolvedValueOnce({ rows: [] }) // retrieve entities (session)
        .mockResolvedValueOnce({ rows: [] }); // retrieve reflections (session)

      const input = {
        session: {
          id: "session-123",
          projectId: "project-456",
          model: {
            id: "gpt-4",
            contextLimit: 128000,
            name: "GPT-4",
          },
          messages: [],
        },
      };

      const output: any = {};
      await handleSessionCreated(input, output, mockPool);
      expect(output.context).toBeDefined();
      expect(output.context?.memories).toBeDefined();
    });

    it("should handle missing session gracefully", async () => {
      mockQuery.mockRejectedValueOnce(new Error("DB error"));

      const input = {
        session: {
          id: "session-123",
          model: { id: "gpt-4", contextLimit: 128000, name: "GPT-4" },
          messages: [],
        },
      };

      const output: any = {};
      await handleSessionCreated(input, output, mockPool);

      // Should return empty context on error
      expect(output.context).toBeUndefined();
    });
  });

  describe("tool.execute.before", () => {
    it("should record tool input", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: "session-internal-id" }],
        })
        .mockResolvedValueOnce({ rows: [] }); // insert observation

      const input = {
        session: { id: "session-123" },
        tool: {
          name: "read_file",
          parameters: { path: "/test/file.ts" },
        },
        messageId: "msg-456",
      };

      const output: any = {};
      await handleToolExecuteBefore(input, output, mockPool);

      expect(output).toEqual({});
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it("should sanitize sensitive parameters", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: "session-internal-id" }],
        })
        .mockResolvedValueOnce({ rows: [] });

      const input = {
        session: { id: "session-123" },
        tool: {
          name: "api_call",
          parameters: {
            url: "https://api.example.com",
            apiKey: "secret-key-123",
            password: "my-password",
          },
        },
        messageId: "msg-456",
      };

      await handleToolExecuteBefore(input, {} as any, mockPool);

      // Check that sensitive data was redacted
      const insertCall = mockQuery.mock.calls[1];
      const metadata = JSON.parse(insertCall[1][5]);
      expect(metadata.parameters.apiKey).toBe("[REDACTED]");
      expect(metadata.parameters.password).toBe("[REDACTED]");
    });
  });

  describe("tool.execute.after", () => {
    it("should update observation with output", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: "session-internal-id" }],
        })
        .mockResolvedValueOnce({
          rows: [{ id: "obs-123" }],
        }) // find existing observation
        .mockResolvedValueOnce({ rows: [] }) // update observation
        .mockResolvedValueOnce({ rows: [] }); // token usage log

      const input = {
        session: { id: "session-123" },
        tool: {
          name: "read_file",
          parameters: { path: "/test/file.ts" },
        },
        result: {
          success: true,
          data: "file contents here",
        },
        messageId: "msg-456",
        executionTimeMs: 150,
      };

      const output: any = {};
      await handleToolExecuteAfter(input, output, mockPool);

      expect(output).toEqual({});
    });

    it("should create new observation if not exists", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: "session-internal-id" }],
        })
        .mockResolvedValueOnce({ rows: [] }) // no existing observation
        .mockResolvedValueOnce({ rows: [{ id: "new-obs" }] }) // insert observation
        .mockResolvedValueOnce({ rows: [] }); // token usage log

      const input = {
        session: { id: "session-123" },
        tool: {
          name: "write_file",
          parameters: { path: "/test/file.ts", content: "new content" },
        },
        result: { success: true },
        messageId: "msg-789",
        executionTimeMs: 200,
      };

      await handleToolExecuteAfter(input, {} as any, mockPool);

      expect(mockQuery).toHaveBeenCalledTimes(5); // +1 for causal chain detection
    });
  });

  describe("message.updated", () => {
    it("should extract and store entities", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: "session-internal-id" }],
        })
        .mockResolvedValueOnce({ rows: [] }) // check existing entity
        .mockResolvedValueOnce({
          rows: [{ id: "new-entity-id" }],
        }); // insert entity

      const input = {
        session: { id: "session-123" },
        message: {
          id: "msg-456",
          role: "assistant" as const,
          content: "function testFunc() { return true; }",
          timestamp: new Date().toISOString(),
        },
      };

      const output: any = {};
      await handleMessageUpdated(input, output, mockPool);

      expect(output).toEqual({});
    });

    it("should update existing entity weight", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: "session-internal-id" }],
        })
        .mockResolvedValueOnce({
          rows: [{ id: "existing-entity", weight: 2.0 }],
        }) // existing entity found
        .mockResolvedValueOnce({ rows: [] }); // update entity

      const input = {
        session: { id: "session-123" },
        message: {
          id: "msg-456",
          role: "assistant" as const,
          content: "function testFunc() { return true; }",
          timestamp: new Date().toISOString(),
        },
      };

      await handleMessageUpdated(input, {} as any, mockPool);

      // Verify update was called
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });
  });
});
