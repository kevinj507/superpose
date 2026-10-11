import { DurableObject } from 'cloudflare:workers';
import { Engine, EngineError, type NewClaim } from './core/engine';
import { SqlStore } from './sql-store';

export type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

const DEFAULT_LEASE_MS = 10 * 60_000;
const DEFAULT_HEDGE_MS = 30 * 60_000;

// One Durable Object per project graph: the single writer for coordination
// state. Every call runs in one SQLite transaction, so an engine error leaves
// nothing half-written.
export class Graph extends DurableObject<Env> {
  private store: SqlStore;
  private engine: Engine;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqlStore(ctx.storage.sql);
    this.engine = new Engine(this.store, { now: () => Date.now() }, {
      leaseMs: Number(env.LEASE_MS ?? DEFAULT_LEASE_MS),
      hedgeMs: Number(env.HEDGE_MS ?? DEFAULT_HEDGE_MS),
    });
  }

  private run<T>(fn: (engine: Engine) => T): Result<T> {
    try {
      return { ok: true, value: this.ctx.storage.transactionSync(() => fn(this.engine)) };
    } catch (err) {
      if (err instanceof EngineError) return { ok: false, code: err.code, message: err.message };
      throw err;
    }
  }

  addAssumption(statement: string) {
    return this.run((e) => e.addAssumption(statement));
  }

  addClaim(input: NewClaim) {
    return this.run((e) => e.addClaim(input));
  }

  ready() {
    return this.run((e) => e.ready());
  }

  claim(id: string, agent: string) {
    return this.run((e) => e.claim(id, agent));
  }

  renew(id: string, token: string) {
    return this.run((e) => e.renew(id, token));
  }

  push(id: string, token: string, push: { sha: string; changedPaths: string[] }) {
    return this.run((e) => e.push(id, token, push));
  }

  finish(id: string, token: string) {
    return this.run((e) => e.finish(id, token));
  }

  land(id: string) {
    return this.run((e) => e.land(id));
  }

  replan(id: string, token: string, change: { statement?: string; scope?: string[]; restsOn: string[] }) {
    return this.run((e) => e.replan(id, token, change));
  }

  fileFinding(
    finder: string,
    token: string,
    input: { statement: string; effect: 'contradicts' | 'helps'; targets: string[] },
  ) {
    return this.run((e) => e.fileFinding(finder, token, input));
  }

  impactOf(findingId: string) {
    return this.run((e) => e.impactOf(findingId));
  }

  verifyFinding(findingId: string) {
    return this.run((e) => e.verifyFinding(findingId));
  }

  refuteFinding(findingId: string) {
    return this.run((e) => e.refuteFinding(findingId));
  }

  expireHedges() {
    return this.run((e) => e.expireHedges());
  }

  // Everything the canvas needs. Lease tokens are secrets and never leave.
  snapshot() {
    return this.run((e) => ({
      nodes: e.nodesForDisplay(),
      edges: this.store.allEdges(),
      events: e.events(),
    }));
  }
}
