import type { HostCommit, HostRepo, HostToken, HostTreeEntry, RepoHost } from './core/repos';

// The git host in production: Cloudflare Artifacts, through the Workers
// binding. Repo handles are disposable capabilities, released after each call.
export class ArtifactsHost implements RepoHost {
  constructor(private artifacts: Artifacts) {}

  async ensure(name: string): Promise<HostRepo> {
    try {
      const created = await this.artifacts.create(name, { setDefaultBranch: 'main' });
      await this.revokeInitial(name, created.token);
      return { name: created.name, remote: created.remote };
    } catch (err) {
      if (codeOf(err) !== 'ALREADY_EXISTS') throw err;
      return this.describe(name);
    }
  }

  async fork(source: string, name: string): Promise<HostRepo> {
    try {
      const forked = await this.withRepo(source, (repo) => repo.fork(name, { defaultBranchOnly: true }));
      await this.revokeInitial(name, forked.token);
      return { name: forked.name, remote: forked.remote, head: await this.head(name) };
    } catch (err) {
      if (codeOf(err) !== 'ALREADY_EXISTS') throw err;
      return this.describe(name);
    }
  }

  async mintToken(repo: string, scope: 'read' | 'write', ttlSeconds: number): Promise<HostToken> {
    const t = await this.withRepo(repo, (r) => r.createToken(scope, ttlSeconds));
    // The plaintext carries an "?expires=" suffix; git sends only the secret.
    return { id: t.id, secret: t.plaintext.split('?expires=')[0]!, expiresAt: Date.parse(t.expiresAt) };
  }

  async revokeToken(repo: string, tokenId: string): Promise<void> {
    await this.withRepo(repo, (r) => r.revokeToken(tokenId));
  }

  async readCommit(repo: string, sha: string): Promise<HostCommit | null> {
    const c = await this.withRepo(repo, (r) => r.readCommit(sha));
    return c ? { sha: c.hash, tree: c.treeHash, parents: c.parents, message: c.message } : null;
  }

  async readTree(repo: string, tree: string): Promise<HostTreeEntry[] | null> {
    const entries = await this.withRepo(repo, (r) => r.readTree(tree));
    if (!entries) return null;
    // Submodules (gitlink) and symlinks are leaves, like files.
    return entries.map((e) => ({ name: e.name, type: e.type === 'tree' ? 'tree' : 'blob', hash: e.hash }));
  }

  async readFile(repo: string, ref: string, path: string): Promise<string | null> {
    const blob = await this.withRepo(repo, (r) => r.readFile({ ref, path }));
    return blob ? blob.text() : null;
  }

  async readHead(repo: string): Promise<string | null> {
    return (await this.head(repo)) ?? null;
  }

  // ---- internals -------------------------------------------------------------

  // create() and fork() each hand back a write token valid for 24 hours. Write
  // access must come only from a lease, so it is revoked at once (checked on
  // the account 2026-10-12: revocation takes effect immediately).
  private async revokeInitial(name: string, token: string) {
    await this.withRepo(name, (r) => r.revokeToken(token));
  }

  private async describe(name: string): Promise<HostRepo> {
    const info = await this.withRepo(name, (r) => r.info());
    return { name: info.name, remote: info.remote, head: await this.head(name) };
  }

  private async head(name: string): Promise<string | undefined> {
    const log = await this.withRepo(name, (r) => r.log({ limit: 1 }));
    return log[0]?.hash;
  }

  // A repo that is still being created or forked is not ready to open; wait
  // briefly and try again.
  private async withRepo<T>(name: string, fn: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let repo: ArtifactsRepo;
      try {
        repo = await this.artifacts.get(name);
      } catch (err) {
        if (attempt < 8 && NOT_READY.has(codeOf(err) ?? '')) {
          await sleep(250 * 2 ** Math.min(attempt, 3));
          continue;
        }
        throw err;
      }
      try {
        return await fn(repo);
      } finally {
        repo[Symbol.dispose]();
      }
    }
  }
}

const NOT_READY = new Set(['CREATE_IN_PROGRESS', 'FORK_IN_PROGRESS', 'IMPORT_IN_PROGRESS']);

function codeOf(err: unknown): string | undefined {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
