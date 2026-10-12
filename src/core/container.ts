// Time limits for talking to a Cloudflare Container, kept apart from the
// Checker so they can be tested without one.

export interface ReadyLimits {
  probeMs: number; // how long one probe may go unanswered
  stuckMs: number; // how long a container may stay stuck before it is given up on
  totalMs: number; // how long to wait for a container to be placed at all
  pauseMs: number; // between attempts
}

// A warm container answers a probe in about 200 ms. One being placed fails
// fast ("no container instance", "not running") until it is up, which can
// take a few minutes just after a deploy, so that is waited out. But a
// container can also stop answering altogether: seen live on 2026-10-12, a
// probe hung until the landing's 12-minute step timeout, and another failed
// with "Network connection lost" for 9 minutes, while a fresh container was
// ready in 3 s. Such a container is given up on after a minute, so the
// caller's retry gets a fresh one.
export const READY_LIMITS: ReadyLimits = { probeMs: 20_000, stuckMs: 60_000, totalMs: 300_000, pauseMs: 3_000 };

export class NoAnswer extends Error {}

// Settles as `promise` does, or rejects with NoAnswer once `ms` have passed.
// The timer is always cleared, so a call that finishes never keeps its
// Durable Object awake for the rest of the limit.
export function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NoAnswer(`${what}: no answer after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export interface Startable {
  running(): boolean;
  start(): void;
  probe(): Promise<unknown>; // a trivial command, run to completion
}

// A probe that hangs, or a lost connection, means this container is stuck;
// any other failure means it is still being placed.
function stuck(err: unknown): boolean {
  return err instanceof NoAnswer || /connection lost/i.test(String(err));
}

// Start the container if it is not running, until a probe answers.
export async function untilReady(container: Startable, limits: ReadyLimits = READY_LIMITS): Promise<void> {
  const deadline = Date.now() + limits.totalMs;
  let stuckSince: number | null = null;
  let lastError: unknown = new Error('never tried');
  while (Date.now() < deadline) {
    const tried = Date.now();
    try {
      if (!container.running()) container.start();
      await within(Math.min(limits.probeMs, Math.max(1, deadline - Date.now())), 'probe', container.probe());
      return;
    } catch (err) {
      lastError = err;
      if (!stuck(err)) stuckSince = null;
      else if (stuckSince === null) stuckSince = tried;
      if (stuckSince !== null && Date.now() - stuckSince >= limits.stuckMs) {
        throw new Error(`gave up on a stuck container after ${Math.round((Date.now() - stuckSince) / 1000)}s: ${String(err)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, limits.pauseMs));
    }
  }
  throw new Error(`no container after ${Math.round(limits.totalMs / 1000)}s: ${String(lastError)}`);
}
