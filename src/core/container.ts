// Time limits for talking to a Cloudflare Container, kept apart from the
// Checker so they can be tested without one.

export interface ReadyLimits {
  probeMs: number; // how long one probe may go unanswered
  totalMs: number; // how long to keep trying before giving up on this container
  pauseMs: number; // between attempts
}

// A warm container answers a probe in about 200 ms, and one being placed
// usually fails fast ("no container instance", "not running") until it is up.
// But a container can also stop answering altogether: seen live on
// 2026-10-12, a probe hung until the landing's 12-minute step timeout, and
// another failed with "Network connection lost" for 9 minutes, while a fresh
// container was ready in 3 s. So each probe and the whole wait are bounded,
// and the caller's retry gets a fresh container.
export const READY_LIMITS: ReadyLimits = { probeMs: 20_000, totalMs: 150_000, pauseMs: 3_000 };

// Settles as `promise` does, or rejects once `ms` have passed. The timer is
// always cleared, so a call that finishes never keeps its Durable Object
// awake for the rest of the limit.
export function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export interface Startable {
  running(): boolean;
  start(): void;
  probe(): Promise<unknown>; // a trivial command, run to completion
}

// Start the container if it is not running, until a probe answers.
export async function untilReady(container: Startable, limits: ReadyLimits = READY_LIMITS): Promise<void> {
  const deadline = Date.now() + limits.totalMs;
  let lastError: unknown = new Error('never tried');
  while (Date.now() < deadline) {
    try {
      if (!container.running()) container.start();
      await within(Math.min(limits.probeMs, Math.max(1, deadline - Date.now())), 'probe', container.probe());
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, limits.pauseMs));
    }
  }
  throw new Error(`gave up after ${Math.round(limits.totalMs / 1000)}s: ${String(lastError)}`);
}
