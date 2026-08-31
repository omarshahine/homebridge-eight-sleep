import { describe, expect, it } from 'vitest';
import { PollHealth } from '../src/health';

function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('PollHealth', () => {
  it('starts healthy (grace period) and goes stale after staleMs without success', () => {
    const c = clock();
    const h = new PollHealth({ staleMs: 1000, now: c.now });
    expect(h.healthy).toBe(true);
    c.advance(999);
    expect(h.healthy).toBe(true);
    c.advance(2);
    expect(h.healthy).toBe(false);
  });

  it('success resets staleness and failure count', () => {
    const c = clock();
    const h = new PollHealth({ staleMs: 1000, now: c.now });
    h.recordFailure();
    h.recordFailure();
    expect(h.consecutiveFailures).toBe(2);
    c.advance(5000);
    expect(h.healthy).toBe(false);
    h.recordSuccess(true);
    expect(h.healthy).toBe(true);
    expect(h.consecutiveFailures).toBe(0);
  });

  it('offline device is unhealthy even with a fresh poll', () => {
    const h = new PollHealth({ staleMs: 1000, now: () => 0 });
    h.recordSuccess(false);
    expect(h.healthy).toBe(false);
    h.recordSuccess(true);
    expect(h.healthy).toBe(true);
  });
});
