import { afterEach, describe, expect, it, vi } from 'vitest';
import { untilReady, within } from '../src/core/container';

// Talking to a container is bounded, so one that stops answering costs about
// a minute and a retry with a fresh one, not a whole step timeout.

const FAST = { probeMs: 50, stuckMs: 150, totalMs: 300, pauseMs: 5 };
const never = () => new Promise<never>(() => {});

afterEach(() => vi.useRealTimers());

describe('within', () => {
  it('passes the answer through and leaves no timer running', async () => {
    vi.useFakeTimers();
    await expect(within(300_000, 'the job', Promise.resolve('out'))).resolves.toBe('out');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes a failure through and leaves no timer running', async () => {
    vi.useFakeTimers();
    await expect(within(300_000, 'the job', Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up on a call that never answers', async () => {
    await expect(within(20, 'destroy', never())).rejects.toThrow('destroy: no answer');
  });
});

describe('untilReady', () => {
  it('starts a stopped container and returns once a probe answers', async () => {
    let running = false;
    const start = vi.fn(() => {
      running = true;
    });
    await untilReady({ running: () => running, start, probe: async () => 'ok' }, FAST);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('keeps trying while the container is being placed', async () => {
    let calls = 0;
    const start = vi.fn();
    const probe = async () => {
      if (++calls < 3) throw new Error('There is no container instance that can be provided to this Durable Object');
      return 'ok';
    };
    await untilReady({ running: () => false, start, probe }, FAST);
    expect(calls).toBe(3);
    expect(start).toHaveBeenCalledTimes(3);
  });

  it('waits out a slow placement for the whole of its time, not just the time allowed a stuck container', async () => {
    const started = Date.now();
    const probe = async () => {
      throw new Error('There is no container instance that can be provided to this Durable Object, try again later');
    };
    await expect(untilReady({ running: () => false, start: () => {}, probe }, { ...FAST, stuckMs: 20, totalMs: 300 })).rejects.toThrow(/no container after/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });

  it('gives up soon on a container whose probe never answers', async () => {
    const started = Date.now();
    await expect(untilReady({ running: () => true, start: () => {}, probe: never }, { ...FAST, totalMs: 60_000 })).rejects.toThrow(/stuck container.*probe: no answer/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('gives up soon on a container that has lost its connection', async () => {
    const started = Date.now();
    const probe = async () => {
      throw new Error('Network connection lost.');
    };
    await expect(untilReady({ running: () => true, start: () => {}, probe }, { ...FAST, totalMs: 60_000 })).rejects.toThrow(/stuck container.*Network connection lost/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
