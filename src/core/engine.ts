import { outOfScope } from './scope';
import type { Store } from './store';
import type {
  Assumption,
  Claim,
  EventType,
  Finding,
  GraphNode,
  KeptBranch,
  Notice,
} from './types';

export interface Clock {
  now(): number;
}

export interface EngineOptions {
  leaseMs: number;
  // How long an unverified finding may run beside the others before a human
  // decision is due. Nobody else is stopped meanwhile.
  hedgeMs: number;
  newToken?: () => string;
}

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

  isReady(id: string): boolean {
    const c = this.claimNode(id);
    if (c.status !== 'open') return false;
    return this.store.edgesTo(id, 'required for').every((e) => {
      const src = this.store.getNode(e.source);
      if (!src) return false;
      if (src.kind === 'assumption') return src.status === 'holding';
      if (src.kind === 'claim') return src.status === 'done' || src.status === 'landed';
      return true;
    });
  }

  ready(): Claim[] {
    return this.claims().filter((c) => this.isReady(c.id));
  }

  // ---- leases --------------------------------------------------------------

  claim(id: string, agent: string): { token: string; expiresAt: number } {
    const c = this.claimNode(id);
    const now = this.clock.now();
    const lapsed = c.status === 'claimed' && c.lease !== undefined && c.lease.expiresAt <= now;
    if (!this.isReady(id) && !lapsed) throw new EngineError('not_ready', `claim ${id} is not ready`);
    const lease = {
      holder: agent,
      token: this.newToken(),
      expiresAt: now + this.opts.leaseMs,
      cursor: this.latestSeq(),
    };
    this.store.putNode({ ...c, status: 'claimed', lease });
    return { token: lease.token, expiresAt: lease.expiresAt };
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

  push(id: string, token: string, push: { sha: string; changedPaths: string[] }): PushResult {
    const c = this.held(id, token);
    if (c.status === 'stale') return { accepted: false, reason: 'stale' };
    const outside = outOfScope(push.changedPaths, c.scope);
    this.store.putNode({ ...c, headSha: push.sha, pushes: c.pushes + 1 });
    return {
      accepted: true,
      verdict: outside.length ? 'scope-violation' : 'in-scope',
      outside,
    };
  }

  finish(id: string, token: string): void {
    const c = this.held(id, token);
    if (c.status === 'stale') throw new EngineError('stale', `claim ${id} is stale; re-plan first`);
    this.store.putNode({ ...c, status: 'done', lease: undefined });
  }

  land(id: string): void {
    const c = this.claimNode(id);
    if (c.status !== 'done') throw new EngineError('not_done', `claim ${id} is ${c.status}`);
    this.store.putNode({ ...c, status: 'landed' });
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
    if (f.effect === 'helps') return { affected: [], landedAtRisk: [], cost: 0 };
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
    return { affected, landedAtRisk, cost };
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

  events(since = 0) {
    return this.store.eventsSince(since);
  }

  // ---- internals ---------------------------------------------------------------

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

function fingerprintOf(statement: string, effect: string, targets: string[]): string {
  const norm = statement.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${effect}|${[...targets].sort().join(',')}|${norm}`;
}
