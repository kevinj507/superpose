import { DurableObject } from 'cloudflare:workers';
import { ArtifactsHost } from './artifacts-host';
import { Coordinator, type PushReport, type Tx } from './core/coordinator';
import { Engine, EngineError, type NewClaim } from './core/engine';
import { FakeRepoHost } from './core/fake-host';
import type { RepoHost } from './core/repos';
import type { CheckRun } from './core/types';
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
  private leaseMs: number;
  // Cloudflare Artifacts in production. REPO_HOST=fake swaps in an in-memory
  // git host kept in this object's storage, for tests and local development.
  readonly repoHost: RepoHost;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqlStore(ctx.storage.sql);
    this.leaseMs = Number(env.LEASE_MS ?? DEFAULT_LEASE_MS);
    this.engine = new Engine(this.store, { now: () => Date.now() }, {
      leaseMs: this.leaseMs,
      hedgeMs: Number(env.HEDGE_MS ?? DEFAULT_HEDGE_MS),
    });
    if (env.REPO_HOST === 'fake') this.repoHost = new FakeRepoHost(ctx.storage.kv);
    else if (env.ARTIFACTS) this.repoHost = new ArtifactsHost(env.ARTIFACTS);
    else this.repoHost = missingHost();
  }

  private tx: Tx = (fn) => this.ctx.storage.transactionSync(() => fn(this.engine));

  private run<T>(fn: (engine: Engine) => T): Result<T> {
    try {
      return { ok: true, value: this.tx(fn) };
    } catch (err) {
      if (err instanceof EngineError) return { ok: false, code: err.code, message: err.message };
      throw err;
    }
  }

  // Calls that also touch the git host. The graph's name is passed in because
  // repo names carry it.
  private async runWithRepos<T>(graph: string, fn: (c: Coordinator) => Promise<T>): Promise<Result<T>> {
    const coordinator = new Coordinator(this.tx, this.repoHost, { graph });
    try {
      return { ok: true, value: await fn(coordinator) };
    } catch (err) {
      if (err instanceof EngineError) return { ok: false, code: err.code, message: err.message };
      const code = (err as { code?: unknown })?.code;
      if (typeof code === 'string') return { ok: false, code: 'repo_unavailable', message: `${code}: ${(err as Error).message}` };
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

  claim(graph: string, id: string, agent: string) {
    return this.runWithRepos(graph, (c) => c.claim(id, agent));
  }

  renew(graph: string, id: string, token: string) {
    return this.runWithRepos(graph, (c) => c.renew(id, token));
  }

  declareAssumption(id: string, token: string, input: { statement?: string; assumption?: string }) {
    return this.run((e) => e.declareAssumption(id, token, input));
  }

  release(graph: string, id: string, token: string) {
    return this.runWithRepos(graph, (c) => c.release(id, token));
  }

  // Git access to a line, for the planner or a human to seed or read it.
  lineAccess(graph: string, line: string, scope: 'read' | 'write', ttlSeconds: number) {
    return this.runWithRepos(graph, (c) => c.lineAccess(line, scope, ttlSeconds));
  }

  // The agent's own report of a push; the platform reads the commit itself.
  notePush(graph: string, id: string, token: string, sha: string) {
    return this.runWithRepos(graph, (c) => c.notePush(id, token, sha));
  }

  // A push event from the trigger.
  recordPush(graph: string, id: string, push: PushReport) {
    return this.runWithRepos(graph, (c) => c.inspectPush(id, push));
  }

  recordCheck(id: string, sha: string, check: CheckRun) {
    return this.run((e) => e.recordCheck(id, sha, check));
  }

  finish(graph: string, id: string, token: string) {
    return this.runWithRepos(graph, (c) => c.finish(id, token));
  }

  land(id: string) {
    return this.run((e) => e.land(id));
  }

  replan(graph: string, id: string, token: string, change: { statement?: string; scope?: string[]; restsOn: string[] }) {
    return this.runWithRepos(graph, (c) => c.replan(id, token, change));
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
      pushes: this.store.pushes(),
    }));
  }
}

function missingHost(): RepoHost {
  const fail = async (): Promise<never> => {
    throw new EngineError('repo_unavailable', 'no git host: bind ARTIFACTS, or set REPO_HOST=fake for local use');
  };
  return { ensure: fail, fork: fail, mintToken: fail, revokeToken: fail, readCommit: fail, readTree: fail, readHead: fail };
}
