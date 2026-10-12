import { DurableObject } from 'cloudflare:workers';
import { ArtifactsHost } from './artifacts-host';
import { Coordinator, type PushReport, type Tx } from './core/coordinator';
import { Engine, EngineError, type LandingOutcome, type NewClaim } from './core/engine';
import { FakeRepoHost } from './core/fake-host';
import { landingMessage } from './core/landing';
import { syntheticPush } from './push-flow';
import { lineRepoName, type RepoHost } from './core/repos';
import type { CheckRun, PushRecord } from './core/types';
import { SqlStore } from './sql-store';

export type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

const DEFAULT_LEASE_MS = 10 * 60_000;
const DEFAULT_HEDGE_MS = 30 * 60_000;
// Longer than a landing's steps can take with their retries, so only a
// landing whose Workflow is gone is given up on.
const LANDING_TIMEOUT_MS = 2 * 60 * 60_000;

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
      dependencyGate: 'landed',
      landingTimeoutMs: LANDING_TIMEOUT_MS,
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
    // Remembered for work this object starts on its own (an alarm).
    if (this.ctx.storage.kv.get<string>('graph') !== graph) this.ctx.storage.kv.put('graph', graph);
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
    return this.run((e) => e.readyForDisplay());
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

  createLine(graph: string, input: { name: string; from: string; decision?: string; option?: string }) {
    return this.runWithRepos(graph, (c) => c.createLine(input));
  }

  labelLine(graph: string, name: string, labels: { decision?: string; option?: string }) {
    return this.runWithRepos(graph, async (c) => {
      await c.ensureLine(name);
      return this.engine.labelLine(name, labels);
    });
  }

  serve(line: string) {
    return this.run((e) => e.serve(line));
  }

  // The file at `path` in the served reality, for serving the app itself.
  async servedFile(graph: string, path: string): Promise<{ text: string } | null> {
    const line = this.engine.lines().find((l) => l.served) ?? this.engine.line('main');
    const repo = line.repo?.name ?? lineRepoName(graph, line.name);
    try {
      const text = await this.repoHost.readFile(repo, line.head ?? 'main', path);
      return text === null ? null : { text };
    } catch {
      return null;
    }
  }

  // Git access to a line, for the planner or a human to seed or read it.
  lineAccess(graph: string, line: string, scope: 'read' | 'write', ttlSeconds: number) {
    return this.runWithRepos(graph, (c) => c.lineAccess(line, scope, ttlSeconds));
  }

  // The agent's own report of a push; the platform reads the commit itself.
  notePush(graph: string, id: string, token: string, sha: string) {
    return this.runWithRepos(graph, async (c) => this.afterPush(graph, await c.notePush(id, token, sha)));
  }

  // A push event from the trigger. Returns the claim's repo too, so the
  // checks can fetch the commit.
  recordPush(graph: string, id: string, push: PushReport) {
    return this.runWithRepos(graph, async (c) => {
      const record = await this.afterPush(graph, await c.inspectPush(id, push));
      return { record, repo: this.engine.getClaim(id).repo! };
    });
  }

  async recordCheck(graph: string, id: string, sha: string, check: CheckRun) {
    const r = this.run((e) => e.recordCheck(id, sha, check));
    if (r.ok) await this.pumpLandings(graph);
    return r;
  }

  // ---- landing: the single writer for each line ------------------------------

  // What a landing needs to know, for the landing Workflow.
  landingContext(line: string, claim: string) {
    return this.run((e) => {
      const c = e.getClaim(claim);
      const l = e.line(line);
      if (!c.repo || !l.repo) throw new EngineError('no_repo', `no repo for ${claim} or line ${line}`);
      return { line: l.repo, claim: c.repo, statement: c.statement };
    });
  }

  async completeLanding(graph: string, line: string, claim: string, outcome: LandingOutcome, landing?: string) {
    const r = this.run((e) => e.completeLanding(line, claim, outcome, landing));
    await this.pumpLandings(graph);
    return r;
  }

  async abandonLanding(graph: string, line: string) {
    const r = this.run((e) => e.abandonLanding(line));
    await this.pumpLandings(graph);
    return r;
  }

  beginCheck(id: string, sha: string, command: string, owner?: string) {
    return this.run((e) => e.beginCheck(id, sha, command, owner));
  }

  // Start the next landing on every line that has none in flight.
  async pumpLandings(graph: string) {
    const lines = new Set(this.engine.claims().map((c) => c.line));
    for (const line of lines) {
      for (;;) {
        const next = this.run((e) => e.beginNextLanding(line));
        if (!next.ok || !next.value) break;
        const { claim, sha, landing } = next.value;
        if (this.repoHost instanceof FakeRepoHost) {
          // Local mode: a three-way merge in memory, no container, no checks.
          const statement = this.engine.getClaim(claim).statement;
          const merged = this.repoHost.merge(lineRepoName(graph, line), sha, landingMessage(claim, statement));
          const outcome: LandingOutcome =
            'merge' in merged ? { status: 'landed', merge: merged.merge } : { status: 'conflict', files: merged.conflict };
          this.run((e) => e.completeLanding(line, claim, outcome, landing));
          continue;
        }
        try {
          await this.env.LANDINGS!.create({ id: landing, params: { graph, line, claim, sha, landing } });
        } catch (err) {
          // Created by an earlier try whose answer was lost: it is running.
          if (/already exists/i.test(String(err))) break;
          // Not started: back in the queue without using up an attempt, and
          // tried again shortly.
          this.run((e) => e.abortLanding(line, claim, landing));
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
        }
        break;
      }
    }
  }

  // Retry landings that could not be started.
  async alarm() {
    const graph = this.ctx.storage.kv.get<string>('graph');
    if (graph) await this.pumpLandings(graph);
  }

  // In local mode nothing runs checks, so a push is recorded as declaring
  // none; that lets it land.
  private async afterPush(graph: string, record: PushRecord): Promise<PushRecord> {
    if (!(this.repoHost instanceof FakeRepoHost) || !record.accepted || record.checks || record.verdict !== 'unverified') return record;
    const now = Date.now();
    const r = this.run((e) =>
      e.recordCheck(record.claim, record.sha, { status: 'skipped', startedAt: now, finishedAt: now, log: 'local mode: no checks run' }),
    );
    await this.pumpLandings(graph);
    return r.ok ? r.value : record;
  }

  async finish(graph: string, id: string, token: string) {
    const r = await this.runWithRepos(graph, (c) => c.finish(id, token));
    if (r.ok) {
      await this.checkHeadIfUnchecked(graph, id);
      await this.pumpLandings(graph);
    }
    return r;
  }

  headOf(id: string) {
    return this.run((e) => e.getClaim(id).headSha ?? null);
  }

  // Run the checks on a claim's latest commit again (admin), e.g. after the
  // platform failed to run them.
  async recheck(id: string) {
    const c = this.run((e) => e.getClaim(id));
    if (!c.ok) return c;
    if (!c.value.headSha || !c.value.repo) return { ok: false as const, code: 'no_repo', message: `claim ${id} has no commits` };
    const sha = c.value.headSha;
    this.run((e) => e.clearChecks(id, sha));
    await this.startCheck(c.value.repo.name, sha);
    return { ok: true as const, value: { sha } };
  }

  // A finished claim whose latest commit has no checks recorded would never
  // land; start them (in local mode, record that none run).
  private async checkHeadIfUnchecked(graph: string, id: string) {
    const c = this.engine.getClaim(id);
    if (!c.headSha || !c.repo) return;
    const row = this.engine.pushRecord(id, c.headSha);
    if (!row || !row.accepted || row.checks) return;
    if (this.repoHost instanceof FakeRepoHost) await this.afterPush(graph, row);
    else await this.startCheck(c.repo.name, c.headSha);
  }

  private async startCheck(repoName: string, sha: string) {
    if (this.repoHost instanceof FakeRepoHost || !this.env.PUSHES) return;
    await this.env.PUSHES.create({ params: syntheticPush(repoName, sha) }).catch(() => {});
  }

  reopen(id: string) {
    return this.run((e) => e.reopen(id));
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

  // Delete the whole graph: its repos on the git host, then everything stored.
  async destroy(graph: string): Promise<Result<{ repos: number }>> {
    // Every repo of this graph on the host, recorded or not (a fork made by a
    // claim that was then handed back is not recorded anywhere).
    const names = new Set<string>([lineRepoName(graph, 'main')]);
    for (const l of this.engine.lines()) if (l.repo) names.add(l.repo.name);
    for (const c of this.engine.claims()) if (c.repo) names.add(c.repo.name);
    try {
      for (const n of await this.repoHost.list(`${graph}.`)) names.add(n);
    } catch {
      // Listing failed: delete what is recorded.
    }
    const failed: string[] = [];
    for (const name of names) await this.repoHost.remove(name).catch(() => failed.push(name));
    // Keep the graph if any repo is still there, so trying again finds them.
    if (failed.length) return { ok: false, code: 'repo_unavailable', message: `could not delete ${failed.join(', ')}; try again` };
    await this.ctx.storage.deleteAll();
    this.store = new SqlStore(this.ctx.storage.sql);
    this.engine = new Engine(this.store, { now: () => Date.now() }, {
      leaseMs: this.leaseMs,
      hedgeMs: Number(this.env.HEDGE_MS ?? DEFAULT_HEDGE_MS),
      dependencyGate: 'landed',
      landingTimeoutMs: LANDING_TIMEOUT_MS,
    });
    return { ok: true, value: { repos: names.size } };
  }

  // Everything the canvas needs. Lease tokens are secrets and never leave.
  snapshot() {
    return this.run((e) => ({
      nodes: e.nodesForDisplay(),
      edges: this.store.allEdges(),
      events: e.events(),
      pushes: this.store.pushes(),
      lines: e.lines(),
      // For live countdowns on the canvas.
      now: Date.now(),
      leaseMs: this.leaseMs,
    }));
  }
}

function missingHost(): RepoHost {
  const fail = async (): Promise<never> => {
    throw new EngineError('repo_unavailable', 'no git host: bind ARTIFACTS, or set REPO_HOST=fake for local use');
  };
  return {
    ensure: fail,
    fork: fail,
    mintToken: fail,
    revokeToken: fail,
    readCommit: fail,
    readTree: fail,
    readHead: fail,
    readFile: fail,
    remove: fail,
    list: fail,
  };
}
