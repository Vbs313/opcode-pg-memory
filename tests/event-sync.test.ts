import { EventSynchronizer } from '../src/services/event-synchronizer';
import type { PluginEvent } from '../src/types';

// Mock pool that returns empty results for all queries
const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
const mockPool = { query: mockQuery } as any;

describe('EventSynchronizer', () => {
  let sync: EventSynchronizer;

  beforeEach(() => {
    jest.clearAllMocks();
    sync = new EventSynchronizer(mockPool, {
      mode: 'poll-only',
      retryMaxAttempts: 1,
      eventDedupWindowMs: 5000,
    });
  });

  describe('dedup behavior', () => {
    it('blocks duplicate events with same type/sessionId/version/callID within window', async () => {
      const event = makeEvent('tool.execute.after', 'ses_1', { callID: 'call_1' });

      // First call → goes through all handlers
      await sync.handleEvent(event);
      const queryCountAfterFirst = mockQuery.mock.calls.length;
      expect(queryCountAfterFirst).toBeGreaterThan(0);

      // Second call with identical dedup key → should be blocked
      await sync.handleEvent(event);

      // No additional queries should have been made
      expect(mockQuery.mock.calls.length).toBe(queryCountAfterFirst);
      expect(sync.processingCount).toBe(0);
    });

    it('allows events with different callIDs to both proceed', async () => {
      const e1 = makeEvent('tool.execute.after', 'ses_1', { callID: 'call_1' });
      const e2 = makeEvent('tool.execute.after', 'ses_1', { callID: 'call_2' });

      await sync.handleEvent(e1);
      const queryCountAfterFirst = mockQuery.mock.calls.length;

      await sync.handleEvent(e2);

      // Second event with different callID makes additional queries
      expect(mockQuery.mock.calls.length).toBeGreaterThan(queryCountAfterFirst);
      expect(sync.processingCount).toBe(0);
    });

    it('allows events with same callID but different types', async () => {
      const e1 = makeEvent('tool.execute.before', 'ses_1', { callID: 'call_1' });
      const e2 = makeEvent('tool.execute.after', 'ses_1', { callID: 'call_1' });

      await sync.handleEvent(e1);
      const queryCountAfterFirst = mockQuery.mock.calls.length;

      await sync.handleEvent(e2);

      // Different type = different dedup key
      expect(mockQuery.mock.calls.length).toBeGreaterThan(queryCountAfterFirst);
    });
  });

  describe('processingCount', () => {
    it('starts at 0 and returns to 0 after handleEvent completes', async () => {
      expect(sync.processingCount).toBe(0);

      const event = makeEvent('tool.execute.after', 'ses_1', { callID: 'call_1' });
      await sync.handleEvent(event);

      expect(sync.processingCount).toBe(0);
    });

    it('is 1 during execution and 0 after completion', async () => {
      const event = makeEvent('tool.execute.after', 'ses_1', { callID: 'call_1' });

      // Start handleEvent — it runs synchronously until the first await
      const promise = sync.handleEvent(event);

      // At this point processingCount is 1 (incremented before first await)
      expect(sync.processingCount).toBe(1);

      await promise;

      // After completion, processingCount is 0
      expect(sync.processingCount).toBe(0);
    });
  });

  describe('stopped flag', () => {
    it('prevents new events from being processed', async () => {
      (sync as any).stopped = true;

      const event = makeEvent('tool.execute.after', 'ses_1', { callID: 'call_1' });
      await sync.handleEvent(event);

      // No queries should have been made (early return)
      expect(mockQuery.mock.calls.length).toBe(0);
      expect(sync.processingCount).toBe(0);
    });
  });

  describe('isAvailable', () => {
    it('returns true when not stopped and not processing', () => {
      expect(sync.isAvailable()).toBe(true);
    });

    it('returns false when stopped', () => {
      (sync as any).stopped = true;
      expect(sync.isAvailable()).toBe(false);
    });

    it('returns false when processing', () => {
      sync.processingCount = 1;
      expect(sync.isAvailable()).toBe(false);
    });
  });

  describe('drain', () => {
    it('resolves immediately when queue is empty', async () => {
      await expect(sync.drain()).resolves.toBeUndefined();
    });

    it('waits for processingCount to reach 0', async () => {
      // Make processingCount > 0, then drain in background, then decrement
      sync.processingCount = 1;

      // drain should not resolve immediately
      const drainPromise = sync.drain(1000);

      // Let processing count go to 0
      sync.processingCount = 0;

      // Now drain should resolve
      await expect(drainPromise).resolves.toBeUndefined();
    });

    it('throws if timeout is reached', async () => {
      sync.processingCount = 1;

      await expect(sync.drain(50)).rejects.toThrow('Drain timeout');
    });
  });

  describe('event filtering by mode', () => {
    it('blocks hook-sourced events when mode is poll-only', async () => {
      const event = makeEvent('tool.execute.after', 'ses_1', { callID: 'call_1' });
      event.source = 'hook';

      await sync.handleEvent(event);

      // Should have been filtered out by mode check
      expect(mockQuery.mock.calls.length).toBe(0);
    });

    it('processes poll-sourced events in poll-only mode', async () => {
      const event = makeEvent('tool.execute.after', 'ses_1', { callID: 'call_1' });
      event.source = 'poll';

      await sync.handleEvent(event);

      // Should have gone through
      expect(mockQuery.mock.calls.length).toBeGreaterThan(0);
    });
  });
});

function makeEvent(type: string, sessionId: string, data: any): PluginEvent {
  return {
    id: `${type}:${sessionId}:${Date.now()}:${data.callID || ''}`,
    type: type as any,
    sessionId,
    timestamp: Date.now(),
    version: 1,
    source: 'poll',
    data,
  };
}
