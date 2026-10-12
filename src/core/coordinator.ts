import { EngineError, type Engine, type RenewResult } from './engine';
import {
  changedPaths,
  claimRepoName,
  lineRepoName,
  trailerClaims,
  UnknownCommitError,
  type GitAccess,
  type RepoHost,
} from './repos';
import type { CheckRun, Claim, ClaimStatus, PushRecord, RepoRef } from './types';

export interface PushReport {
  sha: string;
  ref: string;
  before: string | null;
  commits?: { id: string; message: string }[];
}

// Runs one synchronous step of the engine as a transaction: everything in it
// is written, or nothing is (an EngineError rolls it back).
export type Tx = <T>(fn: (engine: Engine) => T) => T;

export interface ClaimGrant {
  token: string; // the lease token: Authorization for renew, push, finish
  expiresAt: number;
  status: ClaimStatus; // 'stale' means: re-plan before working
  repo: RepoRef; // the claim's own repo, a fork of its line
  baseSha?: string; // the commit the fork started from
  git?: GitAccess; // write access that lives exactly as long as the lease
}

export interface RenewGrant extends RenewResult {
  git?: GitAccess;
}

// The claim lifecycle across the graph and the git host. The engine decides
// (synchronously, in a transaction); the coordinator then does the slow work
// on the host — forking, minting and revoking tokens — and records the result
// in a second transaction. If the host fails while a claim is being taken, the
// claim is handed back, so nobody holds a lease without a repo.
export class Coordinator {
  constructor(
    private tx: Tx,
    private host: RepoHost,
    private opts: { graph: string; now?: () => number },
  ) {}

  // The repo for a line, made empty if it does not exist yet. An admin seeds a
  // new line by pushing to it with a token from `lineAccess`.
  async ensureLine(line: string): Promise<RepoRef & { head?: string }> {
    const repo = await this.host.ensure(lineRepoName(this.opts.graph, line));
    this.tx((e) => {
      const known = e.line(line);
      if (!known.repo) e.saveLine({ ...known, repo: { name: repo.name, remote: repo.remote } });
    });
    return repo;
  }

  // Fork a line into a new one: another option of a decision, built side by side.
  async createLine(input: { name: string; from: string; decision?: string; option?: string }) {
    const source = await this.ensureLine(input.from);
    if (!source.head) throw new EngineError('empty_line', `line ${input.from} has no commits to fork`);
    const fork = await this.host.fork(source.name, lineRepoName(this.opts.graph, input.name));
    return this.tx((e) => e.addLine({ ...input, repo: { name: fork.name, remote: fork.remote }, head: fork.head }));
  }

  async lineAccess(line: string, scope: 'read' | 'write', ttlSeconds: number): Promise<GitAccess & { repo: string }> {
    const repo = await this.ensureLine(line);
    const t = await this.host.mintToken(repo.name, scope, ttlSeconds);
    return { repo: repo.name, remote: repo.remote, token: t.secret, expiresAt: t.expiresAt };
  }

  async claim(id: string, agent: string): Promise<ClaimGrant> {
    const { revoke, ...lease } = this.tx((e) => e.claim(id, agent));
    try {
      let c = this.tx((e) => e.getClaim(id));
      if (revoke && c.repo) await this.revokeQuietly(c.repo.name, revoke);
      if (!c.repo) {
        const line = await this.ensureLine(c.line);
        const fork = await this.host.fork(line.name, claimRepoName(this.opts.graph, id));
        c = this.tx((e) => e.attachRepo(id, lease.token, { name: fork.name, remote: fork.remote }, fork.head));
      }
      const grant: ClaimGrant = { ...lease, repo: c.repo!, baseSha: c.baseSha };
      // A stale claim gets no write access until it is re-planned.
      if (lease.status !== 'stale') grant.git = await this.grantGit(id, lease.token, lease.expiresAt, c.repo!);
      return grant;
    } catch (err) {
      await this.handBack(id, lease.token);
      if (err instanceof EngineError) throw err;
      throw new EngineError('repo_unavailable', `could not prepare the repo for ${id}: ${describe(err)}`);
    }
  }

  // Renewing the lease renews the git token with it. A stale claim's renewal
  // fails, so its token is not renewed and lapses with the lease.
  async renew(id: string, token: string): Promise<RenewGrant> {
    const result = this.tx((e) => e.renew(id, token));
    if (!result.ok) return result;
    const c = this.tx((e) => e.getClaim(id));
    if (!c.repo) return result;
    try {
      return { ...result, git: await this.grantGit(id, token, result.expiresAt!, c.repo) };
    } catch {
      // The lease is renewed; the previous git token still works until it
      // expires, and the next renewal tries again.
      return result;
    }
  }

  // What an agent hands in is whatever is in its repo: the head is read and
  // recorded before the claim closes, so a push whose event arrives after
  // the agent finished still counts.
  async finish(id: string, token: string): Promise<void> {
    const c = this.tx((e) => e.checkLease(id, token));
    if (c.repo && c.status === 'claimed') {
      const head = await this.host.readHead(c.repo.name);
      if (head && head !== c.baseSha) await this.inspectPush(id, { sha: head, ref: 'refs/heads/main', before: null });
    }
    const { revoke } = this.tx((e) => e.finish(id, token));
    if (revoke && c.repo) await this.revokeQuietly(c.repo.name, revoke);
  }

  async release(id: string, token: string): Promise<void> {
    const c = this.tx((e) => e.getClaim(id));
    const { revoke } = this.tx((e) => e.release(id, token));
    if (revoke && c.repo) await this.revokeQuietly(c.repo.name, revoke);
  }

  async replan(
    id: string,
    token: string,
    change: { statement?: string; scope?: string[]; restsOn: string[] },
  ): Promise<{ claim: Claim; git?: GitAccess }> {
    const claim = this.tx((e) => e.replan(id, token, change));
    if (!claim.repo) return { claim };
    try {
      return { claim, git: await this.grantGit(id, token, claim.lease!.expiresAt, claim.repo) };
    } catch {
      return { claim };
    }
  }

  // Check a push against the claim's declared scope. The platform reads the
  // commit from the repo itself: what changed is never taken from the agent.
  async inspectPush(id: string, push: PushReport): Promise<PushRecord> {
    const c = this.tx((e) => e.getClaim(id));
    if (!c.repo) throw new EngineError('no_repo', `claim ${id} has no repo yet`);
    const known = this.tx((e) => e.pushRecord(id, push.sha));
    if (known?.accepted) return known;
    if (known) {
      // Seen before but refused: judge it again as it stands now.
      const head = await this.host.readHead(c.repo.name);
      return this.tx((e) =>
        e.recordPush(id, { sha: push.sha, ref: push.ref, before: push.before, paths: known.paths, isHead: head === push.sha }),
      );
    }
    let paths: string[];
    let head: string | null;
    try {
      [paths, head] = await Promise.all([
        changedPaths(this.host, c.repo.name, c.baseSha ?? null, push.sha),
        this.host.readHead(c.repo.name),
      ]);
    } catch (err) {
      if (err instanceof UnknownCommitError) throw new EngineError('unknown_commit', err.message);
      throw err;
    }
    const unattributed = (push.commits ?? []).filter((m) => !trailerClaims(m.message).includes(id)).map((m) => m.id);
    return this.tx((e) =>
      e.recordPush(id, { sha: push.sha, ref: push.ref, before: push.before, paths, isHead: head === push.sha, unattributed }),
    );
  }

  // The agent's own "I pushed": checked exactly like a push event, so it only
  // makes the verdict arrive sooner.
  async notePush(id: string, token: string, sha: string): Promise<PushRecord> {
    this.tx((e) => e.checkLease(id, token));
    return this.inspectPush(id, { sha, ref: 'refs/heads/main', before: null });
  }

  recordCheck(id: string, sha: string, check: CheckRun): PushRecord {
    return this.tx((e) => e.recordCheck(id, sha, check));
  }

  // ---- internals -----------------------------------------------------------

  // The token never outlives the lease: its lifetime is the lease's remaining
  // time in whole seconds, less one for the time minting takes (the host's
  // minimum is 60).
  private async grantGit(id: string, leaseToken: string, leaseEnds: number, repo: RepoRef): Promise<GitAccess> {
    const now = this.opts.now?.() ?? Date.now();
    const ttl = Math.max(60, Math.floor((leaseEnds - now) / 1000) - 1);
    const t = await this.host.mintToken(repo.name, 'write', ttl);
    let replaced: string | undefined;
    try {
      replaced = this.tx((e) => e.attachGit(id, leaseToken, { tokenId: t.id, expiresAt: t.expiresAt }));
    } catch (err) {
      await this.revokeQuietly(repo.name, t.id);
      throw err;
    }
    if (replaced) await this.revokeQuietly(repo.name, replaced);
    return { remote: repo.remote, token: t.secret, expiresAt: t.expiresAt };
  }

  private async handBack(id: string, leaseToken: string) {
    try {
      const repo = this.tx((e) => e.getClaim(id)).repo;
      const { revoke } = this.tx((e) => e.release(id, leaseToken));
      if (revoke && repo) await this.revokeQuietly(repo.name, revoke);
    } catch {
      // Already released or expired: nothing to hand back.
    }
  }

  // Revoking is hygiene, not safety: every token expires with its lease anyway.
  private async revokeQuietly(repo: string, tokenId: string) {
    try {
      await this.host.revokeToken(repo, tokenId);
    } catch {
      // ignored
    }
  }
}

function describe(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    const message = (err as { message?: unknown }).message;
    return [code, message].filter((x) => typeof x === 'string' && x).join(': ') || 'unknown error';
  }
  return String(err);
}
