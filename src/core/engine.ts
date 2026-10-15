import { inScope, outOfScope, scopesOverlap, validScope } from './scope';
import type { Store } from './store';
import { validateCheckInputs } from './check-inputs';
import type { PairCheck } from './types';
import type {
  Assumption,
  CheckRun,
  CheckInputs,
  Claim,
  ClaimStatus,
  Decision,
  EventType,
  Finding,
  FindingEvidence,
  ExternalFindingEvidence,
  GraphNode,
  GraphEvent,
  KeptBranch,
  LandingState,
  Lease,
  Line,
  Notice,
  PushRecord,
  RealityImpact,
  RepoRef,
  Verdict,
} from './types';

const MAIN = 'refs/heads/main';
const MAX_STORED_PATHS = 500;

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

export interface WhyEntry {
  claim: string;
  statement: string;
  line: string;
  commit: string;
  merge: string | null;
  verdict: Verdict;
  assumptions: { id: string; statement: string; status: string }[];
  finishedAt: number | null;
}

export type LandingOutcome =
  | { status: 'landed'; merge: string; log?: string; inputVersion?: number }
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
  // Set false to let it run beside unfinished claims whose scope overlaps
  // (a planner that wants competing changes to the same files).
  orderOverlaps?: boolean;
  hedgeOn?: string;
}

export interface RenewResult {
  ok: boolean;
  reason?: 'stale' | 'hedge-expired';
  expiresAt?: number;
  notices: Notice[];
}

export interface PushResult {
  accepted: boolean;
  reason?: 'stale' | 'hedge-expired';
  verdict?: 'in-scope' | 'scope-violation';
  outside?: string[];
}

// What the pair check needs, or why there is none to run.
export type PairContext =
  | { skip: string }
  | {
      line: RepoRef;
      claim: RepoRef;
      articles: { id: string; check: string; statement: string }[];
      candidates: { claim: string; merge: string }[];
    };

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

  addAssumption(statement: string, extra: { constitution?: boolean; check?: string; paths?: string[] } = {}): Assumption {
    if (extra.paths && !validScope(extra.paths)) throw new EngineError('bad_request', 'Invalid checked module paths');
    const a: Assumption = {
      id: this.store.nextId('a'),
      kind: 'assumption',
      statement,
      status: 'holding',
      ...(extra.constitution ? { constitution: true } : {}),
      ...(extra.check?.trim() ? { check: extra.check.trim() } : {}),
      ...(extra.paths ? { paths: extra.paths } : {}),
    };
    this.store.putNode(a);
    return a;
  }

  // The constitution: the owner's standing statements, which every claim on
  // the line rests on by rule.
  constitution(line?: string): Assumption[] {
    const inherited = line ? this.store.getLine(line)?.articles : undefined;
    return this.store.allNodes().filter((n): n is Assumption => n.kind === 'assumption' && !!n.constitution &&
      n.status === 'holding' && !n.supersededBy && (!line || !n.supersededOn?.[line]) &&
      (!line || n.line === line || (inherited ? inherited.includes(n.id) : !n.line)));
  }

  proposeArticle(id: string, token: string, input: { statement: string; check?: string; checkFile?: string; sourceFile?: string; sourceSha?: string; replaces?: string }): Assumption {
    const c = this.held(id, token);
    const statement = input.statement.trim();
    if (!statement || statement.length > 4000) throw new EngineError('bad_request', 'an article needs a statement of at most 4000 characters');
    if (input.checkFile && !constitutionPath(input.checkFile)) throw new EngineError('bad_request', 'a proposed check file must be under constitution/');
    if (input.replaces && !this.assumption(input.replaces).constitution) throw new EngineError('bad_request', 'only a constitutional article can be amended');
    const proposal: Assumption = {
      ...this.addAssumption(statement), line: c.line,
      ...(input.check ? { check: input.check } : {}),
      ...(input.checkFile ? { checkFile: input.checkFile } : {}),
      ...(input.replaces ? { replaces: input.replaces } : {}),
      proposal: { by: id, at: this.clock.now(), ...(input.sourceFile && input.sourceSha ? { source: { file: input.sourceFile, sha: input.sourceSha } } : {}) },
    };
    this.store.putNode(proposal);
    this.store.addEdge({ source: proposal.id, target: id, purpose: 'related to' });
    this.emit('article.proposed', [id], { article: proposal.id, statement, line: c.line });
    return proposal;
  }

  adoptArticle(id: string, input: { check?: string; checkFile?: string; atSha?: string; judged?: boolean }): Assumption {
    const a = this.assumption(id);
    if (!a.proposal || a.proposal.resolution) throw new EngineError('settled', `article ${id} is not awaiting adoption`);
    if (this.line(a.line ?? 'main').landing) throw new EngineError('busy', 'wait for the current landing before changing the constitution');
    const check = input.judged ? undefined : input.check?.trim() || a.check;
    const checkFile = check ? input.checkFile || a.checkFile : undefined;
    if (check && (!checkFile || !constitutionPath(checkFile) || !input.atSha)) {
      throw new EngineError('bad_request', 'adoption needs a check file already on the owner-controlled line under constitution/');
    }
    const adopted: Assumption = {
      ...a, constitution: true, check, checkFile,
      proposal: { ...a.proposal, resolution: 'adopted', ...(input.atSha ? { atSha: input.atSha } : {}) },
    };
    if (a.replaces) {
      const previous = this.assumption(a.replaces);
      if (!previous.constitution || previous.supersededBy || previous.supersededOn?.[a.line ?? 'main']) {
        throw new EngineError('settled', 'the article this proposal amends is no longer active');
      }
      if (!this.constitution(a.line ?? 'main').some((article) => article.id === previous.id)) throw new EngineError('bad_request', 'the amended article must belong to this line');
      this.store.putNode({
        ...previous, supersededOn: { ...previous.supersededOn, [a.line ?? 'main']: id },
      });
      this.store.addEdge({ source: id, target: previous.id, purpose: 'supersedes' });
    }
    this.store.putNode(adopted);
    this.emit('article.adopted', this.claims().filter((c) => c.line === a.line && c.status !== 'superseded').map((c) => c.id),
      { article: id, line: a.line, statement: a.statement, replaces: a.replaces ?? null });
    return adopted;
  }

  rejectArticle(id: string, reason: string): Assumption {
    const a = this.assumption(id);
    if (!a.proposal || a.proposal.resolution) throw new EngineError('settled', `article ${id} is not awaiting adoption`);
    if (!reason.trim()) throw new EngineError('bad_request', 'rejection needs a reason');
    const next: Assumption = { ...a, proposal: { ...a.proposal, resolution: 'rejected', reason: reason.trim() } };
    this.store.putNode(next);
    this.emit('article.rejected', [a.proposal.by], { article: id, reason: reason.trim() });
    return next;
  }

  addClaim(input: NewClaim): Claim {
    if (!validScope(input.scope)) throw new EngineError('bad_request', 'a scope is 1 to 64 patterns of at most 256 characters');
    for (const id of input.restsOn ?? []) {
      if (!this.assumptionHolds(this.assumption(id), input.line ?? 'main')) throw new EngineError('contradicted', `assumption ${id} is contradicted or not an accepted basis for this line`);
    }
    const line = input.line ?? 'main';
    if (input.hedgeOn) this.finding(input.hedgeOn);
    for (const id of input.requires ?? []) {
      const dep = this.claimNode(id);
      if (dep.line !== line && !(this.store.getLine(line)?.inherits ?? []).includes(id)) {
        throw new EngineError('bad_request', `claim ${id} is on line ${dep.line}; work on ${line} cannot build on it`);
      }
    }
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
      ...(input.hedgeOn ? { hedgeOn: input.hedgeOn } : {}),
    };
    this.store.putNode(c);
    for (const a of input.restsOn ?? []) this.store.addEdge({ source: a, target: c.id, purpose: 'required for' });
    for (const r of input.requires ?? []) this.store.addEdge({ source: r, target: c.id, purpose: 'required for' });
    if (input.orderOverlaps !== false) this.orderOverlaps(c);
    return c;
  }

  // Conflicts predicted, not discovered: a new claim whose declared scope
  // overlaps an unfinished claim on the same line, with no order between
  // them, waits for that one to land. Two agents then never change the same
  // files at once, and the merge that follows is a trivial one.
  private orderOverlaps(c: Claim) {
    for (const other of this.claims()) {
      if (other.id === c.id || other.line !== c.line) continue;
      if (other.status === 'landed' || other.status === 'superseded') continue;
      if (!scopesOverlap(c.scope, other.scope)) continue;
      if (this.buildsOn(c.id, other.id) || this.buildsOn(other.id, c.id)) continue;
      // Ordering only: nothing of this claim's rests on the other's work, so
      // doubt must not travel along this edge (see downstreamOf).
      this.store.addEdge({ source: other.id, target: c.id, purpose: 'required for', meta: { order: true } });
      this.emit('claim.ordered', [], { claim: c.id, after: other.id, scope: c.scope, overlaps: other.scope });
    }
  }

  // Does `later` build on `earlier`, directly or through other claims?
  private buildsOn(later: string, earlier: string): boolean {
    const seen = new Set<string>();
    const queue = [earlier];
    while (queue.length) {
      const id = queue.shift()!;
      if (id === later) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of this.store.edgesFrom(id, 'required for')) {
        if (this.store.getNode(e.target)?.kind === 'claim') queue.push(e.target);
      }
    }
    return false;
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
      // A statement already known to be false is refused, however it is worded.
      const known = this.store
        .allNodes()
        .filter((n): n is Assumption => n.kind === 'assumption' && normalise(n.statement) === key);
      a = known.find((n) => this.assumptionHolds(n, this.claimNode(id).line)) ?? known.find((n) => !n.proposal) ?? this.addAssumption(statement);
    }
    if (!this.assumptionHolds(a, this.claimNode(id).line)) throw new EngineError('contradicted', `assumption ${a.id} is contradicted or not an accepted basis for this line`);
    this.store.addEdge({ source: a.id, target: id, purpose: 'required for' });
    return a;
  }

  isReady(id: string): boolean {
    const c = this.claimNode(id);
    if (c.status !== 'open') return false;
    if (!this.hedgePermitted(c)) return false;
    return this.store.edgesTo(id, 'required for').every((e) => {
      const src = this.store.getNode(e.source);
      if (!src) return false;
      if (src.kind === 'assumption') return this.assumptionHolds(src, c.line);
      if (src.kind === 'claim') return this.depMet(c, src);
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
        ((c.status === 'claimed' || c.status === 'stale') &&
          (!c.lease || c.lease.expiresAt <= now) &&
          c.landing?.status !== 'landing' &&
          this.dependenciesMet(c.id)),
    );
  }

  // ---- leases --------------------------------------------------------------

  // Take a claim. A lapsed lease can be taken over; so can a stale claim whose
  // agent is gone, but it stays stale until its new holder re-plans it.
  claim(
    id: string,
    agent: string,
  ): { token: string; expiresAt: number; status: ClaimStatus; revoke: string[]; revokeLine?: Lease['lineToken'] } {
    const c = this.claimNode(id);
    if (!this.hedgePermitted(c)) throw new EngineError('hedge_expired', 'the investigation needs an owner decision');
    const now = this.clock.now();
    const free = !c.lease || c.lease.expiresAt <= now;
    // A claim whose landing is in flight is not taken over: the landing's
    // report is about the work it started with.
    const takeover =
      free && (c.status === 'claimed' || c.status === 'stale') && c.landing?.status !== 'landing' && this.dependenciesMet(id);
    if (!this.isReady(id) && !takeover) throw new EngineError('not_ready', `claim ${id} is not ready`);
    if (c.line !== 'main' && !this.store.getLine(c.line)) {
      throw new EngineError('no_line', `line ${c.line} does not exist yet; create it before claiming work on it`);
    }
    // What was said about a claim belongs to the claim, not to a lease. The
    // new holder hears what the previous one had not heard yet (checks that
    // failed, a landing that conflicted), and the first holder hears
    // everything said while the claim was open: a finding filed to help it,
    // a push into its scope.
    const lease = {
      holder: agent,
      token: this.newToken(),
      expiresAt: now + this.opts.leaseMs,
      cursor: c.lease?.cursor ?? c.deliveredSeq ?? 0,
    };
    const status = c.status === 'stale' ? 'stale' : 'claimed';
    if (status === 'stale') {
      // Whoever takes over a stale claim hears why it is stale, at its first
      // renewal, like the agent that held it before.
      const why = this.store.eventsSince(0).filter((e) => e.type === 'claim.stale' && e.claims.includes(id)).at(-1);
      if (why) lease.cursor = Math.min(lease.cursor, why.seq - 1);
    }
    this.store.putNode({ ...c, status, lease });
    // The previous holder's git tokens, if any, are revoked by the caller.
    return { token: lease.token, expiresAt: lease.expiresAt, status, revoke: tokensOf(c), revokeLine: c.lease?.lineToken };
  }

  // The claim's repo, made after the lease was granted. The base commit is the
  // line's tip at the moment of forking, unless the planner fixed one.
  attachRepo(id: string, token: string, repo: RepoRef, baseSha?: string): Claim {
    const c = this.held(id, token);
    const next: Claim = { ...c, repo, baseSha: c.baseSha ?? baseSha, forkSha: baseSha };
    this.store.putNode(next);
    return next;
  }

  // Put a new git token on the lease. The one it replaces is kept on the
  // lease until it expires, so it is revoked when the lease ends.
  attachGit(id: string, token: string, git: { tokenId: string; expiresAt: number }): void {
    const c = this.held(id, token);
    const now = this.clock.now();
    const lease = c.lease!;
    const retired = [...(lease.retired ?? []), ...(lease.git ? [lease.git] : [])].filter((t) => t.expiresAt > now);
    this.store.putNode({ ...c, lease: { ...lease, git, retired } });
  }

  // Hand a claim back before its lease ends. Returns the git tokens to revoke.
  release(id: string, token: string): { revoke: string[]; revokeLine?: Lease['lineToken'] } {
    const c = this.held(id, token);
    this.store.putNode({ ...c, status: this.openOrStale(c), lease: undefined, deliveredSeq: c.lease!.cursor });
    return { revoke: tokensOf(c), revokeLine: c.lease!.lineToken };
  }

  // A reopened claim's holder was handed the line at `head`: from now on the
  // claim's changes are judged from there, and the read token goes on the
  // lease to be revoked with the others.
  attachLine(id: string, token: string, line: { repo: string; tokenId: string; expiresAt: number; head?: string }): Claim {
    const c = this.held(id, token);
    const next: Claim = {
      ...c,
      baseSha: line.head ?? c.baseSha,
      lease: { ...c.lease!, lineToken: { repo: line.repo, tokenId: line.tokenId, expiresAt: line.expiresAt } },
    };
    this.store.putNode(next);
    return next;
  }

  // The renewal reply is how a running agent learns the world moved: it
  // carries every event about this claim since the agent last asked. A stale
  // claim's lease is not extended until the agent re-plans.
  renew(id: string, token: string): RenewResult {
    this.expireHedges();
    const c = this.held(id, token);
    const lease = c.lease!;
    const notices = this.store
      .eventsSince(lease.cursor)
      .filter((e) => e.claims.includes(id))
      .map((e) => ({ seq: e.seq, type: e.type, data: e.data }));
    const cursor = this.latestSeq();
    if (!this.hedgePermitted(c)) {
      this.store.putNode({ ...c, lease: { ...lease, cursor } });
      return { ok: false, reason: 'hedge-expired', notices };
    }
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
    input: {
      sha: string;
      ref: string;
      before: string | null;
      paths: string[];
      isHead: boolean;
      seenAt?: number; // when the repo was read and found with this commit as its tip
      unattributed?: string[];
      tooLarge?: boolean; // the list of changed files was cut short
    },
  ): PushRecord {
    const c = this.claimNode(id);
    const seenAt = input.seenAt ?? this.clock.now();
    const reason = this.rejection(c, { ...input, seenAt });
    const existing = this.store.getPush(id, input.sha);
    if (existing) {
      // A commit refused before (pushed while stale, first seen on another
      // branch, or out of order) is accepted once the reason no longer holds.
      if (existing.accepted || reason) return existing;
      const { reason: _was, ...rest } = existing;
      // Judged against the scope as it is now (a re-plan may have changed
      // it), from the complete list of files the caller read again.
      const outside = outOfScope(input.paths, c.scope);
      const tooLarge = !!(input.tooLarge || existing.tooLarge);
      const upgraded: PushRecord = {
        ...rest,
        ref: input.ref,
        accepted: true,
        outside: outside.slice(0, MAX_STORED_PATHS),
        verdict: tooLarge ? 'scope-violation' : verdictFor(outside, existing.checks),
      };
      if (outside.length > MAX_STORED_PATHS) upgraded.outsideCount = outside.length;
      else delete upgraded.outsideCount;
      this.store.putPush(upgraded);
      this.store.putNode({ ...c, headSha: input.sha, headSeenAt: seenAt, pushes: c.pushes + 1 });
      this.notifyTouched(c, outside, input.sha);
      return upgraded;
    }
    const outside = outOfScope(input.paths, c.scope);
    // What is kept per commit is bounded, so one huge commit cannot outgrow
    // a stored row; the counts say how much there was.
    const row: PushRecord = {
      claim: id,
      sha: input.sha,
      ref: input.ref,
      before: input.before,
      at: this.clock.now(),
      paths: input.paths.slice(0, MAX_STORED_PATHS),
      outside: outside.slice(0, MAX_STORED_PATHS),
      accepted: !reason,
      // A commit too large to list completely cannot be shown to stay in
      // scope, so it cannot land.
      verdict: outside.length || input.tooLarge ? 'scope-violation' : 'unverified',
    };
    if (input.tooLarge) row.tooLarge = true;
    if (reason) row.reason = reason;
    if (input.paths.length > MAX_STORED_PATHS) row.pathCount = input.paths.length;
    if (outside.length > MAX_STORED_PATHS) row.outsideCount = outside.length;
    if (input.unattributed?.length) row.unattributed = input.unattributed.slice(0, MAX_STORED_PATHS);
    this.store.putPush(row);
    if (row.accepted) this.store.putNode({ ...c, headSha: input.sha, headSeenAt: seenAt, pushes: c.pushes + 1 });
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

  // Start checks on a commit unless a run is already going (two flows for
  // the same commit: the push event and a re-check, say). A run silent for
  // longer than `staleAfterMs` is taken over.
  beginCheck(id: string, sha: string, command: string, owner?: string, staleAfterMs = 45 * 60_000): boolean {
    const row = this.store.getPush(id, sha);
    if (!row) throw new EngineError('not_found', `no push ${sha} on ${id}`);
    const now = this.clock.now();
    // The same run asking again (a retried step) gets the same answer.
    if (row.checks?.status === 'running' && owner && row.checks.runner === owner) return true;
    if (row.checks?.status === 'running' && now - row.checks.startedAt < staleAfterMs) return false;
    if (row.checks && row.checks.status !== 'running') return false;
    this.store.putPush({ ...row, checks: { status: 'running', command, startedAt: now, ...(owner ? { runner: owner } : {}) } });
    return true;
  }

  // Forget the check result on one commit so it can be checked again.
  clearChecks(id: string, sha: string): void {
    const row = this.store.getPush(id, sha);
    if (!row) throw new EngineError('not_found', `no push ${sha} on ${id}`);
    const { checks: _gone, ...rest } = row;
    // Only what the checks said is forgotten; a scope verdict is about the
    // files, and stays.
    this.store.putPush({ ...rest, verdict: row.verdict === 'scope-violation' ? 'scope-violation' : 'unverified' });
  }

  pushRecord(id: string, sha: string): PushRecord | undefined {
    return this.store.getPush(id, sha);
  }

  // The verdict on the claim's current head, if it has one.
  verdictOf(id: string): PushRecord | undefined {
    const c = this.claimNode(id);
    return c.headSha ? this.store.getPush(id, c.headSha) : undefined;
  }

  // An agent run's spend on a claim, reported by the runner when the agent
  // stops (after it has finished, so not under the lease). Informational: it
  // is shown beside the claim's verdicts, never used to judge them.
  recordSpend(id: string, input: { usd: number; turns: number; model?: string }): Claim {
    const c = this.claimNode(id);
    const usd = Number.isFinite(input.usd) && input.usd >= 0 && input.usd < 1000 ? input.usd : 0;
    const turns = Number.isFinite(input.turns) && input.turns >= 0 && input.turns < 100_000 ? Math.round(input.turns) : 0;
    const prev = c.spend ?? { usd: 0, turns: 0, runs: 0 };
    const spend: NonNullable<Claim['spend']> = { usd: prev.usd + usd, turns: prev.turns + turns, runs: prev.runs + 1 };
    const model = input.model?.slice(0, 64) || prev.model;
    if (model) spend.model = model;
    const next = { ...c, spend };
    this.store.putNode(next);
    return next;
  }

  // Lease check alone, for calls that do their own work before writing.
  checkLease(id: string, token: string): Claim {
    return this.held(id, token);
  }

  // Finish a claim. Returns the git tokens to revoke: the work is handed in.
  // A landing that failed before starts afresh.
  finish(id: string, token: string): { revoke: string[]; revokeLine?: Lease['lineToken'] } {
    const c = this.held(id, token);
    if (c.status === 'stale') throw new EngineError('stale', `claim ${id} is stale; re-plan first`);
    if (!this.hedgePermitted(c)) throw new EngineError('hedge_expired', 'the investigation needs an owner decision before more work can be accepted');
    if (this.store.edgesTo(id, 'required for').some((edge) => {
      const premise = this.store.getNode(edge.source);
      return premise?.kind === 'assumption' && !this.assumptionHolds(premise, c.line);
    })) {
      throw new EngineError('contradicted', 'a premise of this claim was withdrawn; re-plan before finishing');
    }
    // Nothing is finished that breaks the constitution together with the line.
    const head = c.headSha ? this.store.getPush(id, c.headSha) : undefined;
    if (head?.pair?.status === 'blocked') {
      throw new EngineError('constitution_pending', 'The shared line already fails these articles; your commit is retained. Wait for its repair and the automatic combination recheck before finishing');
    }
    const inputs = this.line(c.line).checkInputs;
    if (inputs && (head ? head.pair?.inputVersion !== inputs.version || head.pair.status !== 'passed' : this.line(c.line).inputCheck?.version !== inputs.version || this.line(c.line).inputCheck?.status !== 'passed')) {
      throw new EngineError('constitution_pending', 'The declared runtime changed or its check is unavailable; wait for a current constitution check before finishing');
    }
    if (head && this.constitution(c.line).some((a) => a.check && a.proposal) &&
      (head.pair?.status !== 'passed' || !this.pairArticlesMatch(id, head.pair))) {
      throw new EngineError('constitution_pending', 'check this code against the newly adopted constitution before finishing');
    }
    if (head?.pair?.status === 'broken') {
      throw new EngineError('constitution', `commit ${c.headSha} breaks the constitution together with the line (${(head.pair.broken ?? []).join(', ')}); fix it or re-plan first`);
    }
    this.store.putNode({
      ...c,
      status: 'done',
      lease: undefined,
      finishedAt: this.clock.now(),
      deliveredSeq: c.lease!.cursor,
      landing: undefined,
      rebase: undefined,
    });
    return { revoke: tokensOf(c), revokeLine: c.lease!.lineToken };
  }

  // What the agent hands in at finish is what its repo holds: `sha` (already
  // recorded and accepted), or nothing if the repo is back at its base.
  handIn(id: string, token: string, sha: string | null, seenAt: number): Claim {
    const c = this.held(id, token);
    let next = c;
    if (!sha || sha === c.baseSha) next = { ...c, headSha: undefined, headSeenAt: seenAt };
    else if (sha !== c.headSha && this.store.getPush(id, sha)?.accepted && seenAt >= (c.headSeenAt ?? 0)) {
      next = { ...c, headSha: sha, headSeenAt: seenAt };
    }
    if (next !== c) this.store.putNode(next);
    return next;
  }

  // ---- lines and landing ---------------------------------------------------

  // A new line forked from another: the second option of a decision, say.
  // It carries the work landed on its source so far.
  addLine(input: { name: string; from: string; repo: RepoRef; head?: string; decision?: string; option?: string; sharing?: Line['sharing']; group?: string }): Line {
    if (this.store.getLine(input.name)) throw new EngineError('exists', `line ${input.name} exists`);
    const source = this.line(input.from);
    if (source.landing) throw new EngineError('busy', `a landing is in progress on ${input.from}; try again in a moment`);
    const carried = this.claims().filter((c) => c.line === input.from && c.status === 'landed').map((c) => c.id);
    const line: Line = {
      name: input.name,
      repo: input.repo,
      head: input.head,
      served: false,
      from: input.from,
      inherits: [...(source.inherits ?? []), ...carried],
      articles: this.constitution(input.from).map((a) => a.id),
    };
    if (input.decision) line.decision = input.decision;
    if (input.option) line.option = input.option;
    line.sharing = input.sharing ?? source.sharing ?? 'project';
    if (line.sharing === 'isolated') line.group = input.group ?? (input.sharing === 'isolated' ? input.name : source.group ?? input.name);
    if (!this.store.getLine(input.from)) this.store.putLine(source);
    this.store.putLine(line);
    return line;
  }

  // Say which option of which decision an existing line is.
  labelLine(name: string, labels: { decision?: string; option?: string; sharing?: Line['sharing']; group?: string }): Line {
    const line = { ...this.line(name) };
    if (labels.decision !== undefined) line.decision = labels.decision;
    if (labels.option !== undefined) line.option = labels.option;
    if (labels.sharing !== undefined) line.sharing = labels.sharing;
    if (labels.group !== undefined) line.group = labels.group;
    if (line.sharing === 'isolated' && !line.group) line.group = name;
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
    if (!this.hedgePermitted(c)) return false;
    const retryable = c.landing?.status === 'error' && (c.landing.attempts ?? 1) < 3;
    if (c.landing && c.landing.status !== 'queued' && !retryable) return false;
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
  beginNextLanding(lineName: string): { claim: string; sha: string; landing: string } | null {
    const now = this.clock.now();
    let line = this.line(lineName);
    if (line.landing) {
      const timeout = this.opts.landingTimeoutMs ?? 30 * 60_000;
      if (now - line.landing.startedAt < timeout) return null;
      this.failLanding(line.landing.claim, { status: 'error', log: 'the landing never reported back' });
      // A late report from that landing is ignored: it no longer matches.
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
      const attempts = next.landing?.status === 'error' ? next.landing.attempts ?? 1 : 0;
      const landing = `${next.id}-${now}-${attempts + 1}`;
      this.store.putNode({ ...next, landing: { status: 'landing', at: now, attempts } });
      this.store.putLine({ ...line, landing: { id: landing, claim: next.id, sha: next.headSha, startedAt: now } });
      return { claim: next.id, sha: next.headSha, landing };
    }
  }

  // A person gives up on the landing in flight on a line (its Workflow is
  // known to be gone): the claim goes back to the queue as a failed attempt.
  abandonLanding(lineName: string): string | null {
    const line = this.line(lineName);
    if (!line.landing) return null;
    const { claim } = line.landing;
    this.store.putLine({ ...line, landing: undefined });
    const c = this.claimNode(claim);
    if (c.landing?.status === 'landing') this.failLanding(claim, { status: 'error', log: 'given up on by an admin' });
    return claim;
  }

  // A landing that could not even be started (the Workflow was not created)
  // goes back to the queue without using up an attempt.
  abortLanding(lineName: string, id: string, landing: string): void {
    const line = this.line(lineName);
    if (line.landing?.id !== landing) return;
    this.store.putLine({ ...line, landing: undefined });
    const c = this.claimNode(id);
    const attempts = c.landing?.attempts ?? 0;
    this.store.putNode({ ...c, landing: attempts ? { status: 'error', at: this.clock.now(), attempts } : undefined });
  }

  // Apply a landing's outcome, if it is the landing the line is waiting for.
  // A late or repeated report (from a landing given up on, or a retried
  // step) changes nothing. Returns whether it was applied.
  completeLanding(lineName: string, id: string, outcome: LandingOutcome, landing?: string): boolean {
    const line = this.line(lineName);
    const c = this.claimNode(id);
    const current = line.landing?.claim === id && (!landing || line.landing.id === landing);
    if (!current) return false;
    const started = line.landing!.sha;
    this.store.putLine({ ...line, landing: undefined });
    // Is the claim still the work this landing started with?
    const same = (c.status === 'done' || c.status === 'stale') && !c.lease && c.headSha === started;
    if (outcome.status === 'landed') {
      if (same) {
        // A claim made stale while landing is now landed work at risk.
        const atRisk = c.status === 'stale' || outcome.inputVersion !== line.checkInputs?.version;
        this.markLanded(id, outcome.merge, lineName);
        if (atRisk) this.emit('reality.at_risk', [id], { line: lineName, merge: outcome.merge, landedWhileStale: true });
      } else {
        // The claim has moved on since: what git did is recorded on the
        // line, and the claim is left as it is now.
        this.store.putLine({ ...this.line(lineName), head: outcome.merge });
        this.emit('reality.at_risk', [id], { line: lineName, merge: outcome.merge, landedEarlierWork: started });
      }
    } else if (same) this.failLanding(id, outcome);
    return true;
  }

  // A claim whose landing failed goes back to the ready set, keeping its repo,
  // so an agent can bring it up to date with the line and finish it again.
  reopen(id: string): Claim {
    const c = this.claimNode(id);
    if (c.status !== 'done') throw new EngineError('not_done', `claim ${id} is ${c.status}`);
    if (c.landing?.status === 'landing') throw new EngineError('busy', `claim ${id} is landing right now`);
    // Its next holder brings it up to date with the line: what it changes is
    // judged from the line's tip from now on.
    const next: Claim = {
      ...c,
      status: this.openOrStale(c),
      landing: undefined,
      finishedAt: undefined,
      baseSha: this.line(c.line).head ?? c.baseSha,
      rebase: true,
    };
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

  // A holder may revise its own assumptions before global verification.
  // Stale work may also change statement/scope to recover. Every revision
  // keeps the previous plan; no other claim or finding changes status.
  replan(
    id: string,
    token: string,
    change: { statement?: string; scope?: string[]; restsOn: string[] },
  ): Claim {
    const c = this.held(id, token);
    // Live work retains its frozen statement/scope but can stop relying on a
    // disputed premise without waiting for someone else to judge it.
    const withdrawn = this.store.edgesTo(id, 'required for').some((e) => {
      const a = this.store.getNode(e.source);
      return a?.kind === 'assumption' && !this.assumptionHolds(a, c.line);
    });
    const revisingOwnAssumptions = c.status === 'claimed' && change.scope === undefined && change.statement === undefined;
    if (c.status !== 'stale' && !withdrawn && !revisingOwnAssumptions) throw new EngineError('not_stale', `claim ${id} is not stale; an active holder may revise assumptions, but its statement and scope remain frozen`);
    if (change.scope && !validScope(change.scope)) throw new EngineError('bad_request', 'a scope is 1 to 64 patterns of at most 256 characters');
    for (const a of change.restsOn) {
      if (!this.assumptionHolds(this.assumption(a), c.line)) {
        throw new EngineError('contradicted', `assumption ${a} is contradicted`);
      }
    }
    const revision: Claim = { ...c, id: this.store.nextId('r'), status: 'superseded', lease: undefined, landing: undefined };
    this.store.putNode(revision);
    for (const edge of this.store.edgesTo(id, 'required for')) this.store.addEdge({ ...edge, target: revision.id });
    for (const e of this.store.edgesTo(id, 'required for')) {
      if (this.store.getNode(e.source)?.kind === 'assumption') this.store.removeEdge(e);
    }
    for (const a of change.restsOn) this.store.addEdge({ source: a, target: id, purpose: 'required for' });
    this.store.addEdge({ source: id, target: revision.id, purpose: 'supersedes' });
    const next: Claim = {
      ...c,
      statement: change.statement ?? c.statement,
      scope: change.scope ?? c.scope,
      status: 'claimed',
      version: c.version + 1,
      hedgeOn: c.hedgeOn && this.finding(c.hedgeOn).status === 'refuted' ? undefined : c.hedgeOn,
      lease: { ...c.lease!, expiresAt: this.clock.now() + this.opts.leaseMs },
    };
    this.store.putNode(next);
    if (change.scope && next.headSha) this.rejudge(id, next.headSha);
    this.emit('claim.replanned', [id], { version: next.version });
    return next;
  }

  // ---- findings ------------------------------------------------------------

  fileFinding(
    finderId: string,
    token: string,
    input: { statement: string; effect: 'contradicts' | 'helps'; targets: string[]; where?: string[] },
  ): { finding: Finding; duplicate: boolean } {
    this.held(finderId, token);
    if (!input.statement.trim() || input.statement.length > 4000 || !input.targets.length || input.targets.length > 16) {
      throw new EngineError('bad_request', 'a finding needs a statement and one to sixteen targets');
    }
    for (const t of input.targets) {
      if (input.effect === 'contradicts') this.assumption(t);
      else this.claimNode(t);
    }
    // Where a contradiction holds: named claims, only for a contradiction.
    const where = input.effect === 'contradicts' && input.where?.length ? [...new Set(input.where)] : undefined;
    for (const w of where ?? []) this.claimNode(w);
    const origin = this.line(this.claimNode(finderId).line);
    const fingerprint = (origin.sharing === 'isolated' ? `${origin.group ?? origin.name}|` : '') + fingerprintOf(input.statement, input.effect, input.targets, where);
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
      ...(where ? { where } : {}),
      fingerprint,
      hedgeUntil: this.clock.now() + this.opts.hedgeMs,
      at: this.clock.now(),
      line: this.claimNode(finderId).line,
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
    // One rule for doubt: a contradiction with a where doubts the claims
    // inside it; one without doubts everything that rests on its target.
    const reached = f.where
      ? f.where.map((id) => this.store.getNode(id)).filter((n): n is Claim => n?.kind === 'claim' && n.status !== 'open')
      : this.downstreamOf(f.targets);
    for (const c of reached) {
      if (c.status === 'superseded' || !this.findingVisibleTo(f, c.line) || (c.id === f.finder && f.evidence?.status !== 'confirmed' && f.externalEvidence?.status !== 'confirmed')) continue;
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
    if (f.effect === 'contradicts' && f.targets.some((id) => {
      const a = this.assumption(id);
      return a.proposal && a.proposal.resolution !== 'adopted';
    })) throw new EngineError('bad_request', 'a proposed article supplies advice until the owner adopts it');
    if (f.effect === 'contradicts' && !f.where?.length && f.targets.some((id) => this.assumption(id).constitution)) {
      throw new EngineError('bad_request', 'name where the article fails; amending a promise is an owner decision');
    }
    const impact = this.impactOf(findingId);
    this.store.putNode({ ...f, status: 'verified' });
    this.emit('finding.verified', [f.finder], { finding: f.id });

    if (f.effect === 'helps') {
      this.emit('claim.helped', f.targets.filter((id) => this.findingVisibleTo(f, this.claimNode(id).line)), { finding: f.id, statement: f.statement });
      return impact;
    }
    // A located contradiction leaves the target holding everywhere else.
    if (!f.where && this.line(f.line ?? this.findingLine(f)).sharing !== 'isolated') {
      for (const a of f.targets) {
        const node = this.assumption(a);
        if (node.status === 'holding') this.store.putNode({ ...node, status: 'contradicted' });
      }
    }
    this.applyDoubt(f, impact);
    return impact;
  }

  recordExternalCheck(findingId: string, report: Omit<ExternalFindingEvidence, 'at'>): Impact | null {
    const f = this.finding(findingId);
    if (f.status !== 'unverified') throw new EngineError('settled', `finding ${f.id} is ${f.status}`);
    if (f.effect !== 'contradicts') throw new EngineError('bad_request', 'external checks require an unresolved contradiction');
    const fields = ['incident_id', 'workload_digest', 'code_sha', 'config_revision', 'trace_digest', 'verifier_version'] as const;
    if (!report || !['confirmed', 'refuted', 'inconclusive'].includes(report.status) || !report.binding || fields.some((key) => typeof report.binding[key] !== 'string' || !report.binding[key].trim()) || typeof report.reason !== 'string' || !report.reason.trim() || !Array.isArray(report.probes) || report.probes.length === 0 || report.probes.some((probe) => typeof probe !== 'string' || !probe.trim())) {
      throw new EngineError('bad_request', 'external check needs a checked status, complete binding, reason, and string probes');
    }
    const evidence: ExternalFindingEvidence = { ...report, at: this.clock.now() };
    const next = { ...f, externalEvidence: evidence };
    this.store.putNode(next);
    const relevant = f.where ?? this.downstreamOf(f.targets).map((c) => c.id);
    const recipients = [...new Set([f.finder, ...relevant.filter((id) => {
      const c = this.claimNode(id);
      return f.publishedTo?.includes(c.line);
    })])];
    this.emit('finding.external_checked', recipients, { finding: f.id, status: evidence.status, binding: evidence.binding, reason: evidence.reason, probes: evidence.probes });
    if (evidence.status === 'confirmed') return this.verifyFinding(f.id);
    if (evidence.status === 'refuted') {
      this.store.putNode({ ...next, status: 'refuted' });
      this.parkRefutedHedges(next);
      this.emit('finding.refuted', [f.finder], { finding: f.id, evidence: true, external: true });
    }
    return null;
  }

  // What a verified contradiction does to the claims it reaches: in-flight
  // work goes stale and keeps its branch; landed work is at risk.
  private applyDoubt(f: Finding, impact: Impact) {
    const now = this.clock.now();
    const located = f.where ? { where: f.where, constitution: f.finder === 'gate', ...(f.runtimeEvidence ? { runtimeEvidence: f.runtimeEvidence } : {}) } : {};
    for (const id of impact.affected) {
      const c = this.claimNode(id);
      if (c.status === 'stale') continue;
      const kept: KeptBranch[] = c.headSha
        ? [...c.kept, { sha: c.headSha, reason: `finding ${f.id} verified`, at: now }]
        : c.kept;
      // A landing in flight is left to report back; a failed one is cleared,
      // so the claim lands afresh once re-planned and finished.
      const landing = c.landing?.status === 'landing' ? c.landing : undefined;
      this.store.putNode({ ...c, status: 'stale', kept, landing });
      this.emit('claim.stale', [id], { finding: f.id, statement: f.statement, assumptions: f.targets, ...located });
    }
    if (impact.landedAtRisk.length) {
      this.emit('reality.at_risk', impact.landedAtRisk, { finding: f.id, assumptions: f.targets, ...located });
    }
  }

  // Refutation preserves useful work. Only a claim explicitly resting on
  // the suspicion is parked; reporting a suspicion is not that commitment.
  refuteFinding(findingId: string): void {
    const f = this.finding(findingId);
    if (f.status !== 'unverified') throw new EngineError('settled', `finding ${f.id} is ${f.status}`);
    this.store.putNode({ ...f, status: 'refuted' });
    this.parkRefutedHedges(f);
    this.emit('finding.refuted', [f.finder], { finding: f.id });
  }

  private parkRefutedHedges(f: Finding) {
    for (const c of this.claims().filter((c) => c.hedgeOn === f.id && ['claimed', 'done', 'open'].includes(c.status))) {
      const kept = c.headSha ? [...c.kept, { sha: c.headSha, reason: `finding ${f.id} refuted`, at: this.clock.now() }] : c.kept;
      this.store.putNode({ ...c, status: 'stale', kept });
      this.emit('claim.stale', [c.id], { finding: f.id, statement: f.statement, refuted: true });
    }
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
      if (!f.decision) {
        const d: Decision = {
          id: this.store.nextId('d'), kind: 'decision', status: 'review', finding: f.id,
          statement: `Continue investigating finding ${f.id}, or park the investigation?`,
          deadline: f.hedgeUntil, defaultAction: 'park-investigation',
        };
        this.store.putNode(d);
        this.store.putNode({ ...f, decision: d.id });
        this.store.addEdge({ source: d.id, target: f.id, purpose: 'related to' });
        this.emit('decision.opened', [f.finder, ...this.claims().filter((c) => c.hedgeOn === f.id).map((c) => c.id)], { decision: d.id, finding: f.id, defaultAction: d.defaultAction });
      }
    }
    return expired;
  }

  decide(id: string, answer: Decision['answer'], reason: string): Decision {
    const d = this.store.getNode(id);
    if (d?.kind !== 'decision') throw new EngineError('not_found', `no decision ${id}`);
    if (d.status === 'done') throw new EngineError('settled', `decision ${id} is already answered`);
    if (!answer || !['park-investigation', 'continue-investigation'].includes(answer) || !reason.trim()) {
      throw new EngineError('bad_request', 'choose whether to continue or park, and record the reason');
    }
    const next: Decision = { ...d, status: 'done', answer, reason: reason.trim() };
    this.store.putNode(next);
    const f = this.finding(d.finding);
    if (answer === 'continue-investigation' && f.status === 'unverified') {
      this.store.putNode({ ...f, hedgeUntil: this.clock.now() + this.opts.hedgeMs, decision: undefined });
    }
    this.emit('decision.answered', [f.finder, ...this.claims().filter((c) => c.hedgeOn === f.id).map((c) => c.id)], { decision: id, finding: f.id, answer, reason: reason.trim() });
    return next;
  }

  publishFinding(id: string, lines: string[]): Finding {
    const f = this.finding(id);
    if (!lines.length) throw new EngineError('bad_request', 'name the lines that may receive this finding');
    for (const line of lines) if (!this.store.getLine(line) && line !== 'main') throw new EngineError('not_found', `no line ${line}`);
    const publishedTo = [...new Set([...(f.publishedTo ?? []), ...lines])];
    const newly = lines.filter((line) => !f.publishedTo?.includes(line));
    if (!newly.length) return f;
    const next: Finding = { ...f, publishedTo };
    this.store.putNode(next);
    const relevant = f.effect === 'helps' ? f.targets.map((t) => this.claimNode(t)) :
      f.where ? f.where.map((t) => this.claimNode(t)) : this.downstreamOf(f.targets);
    const recipients = relevant.filter((c) => newly.includes(c.line)).map((c) => c.id);
    this.emit('finding.shared', recipients, { finding: id, statement: f.statement, status: f.status, lines: newly });
    if (f.status === 'verified' && f.effect === 'contradicts') this.applyDoubt(next, this.impactOf(id));
    if (f.status === 'verified' && f.effect === 'helps') this.emit('claim.helped', recipients, { finding: id, statement: f.statement });
    return next;
  }

  findingVisibleTo(f: Finding, line: string): boolean {
    if (f.publishedTo?.includes(line)) return true;
    const origin = this.line(f.line ?? this.findingLine(f));
    const destination = this.line(line);
    if (origin.name === line) return true;
    if (origin.sharing !== 'isolated' && destination.sharing !== 'isolated') return true;
    return origin.sharing === 'isolated' && destination.sharing === 'isolated' && (origin.group ?? origin.name) === (destination.group ?? line);
  }

  private findingLine(f: Finding): string {
    const source = this.store.getNode(f.finder);
    return source?.kind === 'claim' ? source.line : f.where?.length ? this.claimNode(f.where[0]!).line : 'main';
  }

  private assumptionHolds(a: Assumption, line: string): boolean {
    if (a.supersededBy || a.supersededOn?.[line] || (a.proposal && a.proposal.resolution !== 'adopted')) return false;
    if (a.status === 'contradicted' && !this.findings().some((f) => f.status === 'verified' && f.targets.includes(a.id) && !this.findingVisibleTo(f, line))) return false;
    return !this.findings().some((f) => f.status === 'verified' && !f.where && f.effect === 'contradicts' && f.targets.includes(a.id) && this.findingVisibleTo(f, line));
  }

  private hedgePermitted(c: Claim): boolean {
    if (!c.hedgeOn) return true;
    const f = this.finding(c.hedgeOn);
    if (f.status === 'refuted') return c.status === 'stale'; // lease takeover permits re-planning, never another accepted push
    return f.status !== 'unverified' || f.hedgeUntil > this.clock.now();
  }

  private pairArticlesMatch(id: string, pair: PairCheck): boolean {
    const articles = this.constitution(this.claimNode(id).line).filter((a) => a.check);
    if (!pair.articles) return !articles.some((a) => a.proposal);
    return JSON.stringify([...pair.articles].sort()) === JSON.stringify(articles.map((a) => a.id).sort());
  }

  beginFindingCheck(id: string, lineHead: string): {
    finding: string; evidence: FindingEvidence; line: RepoRef;
    heads: { claim: string; sha: string; repo: RepoRef }[];
    articles: { id: string; check: string }[];
  } {
    const f = this.finding(id);
    if (f.status !== 'unverified' || f.effect !== 'contradicts') throw new EngineError('settled', 'only an unverified contradiction can be checked');
    if (!f.where?.length || f.where.length > 8) throw new EngineError('bad_request', 'mechanical verification needs one to eight claims in where');
    const lineName = f.line ?? this.findingLine(f);
    const line = this.line(lineName);
    if (!line.repo || !lineHead) throw new EngineError('no_repo', 'the line needs code before this finding can be checked');
    const active = this.constitution(lineName);
    const articles = f.targets.map((target) => {
      const a = active.find((a) => a.id === target);
      if (!a?.check) throw new EngineError('bad_request', 'this finding needs owner judgment: every target must be an active executable article');
      return { id: a.id, check: a.check };
    });
    const heads = f.where.map((claim) => {
      const c = this.claimNode(claim);
      if (c.line !== lineName && !line.inherits?.includes(claim)) throw new EngineError('bad_request', 'where must name code belonging to this reality');
      if (!c.headSha || !c.repo || c.status === 'superseded') throw new EngineError('no_repo', `claim ${claim} has no current code to check`);
      return { claim, sha: c.headSha, repo: c.repo };
    });
    const evidence: FindingEvidence = { status: 'running', line: lineName, lineHead,
      heads: heads.map(({ claim, sha }) => ({ claim, sha })), articles, at: this.clock.now() };
    if (f.evidence?.status === 'running' && this.clock.now() - f.evidence.at < 45 * 60_000) throw new EngineError('busy', 'this finding is already being checked');
    this.store.putNode({ ...f, evidence });
    return { finding: id, evidence, line: line.repo, heads, articles };
  }

  recordFindingCheck(id: string, evidence: FindingEvidence): Finding {
    const f = this.finding(id);
    if (f.status !== 'unverified') return f;
    const currentRun = f.evidence?.status === 'running' && f.evidence.at === evidence.at &&
      f.evidence.lineHead === evidence.lineHead &&
      JSON.stringify(f.evidence.heads) === JSON.stringify(evidence.heads) &&
      JSON.stringify(f.evidence.articles) === JSON.stringify(evidence.articles);
    // A delayed result cannot overwrite a newer check or its verdict.
    if (!currentRun) return f;
    const same =
      evidence.heads.every(({ claim, sha }) => this.claimNode(claim).headSha === sha) &&
      evidence.articles.every(({ id, check }) => this.constitution(evidence.line).some((a) => a.id === id && a.check === check));
    const recorded: FindingEvidence = same ? evidence : { ...evidence, status: 'inconclusive', log: 'The checked inputs changed; this result cannot settle the finding.' };
    const next: Finding = { ...f, evidence: recorded };
    this.store.putNode(next);
    this.emit('finding.checked', [f.finder], { finding: id, status: recorded.status, lineHead: recorded.lineHead, heads: recorded.heads, articles: recorded.articles, log: recorded.log ?? '' });
    if (recorded.status === 'confirmed') this.verifyFinding(id);
    if (recorded.status === 'refuted') {
      this.store.putNode({ ...next, status: 'refuted' });
      this.parkRefutedHedges(f);
      this.emit('finding.refuted', [f.finder], { finding: id, evidence: true });
    }
    return this.finding(id);
  }

  // ---- reads -----------------------------------------------------------------

  // Why is this file the way it is in a reality? The landed claims that
  // changed it (on the line, or carried from the line it was forked from),
  // oldest first: what each one set out to make true, what it rested on, the
  // verdict on the commit that landed, and the merge that brought it in.
  why(path: string, lineName?: string): WhyEntry[] {
    const line = lineName ? this.line(lineName) : this.store.lines().find((l) => l.served) ?? this.line('main');
    const inherited = new Set(line.inherits ?? []);
    const out: WhyEntry[] = [];
    for (const c of this.claims()) {
      if (c.status !== 'landed' || !c.headSha || !(c.line === line.name || inherited.has(c.id))) continue;
      const row = this.store.getPush(c.id, c.headSha);
      if (!row?.paths.includes(path)) continue;
      const assumptions = this.store
        .edgesTo(c.id, 'required for')
        .map((e) => this.store.getNode(e.source))
        .filter((n): n is Assumption => n?.kind === 'assumption')
        .map((a) => ({ id: a.id, statement: a.statement, status: a.status }));
      out.push({
        claim: c.id,
        statement: c.statement,
        line: c.line,
        commit: c.headSha,
        merge: c.landedSha ?? null,
        verdict: row.verdict,
        assumptions,
        finishedAt: c.finishedAt ?? null,
      });
    }
    return out.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  }

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
    return this.store.allNodes().map(forDisplay);
  }

  contextFor(id: string, token: string) {
    const viewer = this.held(id, token);
    const destination = this.line(viewer.line);
    const allowedLines = new Set(this.lines().filter((line) => line.name === destination.name ||
      (line.sharing !== 'isolated' && destination.sharing !== 'isolated') ||
      (line.sharing === 'isolated' && destination.sharing === 'isolated' && (line.group ?? line.name) === (destination.group ?? destination.name))).map((line) => line.name));
    allowedLines.add(viewer.line);
    const claims = this.claims().filter((c) => allowedLines.has(c.line));
    const claimIds = new Set(claims.map((c) => c.id));
    const assumptionIds = new Set(this.store.allNodes().filter((n) => n.kind === 'assumption' &&
      (this.constitution(viewer.line).some((a) => a.id === n.id) || this.store.edgesFrom(n.id, 'required for').some((e) => claimIds.has(e.target)))).map((n) => n.id));
    const findings = this.findings().filter((f) => this.findingVisibleTo(f, viewer.line) &&
      (f.status !== 'unverified' || f.finder === id || viewer.hedgeOn === f.id || f.publishedTo?.includes(viewer.line)));
    const findingIds = new Set(findings.map((f) => f.id));
    const nodes = this.nodesForDisplay().filter((n) => n.kind === 'claim' ? claimIds.has(n.id) :
      n.kind === 'assumption' ? assumptionIds.has(n.id) || (n.proposal?.by === id) :
      n.kind === 'finding' ? findingIds.has(n.id) : findingIds.has(n.finding));
    return this.snapshotSelection(nodes.map((n) => n.kind === 'assumption' && (!n.proposal || n.proposal.resolution === 'adopted') ? { ...n, status: this.assumptionHolds(n, viewer.line) ? 'holding' as const : 'contradicted' as const } : n),
      this.lines().filter((line) => allowedLines.has(line.name)), this.events().filter((event) => event.claims.includes(id)));
  }

  publicContext() {
    const hiddenClaims = new Set(this.claims().filter((c) => this.line(c.line).sharing === 'isolated').map((c) => c.id));
    const nodes = this.nodesForDisplay().filter((n) => {
      if (n.kind === 'claim') return !hiddenClaims.has(n.id);
      if (n.kind === 'finding') return (n.status !== 'unverified' && this.line(n.line ?? this.findingLine(n)).sharing !== 'isolated') || n.publishedTo?.some((line) => this.line(line).sharing !== 'isolated');
      if (n.kind === 'decision') {
        const f = this.finding(n.finding);
        return (f.status !== 'unverified' && this.line(f.line ?? this.findingLine(f)).sharing !== 'isolated') ||
          f.publishedTo?.some((line) => this.line(line).sharing !== 'isolated');
      }
      return (!n.line || this.line(n.line).sharing !== 'isolated') &&
        (!this.store.edgesFrom(n.id, 'required for').length || this.store.edgesFrom(n.id, 'required for').some((e) => !hiddenClaims.has(e.target)));
    });
    const ids = new Set(nodes.map((n) => n.id));
    return this.snapshotSelection(nodes, this.lines().filter((line) => line.sharing !== 'isolated'),
      this.events().filter((event) => typeof event.data.finding === 'string' && !ids.has(event.data.finding) ? false : event.claims.length ? event.claims.some((id) => !hiddenClaims.has(id)) :
        typeof event.data.line === 'string' ? this.line(event.data.line).sharing !== 'isolated' :
        typeof event.data.claim === 'string' ? ids.has(event.data.claim) :
        typeof event.data.article === 'string' ? ids.has(event.data.article) : false));
  }

  private snapshotSelection(nodes: GraphNode[], lines: Line[], events: GraphEvent[]) {
    const ids = new Set(nodes.map((node) => node.id));
    return { nodes, lines, events,
      edges: this.store.allNodes().flatMap((n) => this.store.edgesFrom(n.id)).filter((e) => ids.has(e.source) && ids.has(e.target)),
      pushes: this.store.pushes().filter((row) => ids.has(row.claim)),
    };
  }

  readyForDisplay(): GraphNode[] {
    return this.ready().map(forDisplay);
  }

  // ---- internals ---------------------------------------------------------------

  private rejection(c: Claim, input: { ref: string; isHead: boolean; seenAt: number }): PushRecord['reason'] {
    if (input.ref !== MAIN) return 'other-branch';
    if (!this.hedgePermitted(c)) return 'hedge-expired';
    if (c.status === 'stale') return 'stale';
    if (c.status !== 'claimed') return 'not-claimed';
    // Two inspections in flight: the one that read the repo later wins, so
    // the head never moves back to an older commit.
    if (!input.isHead || input.seenAt < (c.headSeenAt ?? 0)) return 'not-head';
    return undefined;
  }

  // What a claim builds on has landed (or finished, under the 'done' gate).
  private dependenciesMet(id: string): boolean {
    const c = this.claimNode(id);
    return this.store.edgesTo(id, 'required for').every((e) => {
      const src = this.store.getNode(e.source);
      return src?.kind !== 'claim' || this.depMet(c, src);
    });
  }

  // One claim's dependency on another is met when the other has landed (or
  // finished, under the 'done' gate) where this one's fork will see it: on the
  // same line, or inherited by this line from the one it was forked from.
  private depMet(c: Claim, dep: Claim): boolean {
    const finished = this.opts.dependencyGate === 'landed' ? dep.status === 'landed' : dep.status === 'done' || dep.status === 'landed';
    if (!finished || this.opts.dependencyGate !== 'landed') return finished;
    return dep.line === c.line || (this.store.getLine(c.line)?.inherits ?? []).includes(dep.id);
  }

  // A claim handed back is open again, unless it rests on something already
  // contradicted: then its next holder must re-plan first.
  private openOrStale(c: Claim): 'open' | 'stale' {
    if (c.status === 'stale') return 'stale';
    const contradicted = this.store
      .edgesTo(c.id, 'required for')
      .some((e) => {
        const src = this.store.getNode(e.source);
        return src?.kind === 'assumption' && !this.assumptionHolds(src, c.line);
      });
    return contradicted ? 'stale' : 'open';
  }

  // Judge a recorded commit again against the claim's current scope.
  private rejudge(id: string, sha: string) {
    const c = this.claimNode(id);
    const row = this.store.getPush(id, sha);
    if (!row) return;
    // The stored list was cut short: it cannot show the commit stays inside
    // the new scope, so it does not land; the agent pushes again.
    if (row.pathCount || row.tooLarge) {
      this.store.putPush({ ...row, verdict: 'scope-violation' });
      return;
    }
    const outside = outOfScope(row.paths, c.scope);
    this.store.putPush({ ...row, outside, verdict: verdictFor(outside, row.checks) });
  }

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
    if (merge) this.store.putLine({ ...this.line(lineName), head: merge, inputCheck: undefined });
    this.emit('claim.landed', [id], { line: lineName, merge: merge ?? null });
  }

  private failLanding(id: string, outcome: Exclude<LandingOutcome, { status: 'landed' }>) {
    const c = this.claimNode(id);
    const landing: LandingState = { status: outcome.status, at: this.clock.now() };
    if (outcome.status === 'error') landing.attempts = (c.landing?.attempts ?? 0) + 1;
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
      // A claim that only waited for this one (overlapping scopes) rests on
      // nothing of its work.
      for (const e of this.store.edgesFrom(id, 'required for')) if (!e.meta?.order) queue.push(e.target);
    }
    return out;
  }

  // ---- the constitution and the gate on pairs -----------------------------------

  setCheckInputs(lineName: string, required: string[], values: CheckInputs['values'], baseVersion: number): CheckInputs {
    if (!Number.isInteger(baseVersion) || baseVersion < 0) throw new EngineError('bad_request', 'A nonnegative baseVersion is required');
    try { validateCheckInputs(required, values); } catch (error) { throw new EngineError('bad_request', String(error)); }
    const line = this.line(lineName);
    if (baseVersion !== (line.checkInputs?.version ?? 0)) throw new EngineError('settled', 'Check inputs changed; read the current version before updating');
    const inputs = { version: baseVersion + 1, required, values };
    this.store.putLine({ ...line, checkInputs: inputs, inputCheck: undefined });
    this.emit('inputs.changed', this.inputRecipients(lineName), { line: lineName, inputVersion: inputs.version, revisions: Object.fromEntries(Object.entries(values).map(([name, v]) => [name, v.revision])) });
    return inputs;
  }

  private inputRecipients(lineName: string, articles = this.constitution(lineName).filter(a => a.check)): string[] {
    return this.claims().filter(c => c.line === lineName && c.status !== 'superseded' && articles.some(a => !a.paths || scopesOverlap(a.paths, c.scope))).map(c => c.id);
  }

  recordInputCheck(lineName: string, sha: string, version: number, runs: { article: string; check: CheckRun }[], currentCode = true): boolean {
    const line = this.line(lineName);
    const current = currentCode && line.checkInputs?.version === version;
    if (!current) { this.emit('inputs.checked', [], { line: lineName, sha, inputVersion: version, current: false, status: 'historical' }); return false; }
    const articles = this.constitution(lineName).filter(a => a.check);
    if (runs.length !== articles.length || articles.some(a => !runs.some(r => r.article === a.id && r.check.command === a.check)) || runs.some(r => r.check.inputVersion !== version)) {
      this.emit('inputs.checked', [], { line: lineName, sha, inputVersion: version, current: false, status: 'historical', reason: 'The adopted checks changed during verification.' });
      return false;
    }
    const failed = runs.filter(r => r.check.status === 'failed').map(r => this.assumption(r.article));
    const error = !articles.length || line.checkInputs!.required.some(name => !line.checkInputs!.values[name]) || runs.some(r => !['passed', 'failed'].includes(r.check.status));
    const status = error ? 'error' : failed.length ? 'broken' : 'passed';
    this.store.putLine({ ...line, inputCheck: { version, sha, status, at: this.clock.now(), broken: failed.map(a => a.id) } });
    this.emit('inputs.checked', this.inputRecipients(lineName), { line: lineName, sha, inputVersion: version, status, broken: failed.map(a => a.id), log: runs.map(r => r.check.log ?? '').join('\n').slice(-4000) });
    if (!error && failed.length) this.runtimeFinding(lineName, sha, version, failed, runs.map(r => r.check.log ?? '').join('\n'));
    if (status === 'passed') for (const f of this.findings()) if (f.finder === 'gate' && f.status === 'verified' && f.runtimeEvidence?.line === lineName) {
      this.store.putNode({ ...f, status: 'resolved' });
      this.emit('reality.restored', f.where ?? [], { finding: f.id, line: lineName, inputVersion: version });
    }
    return true;
  }

  private runtimeFinding(lineName: string, sha: string, version: number, articles: Assumption[], log: string): Finding {
    const where = this.inputRecipients(lineName, articles);
    const existing = this.findings().find(f => f.finder === 'gate' && f.runtimeEvidence?.line === lineName && f.runtimeEvidence.sha === sha && f.runtimeEvidence.inputVersion === version && f.targets.length === articles.length && articles.every(a => f.targets.includes(a.id)));
    if (existing) {
      const added = where.filter(id => !existing.where?.includes(id));
      if (added.length) {
        const next = { ...existing, where: [...(existing.where ?? []), ...added] };
        this.store.putNode(next);
        const impact = this.impactOf(next.id);
        this.applyDoubt(next, { ...impact, affected: impact.affected.filter(id => added.includes(id)), landedAtRisk: impact.landedAtRisk.filter(id => added.includes(id)) });
      }
      return existing;
    }
    const statement = `${articles.map(a => `“${a.statement}”`).join(' and ')} fails on ${lineName} at ${sha.slice(0, 7)} with declared check inputs version ${version}: ${excerpt(log)}`;
    const fingerprint = fingerprintOf(statement, 'contradicts', articles.map(a => a.id), where);
    const finding: Finding = { id: this.store.nextId('f'), kind: 'finding', statement, effect: 'contradicts', status: 'verified', finder: 'gate', targets: articles.map(a => a.id), where, fingerprint, hedgeUntil: this.clock.now(), at: this.clock.now(), line: lineName, runtimeEvidence: { line: lineName, sha, inputVersion: version } };
    this.store.putNode(finding);
    for (const article of articles) this.store.addEdge({ source: finding.id, target: article.id, purpose: 'contradicts' });
    this.applyDoubt(finding, this.impactOf(finding.id));
    return finding;
  }

  // What the pair check needs for one claim: its repo, its line's repo, the
  // executable articles, and the landings on the line since the claim's fork
  // point (the work its head meets), oldest first.
  pairContext(id: string): PairContext {
    const c = this.claimNode(id);
    const articles = this.constitution(c.line)
      .filter((a) => a.check)
      .map((a) => ({ id: a.id, check: a.check!, statement: a.statement }));
    if (!articles.length) return { skip: 'the constitution has no executable articles' };
    const l = this.line(c.line);
    if (!c.repo || !l.repo) return { skip: `no repo for ${id} or its line` };
    const landings = this.store
      .eventsSince(0)
      .filter((e) => e.type === 'claim.landed' && e.data.line === c.line && typeof e.data.merge === 'string')
      .map((e) => ({ claim: e.claims[0]!, merge: e.data.merge as string }));
    const k = landings.findIndex((x) => x.merge === c.forkSha);
    const candidates = landings.slice(k + 1).filter((x) => x.claim !== id);
    return { line: l.repo, claim: c.repo, articles, candidates };
  }

  // Start the pair check on a commit unless a run is already going, or the
  // commit was already judged against the line as it stands now. A line
  // that moved since (a landing) makes an earlier verdict void: the pair is
  // a different pair.
  beginPair(id: string, sha: string, owner?: string, staleAfterMs = 45 * 60_000): boolean {
    const row = this.store.getPush(id, sha);
    if (!row) throw new EngineError('not_found', `no push ${sha} on ${id}`);
    const now = this.clock.now();
    const inputVersion = this.line(this.claimNode(id).line).checkInputs?.version;
    if (row.pair?.inputVersion === inputVersion && row.pair?.status === 'running' && owner && row.pair.runner === owner) return true;
    if (row.pair?.inputVersion === inputVersion && row.pair?.status === 'running' && now - row.pair.startedAt < staleAfterMs) return false;
    if (row.pair && row.pair.status !== 'running') {
      const lineHead = this.line(this.claimNode(id).line).head ?? null;
      const judgedAgainst = row.pair.lineHead ?? null;
      if (row.pair.inputVersion === inputVersion && (row.pair.status === 'skipped' || judgedAgainst === lineHead) && this.pairArticlesMatch(id, row.pair)) return false;
    }
    this.store.putPush({ ...row, pair: { status: 'running', startedAt: now, ...(inputVersion ? { inputVersion } : {}), ...(owner ? { runner: owner } : {}) } });
    return true;
  }

  // After a landing, the in-flight heads on the line were paired with a line
  // that no longer exists. These are judged again against the new head.
  pairRechecks(lineName: string): { claim: string; sha: string; repo: string }[] {
    const head = this.line(lineName).head ?? null;
    const out: { claim: string; sha: string; repo: string }[] = [];
    for (const c of this.claims()) {
      if (c.line !== lineName || !c.headSha || !c.repo) continue;
      if (!(c.status === 'claimed' || c.status === 'stale' || c.status === 'done')) continue;
      if (c.landing?.status === 'landing') continue;
      const row = this.store.getPush(c.id, c.headSha);
      if (!row?.accepted || (row.verdict !== 'checks-passed' && row.checks?.status !== 'skipped')) continue;
      if (row.pair && row.pair.inputVersion === this.line(lineName).checkInputs?.version && (row.pair.status === 'running' || ((row.pair.status === 'skipped' || (row.pair.lineHead ?? null) === head) && this.pairArticlesMatch(c.id, row.pair)))) continue;
      out.push({ claim: c.id, sha: c.headSha, repo: c.repo.name });
    }
    return out;
  }

  // The pair check's result on one commit. A break files a finding the gate
  // itself verified: the article is false where this claim and its partner
  // are together, so the claim is stale and a landed partner is at risk.
  // A pass resolves the gate's earlier findings about this claim. A result
  // for a commit the claim has since moved past is recorded and nothing more.
  recordPair(id: string, sha: string, pair: PairCheck): PushRecord {
    const row = this.store.getPush(id, sha);
    if (!row) throw new EngineError('not_found', `no push ${sha} on ${id}`);
    const next: PushRecord = { ...row, pair };
    if (pair.inputVersion !== this.line(this.claimNode(id).line).checkInputs?.version) {
      this.emit('claim.pair_checked', [], { sha, status: pair.status, inputVersion: pair.inputVersion ?? null, current: false });
      return row;
    }
    this.store.putPush(next);
    if (pair.status === 'running') return next;
    const c = this.claimNode(id);
    const current = c.headSha === sha && pair.inputVersion === this.line(c.line).checkInputs?.version && this.pairArticlesMatch(id, pair) &&
      (pair.lineHead === undefined || this.line(c.line).head === undefined || pair.lineHead === this.line(c.line).head);
    this.emit('claim.pair_checked', [id], {
      sha,
      status: pair.status,
      broken: pair.broken ?? [],
      baselineBroken: pair.baselineBroken ?? [],
      partner: pair.partner ?? null,
      lineHead: pair.lineHead ?? null,
      files: pair.files ?? [],
      current,
    });
    if (!current) return next;
    if (pair.status === 'broken' && pair.broken?.length) this.fileGateFinding(id, sha, pair);
    if (pair.status === 'passed') this.resolveGateFindings(id);
    return next;
  }

  private fileGateFinding(id: string, sha: string, pair: PairCheck): Finding {
    const articles = (pair.broken ?? []).map((a) => this.assumption(a));
    const where = pair.partner && pair.partner !== id ? [id, pair.partner] : [id];
    const together = pair.partner && pair.partner !== id ? `${id} at ${sha.slice(0, 7)} and ${pair.partner} are together` : `${id} at ${sha.slice(0, 7)} meets the line at ${(pair.lineHead ?? '').slice(0, 7)}`;
    const statement = `${articles.map((a) => `“${a.statement}”`).join(' and ')} ${articles.length > 1 ? 'are' : 'is'} false where ${together}: ${excerpt(pair.log ?? '')}`;
    const fingerprint = fingerprintOf(statement, 'contradicts', articles.map((a) => a.id), where);
    const existing = this.findings().find((f) => f.fingerprint === fingerprint);
    if (existing) return existing;
    const f: Finding = {
      id: this.store.nextId('f'),
      kind: 'finding',
      statement,
      effect: 'contradicts',
      status: 'verified',
      finder: 'gate',
      targets: articles.map((a) => a.id),
      where,
      fingerprint,
      hedgeUntil: this.clock.now(),
      at: this.clock.now(),
      line: this.claimNode(id).line,
    };
    this.store.putNode(f);
    for (const t of f.targets) this.store.addEdge({ source: f.id, target: t, purpose: 'contradicts' });
    this.applyDoubt(f, this.impactOf(f.id));
    return f;
  }

  private resolveGateFindings(id: string) {
    for (const f of this.findings()) {
      if (f.finder !== 'gate' || f.status !== 'verified' || !f.where?.includes(id)) continue;
      if (f.runtimeEvidence) continue; // only a current line audit restores a runtime failure
      this.store.putNode({ ...f, status: 'resolved' });
      const landed = f.where.filter((w) => this.store.getNode(w)?.kind === 'claim' && (this.store.getNode(w) as Claim).status === 'landed');
      this.emit('reality.restored', landed, { finding: f.id, by: id });
    }
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

export function constitutionPath(path: string): boolean {
  return path.startsWith('constitution/') && !path.includes('\\') && !path.split('/').some((part) => !part || part === '.' || part === '..');
}

function fingerprintOf(statement: string, effect: string, targets: string[], where?: string[]): string {
  return `${effect}|${[...targets].sort().join(',')}|${where ? [...where].sort().join(',') : ''}|${normalise(statement)}`;
}

// The first lines of a check's output that say why, for a finding's statement.
function excerpt(log: string): string {
  const lines = log
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('---') && !/^(BROKEN|PARTNER|CAND|ARTICLE|BASE|MERGED|SETUP) /.test(l));
  // node:test prints the assertion as `error: 'message'`, or as a YAML block
  // (`error: |-`) with the message on the lines below.
  const at = lines.findIndex((l) => /^error:/i.test(l));
  let pick = '';
  if (at >= 0) {
    const inline = lines[at]!.replace(/^error:\s*/i, '');
    pick = /^(\|-?|>-?)?$/.test(inline) ? (lines[at + 1] ?? '') : inline;
  } else {
    pick = lines.find((l) => /assert|charged|expected/i.test(l)) ?? lines.find((l) => /^not ok/.test(l)) ?? lines[0] ?? '';
  }
  const clean = pick.replace(/^['"]|['"]$/g, '');
  return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean;
}

function pushResult(row: PushRecord): PushResult {
  if (!row.accepted && (row.reason === 'stale' || row.reason === 'hedge-expired')) return { accepted: false, reason: row.reason };
  return {
    accepted: row.accepted,
    verdict: row.outside.length ? 'scope-violation' : 'in-scope',
    outside: row.outside,
  };
}

// Every git token a claim's lease holds: the current one and the ones it
// replaced at renewals that have not expired yet.
function tokensOf(c: Claim): string[] {
  if (!c.lease) return [];
  return [...(c.lease.git ? [c.lease.git.tokenId] : []), ...(c.lease.retired ?? []).map((t) => t.tokenId)];
}

// The verdict for a commit, from what it changes outside the scope and what
// its checks said.
function verdictFor(outside: string[], checks: CheckRun | undefined): Verdict {
  if (outside.length) return 'scope-violation';
  switch (checks?.status) {
    case 'passed':
      return 'checks-passed';
    case 'failed':
      return 'checks-failed';
    case 'error':
      return 'verifier-failed';
    case 'timeout':
      return 'budget-exhausted';
    default:
      return 'unverified';
  }
}

function forDisplay(n: GraphNode): GraphNode {
  if (n.kind !== 'claim' || !n.lease) return n;
  const { token: _secret, ...lease } = n.lease;
  return { ...n, lease: { ...lease, token: '' } };
}
