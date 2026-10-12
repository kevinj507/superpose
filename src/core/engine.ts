import { inScope, outOfScope } from './scope';
import type { Store } from './store';
import type {
  Assumption,
  CheckRun,
  Claim,
  ClaimStatus,
  EventType,
  Finding,
  GraphNode,
  KeptBranch,
  LandingState,
  Line,
  Notice,
  PushRecord,
  RealityImpact,
  RepoRef,
  Verdict,
} from './types';

const MAIN = 'refs/heads/main';

export interface Clock {
  now(): number;
}

export interface EngineOptions {
  leaseMs: number;
  // How long an unverified finding may run beside the others before a human
  // decision is due. Nobody else is stopped meanwhile.
  hedgeMs: number;
  newToken?: () => string;
  // What a claim that builds on another waits for. 'landed' when claims land
  // into a line, so a dependent's fork contains the work it builds on.
  dependencyGate?: 'done' | 'landed';
  // A landing that has not reported back after this long is given up on.
  landingTimeoutMs?: number;
}

export type LandingOutcome =
  | { status: 'landed'; merge: string; log?: string }
  | { status: 'conflict'; files: string[]; log?: string }
  | { status: 'failed' | 'error'; log?: string };

export class EngineError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface NewClaim {
  statement: string;
  scope: string[];
  cluster?: string;
  line?: string; // the line it builds on; 'main' unless said otherwise
  restsOn?: string[]; // assumption ids
  requires?: string[]; // claim ids this one builds on
  baseSha?: string;
}

export interface RenewResult {
  ok: boolean;
  reason?: 'stale';
  expiresAt?: number;
  notices: Notice[];
}

export interface PushResult {
  accepted: boolean;
  reason?: 'stale';
  verdict?: 'in-scope' | 'scope-violation';
  outside?: string[];
}

export interface Impact {
  affected: string[]; // claims that go stale
  landedAtRisk: string[]; // landed claims, part of the served reality
  cost: number; // pushes already made on the affected claims
  realities: RealityImpact[]; // every line, and whether this finding reaches it
}

export class Engine {
  private newToken: () => string;

  constructor(
    private store: Store,
    private clock: Clock,
    private opts: EngineOptions,
  ) {
    this.newToken = opts.newToken ?? (() => crypto.randomUUID());
  }

  // ---- building the plan -------------------------------------------------

  addAssumption(statement: string): Assumption {
    const a: Assumption = {
      id: this.store.nextId('a'),
      kind: 'assumption',
      statement,
      status: 'holding',
    };
    this.store.putNode(a);
    return a;
  }

  addClaim(input: NewClaim): Claim {
    for (const id of input.restsOn ?? []) this.assumption(id);
    for (const id of input.requires ?? []) this.claimNode(id);
    const c: Claim = {
      id: this.store.nextId('c'),
      kind: 'claim',
      cluster: input.cluster ?? 'main',
      line: input.line ?? 'main',
      statement: input.statement,
      scope: input.scope,
      baseSha: input.baseSha,
      status: 'open',
      pushes: 0,
      kept: [],
      version: 1,
    };
    this.store.putNode(c);
    for (const a of input.restsOn ?? []) this.store.addEdge({ source: a, target: c.id, purpose: 'required for' });
    for (const r of input.requires ?? []) this.store.addEdge({ source: r, target: c.id, purpose: 'required for' });
    return c;
  }

  // An agent declares what its work rests on, at claim time or later. The same
  // statement declared by several agents is one assumption node, so a finding
  // against it reaches all of them.
  declareAssumption(id: string, token: string, input: { statement?: string; assumption?: string }): Assumption {
    this.held(id, token);
    let a: Assumption | undefined;
    if (input.assumption) a = this.assumption(input.assumption);
    else {
      const statement = (input.statement ?? '').trim();
      if (!statement) throw new EngineError('bad_request', 'an assumption needs a statement');
      const key = normalise(statement);
      a = this.store
        .allNodes()
        .find((n): n is Assumption => n.kind === 'assumption' && n.status === 'holding' && normalise(n.statement) === key);
      a ??= this.addAssumption(statement);
    }
    if (a.status !== 'holding') throw new EngineError('contradicted', `assumption ${a.id} is contradicted`);
    this.store.addEdge({ source: a.id, target: id, purpose: 'required for' });
    return a;
  }

  isReady(id: string): boolean {
    const c = this.claimNode(id);
    if (c.status !== 'open') return false;
    return this.store.edgesTo(id, 'required for').every((e) => {
      const src = this.store.getNode(e.source);
      if (!src) return false;
      if (src.kind === 'assumption') return src.status === 'holding';
      if (src.kind === 'claim') {
        return this.opts.dependencyGate === 'landed' ? src.status === 'landed' : src.status === 'done' || src.status === 'landed';
      }
      return true;
    });
  }

  // Work an agent can take now: claims that are ready, and claims whose
  // holder's lease lapsed (an agent that died), which can be taken over.
  ready(): Claim[] {
    const now = this.clock.now();
    return this.claims().filter(
      (c) =>
        this.isReady(c.id) ||
        ((c.status === 'claimed' || c.status === 'stale') && (!c.lease || c.lease.expiresAt <= now)),
    );
  }

  // ---- leases --------------------------------------------------------------

  // Take a claim. A lapsed lease can be taken over; so can a stale claim whose
  // agent is gone, but it stays stale until its new holder re-plans it.
  claim(id: string, agent: string): { token: string; expiresAt: number; status: ClaimStatus; revoke?: string } {
    const c = this.claimNode(id);
    const now = this.clock.now();
    const free = !c.lease || c.lease.expiresAt <= now;
    const takeover = free && (c.status === 'claimed' || c.status === 'stale');
    if (!this.isReady(id) && !takeover) throw new EngineError('not_ready', `claim ${id} is not ready`);
    const lease = {
      holder: agent,
      token: this.newToken(),
      expiresAt: now + this.opts.leaseMs,
      cursor: this.latestSeq(),
    };
    const status = c.status === 'stale' ? 'stale' : 'claimed';
    this.store.putNode({ ...c, status, lease });
    // The previous holder's git token, if any, is revoked by the caller.
    return { token: lease.token, expiresAt: lease.expiresAt, status, revoke: c.lease?.git?.tokenId };
  }

  // The claim's repo, made after the lease was granted. The base commit is the
  // line's tip at the moment of forking, unless the planner fixed one.
  attachRepo(id: string, token: string, repo: RepoRef, baseSha?: string): Claim {
    const c = this.held(id, token);
    const next: Claim = { ...c, repo, baseSha: c.baseSha ?? baseSha };
    this.store.putNode(next);
    return next;
  }

  // Put a new git token on the lease. Returns the id of the one it replaces,
  // which the caller revokes.
  attachGit(id: string, token: string, git: { tokenId: string; expiresAt: number }): string | undefined {
    const c = this.held(id, token);
    this.store.putNode({ ...c, lease: { ...c.lease!, git } });
    return c.lease!.git?.tokenId;
  }

  // Hand a claim back before its lease ends. Returns the git token to revoke.
  release(id: string, token: string): { revoke?: string } {
    const c = this.held(id, token);
    this.store.putNode({ ...c, status: c.status === 'stale' ? 'stale' : 'open', lease: undefined });
    return { revoke: c.lease!.git?.tokenId };
  }

  // The renewal reply is how a running agent learns the world moved: it
  // carries every event about this claim since the agent last asked. A stale
  // claim's lease is not extended until the agent re-plans.
  renew(id: string, token: string): RenewResult {
    const c = this.held(id, token);
    const lease = c.lease!;
    const notices = this.store
      .eventsSince(lease.cursor)
      .filter((e) => e.claims.includes(id))
      .map((e) => ({ seq: e.seq, type: e.type, data: e.data }));
    const cursor = this.latestSeq();
    if (c.status === 'stale') {
      this.store.putNode({ ...c, lease: { ...lease, cursor } });
      return { ok: false, reason: 'stale', notices };
    }
    const expiresAt = this.clock.now() + this.opts.leaseMs;
    this.store.putNode({ ...c, lease: { ...lease, cursor, expiresAt } });
    return { ok: true, expiresAt, notices };
  }

  // A push by the lease holder, with the paths the platform computed for it.
  push(id: string, token: string, push: { sha: string; changedPaths: string[] }): PushResult {
    this.held(id, token);
    const row = this.recordPush(id, { sha: push.sha, ref: MAIN, before: null, paths: push.changedPaths, isHead: true });
    return pushResult(row);
  }

  // The platform's record of one commit pushed to a claim's repo: the files it
  // changes relative to the claim's base, whether they stay inside the
  // declared scope, and whether the commit became the claim's head. A stale
  // claim's push is recorded but not accepted. The same commit recorded twice
  // (the push event and the agent's own report) changes nothing.
  recordPush(
    id: string,
    input: { sha: string; ref: string; before: string | null; paths: string[]; isHead: boolean; unattributed?: string[] },
  ): PushRecord {
    const c = this.claimNode(id);
    const existing = this.store.getPush(id, input.sha);
    if (existing) return existing;
    const outside = outOfScope(input.paths, c.scope);
    let reason: PushRecord['reason'];
    if (input.ref !== MAIN) reason = 'other-branch';
    else if (c.status === 'stale') reason = 'stale';
    else if (c.status !== 'claimed') reason = 'not-claimed';
    else if (!input.isHead) reason = 'not-head';
    const row: PushRecord = {
      claim: id,
      sha: input.sha,
      ref: input.ref,
      before: input.before,
      at: this.clock.now(),
      paths: [...input.paths],
      outside,
      accepted: !reason,
      verdict: outside.length ? 'scope-violation' : 'unverified',
    };
    if (reason) row.reason = reason;
    if (input.unattributed?.length) row.unattributed = [...input.unattributed];
    this.store.putPush(row);
    if (row.accepted) this.store.putNode({ ...c, headSha: input.sha, pushes: c.pushes + 1 });
    this.notifyTouched(c, outside, input.sha);
    return row;
  }

  // The result of running the claim's checks on one exact commit. A scope
  // violation stays the verdict whatever the tests say.
  recordCheck(id: string, sha: string, check: CheckRun): PushRecord {
    const row = this.store.getPush(id, sha);
    if (!row) throw new EngineError('not_found', `no push ${sha} on ${id}`);
    let verdict: Verdict = row.verdict;
    if (row.verdict !== 'scope-violation') {
      if (check.status === 'passed') verdict = 'checks-passed';
      else if (check.status === 'failed') verdict = 'checks-failed';
      else if (check.status === 'error') verdict = 'verifier-failed';
      else if (check.status === 'timeout') verdict = 'budget-exhausted';
      else verdict = 'unverified';
    }
    const next: PushRecord = { ...row, checks: check, verdict };
    this.store.putPush(next);
    // Nothing to tell the agent while checks run, or when there are none.
    if (check.status !== 'running' && check.status !== 'skipped') {
      this.emit('claim.checked', [id], { sha, verdict, exitCode: check.exitCode });
    }
    return next;
  }

  // Forget the check result on one commit so it can be checked again.
  clearChecks(id: string, sha: string): void {
    const row = this.store.getPush(id, sha);
    if (!row) throw new EngineError('not_found', `no push ${sha} on ${id}`);
    const { checks: _gone, ...rest } = row;
    this.store.putPush({ ...rest, verdict: row.outside.length ? 'scope-violation' : 'unverified' });
  }

  pushRecord(id: string, sha: string): PushRecord | undefined {
    return this.store.getPush(id, sha);
  }

  // The verdict on the claim's current head, if it has one.
  verdictOf(id: string): PushRecord | undefined {
    const c = this.claimNode(id);
    return c.headSha ? this.store.getPush(id, c.headSha) : undefined;
  }

  // Lease check alone, for calls that do their own work before writing.
  checkLease(id: string, token: string): Claim {
    return this.held(id, token);
  }

  // Finish a claim. Returns the git token to revoke: the work is handed in.
  finish(id: string, token: string): { revoke?: string } {
    const c = this.held(id, token);
    if (c.status === 'stale') throw new EngineError('stale', `claim ${id} is stale; re-plan first`);
    this.store.putNode({ ...c, status: 'done', lease: undefined, finishedAt: this.clock.now() });
    return { revoke: c.lease!.git?.tokenId };
  }

  // ---- lines and landing ---------------------------------------------------

  // A new line forked from another: the second option of a decision, say.
  // It carries the work landed on its source so far.
  addLine(input: { name: string; from: string; repo: RepoRef; head?: string; decision?: string; option?: string }): Line {
    if (this.store.getLine(input.name)) throw new EngineError('exists', `line ${input.name} exists`);
    const source = this.line(input.from);
    const carried = this.claims().filter((c) => c.line === input.from && c.status === 'landed').map((c) => c.id);
    const line: Line = {
      name: input.name,
      repo: input.repo,
      head: input.head,
      served: false,
      from: input.from,
      inherits: [...(source.inherits ?? []), ...carried],
    };
    if (input.decision) line.decision = input.decision;
    if (input.option) line.option = input.option;
    if (!this.store.getLine(input.from)) this.store.putLine(source);
    this.store.putLine(line);
    return line;
  }

  // Say which option of which decision an existing line is.
  labelLine(name: string, labels: { decision?: string; option?: string }): Line {
    const line = { ...this.line(name) };
    if (labels.decision !== undefined) line.decision = labels.decision;
    if (labels.option !== undefined) line.option = labels.option;
    this.store.putLine(line);
    return line;
  }

  // Switch what is served: a pointer change. Nothing is deleted; the previous
  // reality stays as it was, retraceable.
  serve(name: string): Line {
    const target = this.store.getLine(name);
    if (!target) throw new EngineError('not_found', `no line ${name}`);
    const previous = this.store.lines().find((l) => l.served);
    for (const l of this.store.lines()) if (l.served !== (l.name === name)) this.store.putLine({ ...l, served: l.name === name });
    this.emit('reality.served', [], { line: name, previous: previous?.name ?? null });
    return { ...target, served: true };
  }

  line(name: string): Line {
    return this.store.getLine(name) ?? { name, served: !this.store.lines().some((l) => l.served) };
  }

  lines(): Line[] {
    return this.store.lines();
  }

  saveLine(line: Line): Line {
    this.store.putLine(line);
    return line;
  }

  // Can this finished claim land now? Its head commit must have passed its
  // checks (or declare none), and everything it builds on must have landed.
  landable(id: string): boolean {
    const c = this.claimNode(id);
    if (c.status !== 'done') return false;
    if (c.landing && c.landing.status !== 'queued') return false;
    if (c.headSha) {
      const row = this.store.getPush(id, c.headSha);
      const passing = row?.verdict === 'checks-passed' || (row?.verdict === 'unverified' && row.checks?.status === 'skipped');
      if (!passing) return false;
    }
    return this.store.edgesTo(id, 'required for').every((e) => {
      const src = this.store.getNode(e.source);
      return src?.kind !== 'claim' || src.status === 'landed';
    });
  }

  // The single writer's next move on a line: the oldest finished claim that
  // can land, if no landing is in flight. A claim with no commits lands as is.
  beginNextLanding(lineName: string): { claim: string; sha: string } | null {
    const now = this.clock.now();
    let line = this.line(lineName);
    if (line.landing) {
      const timeout = this.opts.landingTimeoutMs ?? 30 * 60_000;
      if (now - line.landing.startedAt < timeout) return null;
      this.failLanding(line.landing.claim, { status: 'error', log: 'the landing never reported back' });
      line = { ...line, landing: undefined };
      this.store.putLine(line);
    }
    for (;;) {
      const next = this.claims()
        .filter((c) => c.line === lineName && this.landable(c.id))
        .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))[0];
      if (!next) return null;
      if (!next.headSha) {
        this.markLanded(next.id, undefined, lineName);
        continue;
      }
      this.store.putNode({ ...next, landing: { status: 'landing', at: now } });
      this.store.putLine({ ...line, landing: { claim: next.id, sha: next.headSha, startedAt: now } });
      return { claim: next.id, sha: next.headSha };
    }
  }

  completeLanding(lineName: string, id: string, outcome: LandingOutcome): void {
    const line = this.line(lineName);
    if (line.landing?.claim === id) this.store.putLine({ ...line, landing: undefined });
    if (outcome.status === 'landed') this.markLanded(id, outcome.merge, lineName);
    else this.failLanding(id, outcome);
  }

  // A claim whose landing failed goes back to the ready set, keeping its repo,
  // so an agent can bring it up to date with the line and finish it again.
  reopen(id: string): Claim {
    const c = this.claimNode(id);
    if (c.status !== 'done') throw new EngineError('not_done', `claim ${id} is ${c.status}`);
    const next: Claim = { ...c, status: 'open', landing: undefined, finishedAt: undefined };
    this.store.putNode(next);
    return next;
  }

  // Mark a finished claim landed without a merge (a human's decision, or
  // the record of a merge done elsewhere).
  land(id: string): void {
    const c = this.claimNode(id);
    if (c.status !== 'done') throw new EngineError('not_done', `claim ${id} is ${c.status}`);
    this.markLanded(id, undefined, c.line);
  }

  // Re-plan a stale claim: new statement, scope or assumptions. Its lease is
  // extended again only once it no longer rests on anything contradicted.
  replan(
    id: string,
    token: string,
    change: { statement?: string; scope?: string[]; restsOn: string[] },
  ): Claim {
    const c = this.held(id, token);
    for (const a of change.restsOn) {
      if (this.assumption(a).status !== 'holding') {
        throw new EngineError('contradicted', `assumption ${a} is contradicted`);
      }
    }
    for (const e of this.store.edgesTo(id, 'required for')) {
      if (this.store.getNode(e.source)?.kind === 'assumption') this.store.removeEdge(e);
    }
    for (const a of change.restsOn) this.store.addEdge({ source: a, target: id, purpose: 'required for' });
    const next: Claim = {
      ...c,
      statement: change.statement ?? c.statement,
      scope: change.scope ?? c.scope,
      status: 'claimed',
      version: c.version + 1,
      lease: { ...c.lease!, expiresAt: this.clock.now() + this.opts.leaseMs },
    };
    this.store.putNode(next);
    this.emit('claim.replanned', [id], { version: next.version });
    return next;
  }

  // ---- findings ------------------------------------------------------------

  fileFinding(
    finderId: string,
    token: string,
    input: { statement: string; effect: 'contradicts' | 'helps'; targets: string[] },
  ): { finding: Finding; duplicate: boolean } {
    this.held(finderId, token);
    for (const t of input.targets) {
      if (input.effect === 'contradicts') this.assumption(t);
      else this.claimNode(t);
    }
    const fingerprint = fingerprintOf(input.statement, input.effect, input.targets);
    const existing = this.findings().find((f) => f.fingerprint === fingerprint);
    if (existing) return { finding: existing, duplicate: true };
    const f: Finding = {
      id: this.store.nextId('f'),
      kind: 'finding',
      statement: input.statement,
      effect: input.effect,
      status: 'unverified',
      finder: finderId,
      targets: [...input.targets],
      fingerprint,
      hedgeUntil: this.clock.now() + this.opts.hedgeMs,
    };
    this.store.putNode(f);
    const purpose = input.effect === 'contradicts' ? 'contradicts' : 'supports';
    for (const t of f.targets) this.store.addEdge({ source: f.id, target: t, purpose });
    // Only the finder hears about an unverified finding: nobody else stops.
    this.emit('finding.filed', [finderId], { finding: f.id });
    return { finding: f, duplicate: false };
  }

  // What verifying a finding would cost, reported before it fires.
  impactOf(findingId: string): Impact {
    const f = this.finding(findingId);
    if (f.effect === 'helps') return { affected: [], landedAtRisk: [], cost: 0, realities: this.realitiesAgainst([], []) };
    const affected: string[] = [];
    const landedAtRisk: string[] = [];
    let cost = 0;
    for (const c of this.downstreamOf(f.targets)) {
      if (c.id === f.finder || c.status === 'superseded') continue;
      if (c.status === 'landed') landedAtRisk.push(c.id);
      else {
        affected.push(c.id);
        cost += c.pushes;
      }
    }
    return { affected, landedAtRisk, cost, realities: this.realitiesAgainst(affected, landedAtRisk) };
  }

  verifyFinding(findingId: string): Impact {
    const f = this.finding(findingId);
    if (f.status !== 'unverified') throw new EngineError('settled', `finding ${f.id} is ${f.status}`);
    const impact = this.impactOf(findingId);
    this.store.putNode({ ...f, status: 'verified' });
    this.emit('finding.verified', [f.finder], { finding: f.id });

    if (f.effect === 'helps') {
      this.emit('claim.helped', f.targets, { finding: f.id, statement: f.statement });
      return impact;
    }
    for (const a of f.targets) {
      const node = this.assumption(a);
      if (node.status === 'holding') this.store.putNode({ ...node, status: 'contradicted' });
    }
    const now = this.clock.now();
    for (const id of impact.affected) {
      const c = this.claimNode(id);
      if (c.status === 'stale') continue;
      const kept: KeptBranch[] = c.headSha
        ? [...c.kept, { sha: c.headSha, reason: `finding ${f.id} verified`, at: now }]
        : c.kept;
      this.store.putNode({ ...c, status: 'stale', kept });
      this.emit('claim.stale', [id], { finding: f.id, statement: f.statement, assumptions: f.targets });
    }
    if (impact.landedAtRisk.length) {
      this.emit('reality.at_risk', impact.landedAtRisk, { finding: f.id, assumptions: f.targets });
    }
    return impact;
  }

  // A refuted finding is kept, so the next agent to suspect the same thing is
  // pointed at it. The finder's work built on it is parked and it re-plans.
  refuteFinding(findingId: string): void {
    const f = this.finding(findingId);
    if (f.status !== 'unverified') throw new EngineError('settled', `finding ${f.id} is ${f.status}`);
    this.store.putNode({ ...f, status: 'refuted' });
    const finder = this.claimNode(f.finder);
    if (finder.status === 'claimed' || finder.status === 'done') {
      const kept = finder.headSha
        ? [...finder.kept, { sha: finder.headSha, reason: `finding ${f.id} refuted`, at: this.clock.now() }]
        : finder.kept;
      this.store.putNode({ ...finder, status: 'stale', kept });
    }
    this.emit('finding.refuted', [f.finder], { finding: f.id });
  }

  // Unverified findings past their hedge window need a human decision. The
  // default, until someone decides, is that nobody else is stopped.
  expireHedges(): Finding[] {
    const now = this.clock.now();
    const expired = this.findings().filter((f) => f.status === 'unverified' && f.hedgeUntil <= now);
    for (const f of expired) {
      const already = this.store
        .eventsSince(0)
        .some((e) => e.type === 'finding.hedge_expired' && e.data.finding === f.id);
      if (!already) this.emit('finding.hedge_expired', [f.finder], { finding: f.id });
    }
    return expired;
  }

  // ---- reads -----------------------------------------------------------------

  claims(): Claim[] {
    return this.store.allNodes().filter((n): n is Claim => n.kind === 'claim');
  }

  findings(): Finding[] {
    return this.store.allNodes().filter((n): n is Finding => n.kind === 'finding');
  }

  node(id: string): GraphNode | undefined {
    return this.store.getNode(id);
  }

  getClaim(id: string): Claim {
    return this.claimNode(id);
  }

  events(since = 0) {
    return this.store.eventsSince(since);
  }

  // Nodes with lease tokens removed, safe to show to anyone.
  nodesForDisplay(): GraphNode[] {
    return this.store.allNodes().map((n) => {
      if (n.kind !== 'claim' || !n.lease) return n;
      const { token: _secret, ...lease } = n.lease;
      return { ...n, lease: { ...lease, token: '' } };
    });
  }

  // ---- internals ---------------------------------------------------------------

  private realitiesAgainst(affected: string[], landedAtRisk: string[]): RealityImpact[] {
    const lines = new Map(this.store.lines().map((l) => [l.name, l]));
    for (const c of this.claims()) if (!lines.has(c.line)) lines.set(c.line, this.line(c.line));
    const lineOf = new Map(this.claims().map((c) => [c.id, c.line]));
    return [...lines.values()].map((l) => {
      const mine = affected.filter((id) => lineOf.get(id) === l.name);
      const landed = landedAtRisk.filter((id) => lineOf.get(id) === l.name || (l.inherits ?? []).includes(id));
      return { line: l.name, served: l.served, affected: mine, landedAtRisk: landed, safe: !mine.length && !landed.length };
    });
  }

  private markLanded(id: string, merge: string | undefined, lineName: string) {
    const c = this.claimNode(id);
    this.store.putNode({ ...c, status: 'landed', landing: undefined, landedSha: merge });
    if (merge) this.store.putLine({ ...this.line(lineName), head: merge });
    this.emit('claim.landed', [id], { line: lineName, merge: merge ?? null });
  }

  private failLanding(id: string, outcome: Exclude<LandingOutcome, { status: 'landed' }>) {
    const c = this.claimNode(id);
    const landing: LandingState = { status: outcome.status, at: this.clock.now() };
    if (outcome.log) landing.log = outcome.log;
    if (outcome.status === 'conflict') landing.files = outcome.files;
    this.store.putNode({ ...c, landing });
    this.emit('claim.landing_failed', [id], { status: outcome.status, files: landing.files ?? [] });
  }

  // A push that strays outside its scope tells every live claim whose scope it
  // landed in (notify-and-repair), at that claim's next renewal.
  private notifyTouched(c: Claim, outside: string[], sha: string) {
    if (!outside.length) return;
    for (const other of this.claims()) {
      if (other.id === c.id || !(other.status === 'claimed' || other.status === 'stale')) continue;
      const hit = outside.filter((p) => inScope(p, other.scope));
      if (hit.length) this.emit('scope.touched', [other.id], { by: c.id, sha, paths: hit });
    }
  }

  // Every claim that rests on the given assumptions, directly or through a
  // chain of claims built on such claims.
  private downstreamOf(assumptionIds: string[]): Claim[] {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const a of assumptionIds) {
      for (const e of this.store.edgesFrom(a, 'required for')) queue.push(e.target);
    }
    const out: Claim[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = this.store.getNode(id);
      if (node?.kind !== 'claim') continue;
      out.push(node);
      for (const e of this.store.edgesFrom(id, 'required for')) queue.push(e.target);
    }
    return out;
  }

  private held(id: string, token: string): Claim {
    const c = this.claimNode(id);
    if (!c.lease || c.lease.token !== token) throw new EngineError('bad_token', `no lease on ${id} for this token`);
    if (c.lease.expiresAt <= this.clock.now()) throw new EngineError('expired', `lease on ${id} expired`);
    return c;
  }

  private emit(type: EventType, claims: string[], data: Record<string, unknown>) {
    this.store.appendEvent({ at: this.clock.now(), type, claims, data });
  }

  private latestSeq(): number {
    return this.store.lastSeq();
  }

  private claimNode(id: string): Claim {
    const n = this.store.getNode(id);
    if (n?.kind !== 'claim') throw new EngineError('not_found', `no claim ${id}`);
    return n;
  }

  private assumption(id: string): Assumption {
    const n = this.store.getNode(id);
    if (n?.kind !== 'assumption') throw new EngineError('not_found', `no assumption ${id}`);
    return n;
  }

  private finding(id: string): Finding {
    const n = this.store.getNode(id);
    if (n?.kind !== 'finding') throw new EngineError('not_found', `no finding ${id}`);
    return n;
  }
}

function normalise(statement: string): string {
  return statement.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function fingerprintOf(statement: string, effect: string, targets: string[]): string {
  return `${effect}|${[...targets].sort().join(',')}|${normalise(statement)}`;
}

function pushResult(row: PushRecord): PushResult {
  if (!row.accepted && row.reason === 'stale') return { accepted: false, reason: 'stale' };
  return {
    accepted: row.accepted,
    verdict: row.outside.length ? 'scope-violation' : 'in-scope',
    outside: row.outside,
  };
}
