import type { HostCommit, HostRepo, HostToken, HostTreeEntry, RepoHost } from './repos';

// A git host in memory, for tests and local development, standing in for
// Cloudflare Artifacts. It keeps real content-addressed commits and trees, so
// the push check's tree comparison runs against it unchanged, and it enforces
// tokens the way the real host does: `canPush` is what a git push would get.

export interface KeyValue {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
}

export class MapKeyValue implements KeyValue {
  private map = new Map<string, unknown>();
  get<T>(key: string) {
    const v = this.map.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  put<T>(key: string, value: T) {
    this.map.set(key, structuredClone(value));
  }
}

interface StoredRepo {
  name: string;
  head?: string;
  source?: string;
}

interface StoredToken {
  id: string;
  repo: string;
  scope: 'read' | 'write';
  secret: string;
  expiresAt: number;
  revoked: boolean;
}

export class FakeRepoHost implements RepoHost {
  // Calls the host has served, so tests can see what was asked of it.
  calls: string[] = [];
  // Set to make the next calls of a kind fail, e.g. { fork: 'UPSTREAM_UNAVAILABLE' }.
  failNext: Partial<Record<'ensure' | 'fork' | 'mintToken', string>> = {};

  constructor(
    private kv: KeyValue = new MapKeyValue(),
    private clock: { now(): number } = { now: () => Date.now() },
  ) {}

  async ensure(name: string): Promise<HostRepo> {
    this.calls.push(`ensure ${name}`);
    this.maybeFail('ensure');
    const existing = this.repo(name);
    if (existing) return this.describe(existing);
    const repo: StoredRepo = { name };
    this.kv.put(`repo:${name}`, repo);
    return this.describe(repo);
  }

  async fork(source: string, name: string): Promise<HostRepo> {
    this.calls.push(`fork ${source} ${name}`);
    this.maybeFail('fork');
    const existing = this.repo(name);
    if (existing) return this.describe(existing);
    const src = this.repo(source);
    if (!src) throw hostError('NOT_FOUND', `no repo ${source}`);
    const repo: StoredRepo = { name, head: src.head, source };
    this.kv.put(`repo:${name}`, repo);
    return this.describe(repo);
  }

  async mintToken(repo: string, scope: 'read' | 'write', ttlSeconds: number): Promise<HostToken> {
    this.calls.push(`mintToken ${repo} ${scope} ${ttlSeconds}`);
    this.maybeFail('mintToken');
    if (!this.repo(repo)) throw hostError('NOT_FOUND', `no repo ${repo}`);
    if (ttlSeconds < 60) throw hostError('INVALID_TTL', 'ttl below 60 seconds');
    const n = (this.kv.get<number>('tokens:n') ?? 0) + 1;
    this.kv.put('tokens:n', n);
    const token: StoredToken = {
      id: `tok-${n}`,
      repo,
      scope,
      secret: `secret-${n}`,
      expiresAt: this.clock.now() + ttlSeconds * 1000,
      revoked: false,
    };
    this.kv.put(`token:${token.id}`, token);
    this.kv.put(`secret:${token.secret}`, token.id);
    return { id: token.id, secret: token.secret, expiresAt: token.expiresAt };
  }

  async revokeToken(repo: string, tokenId: string): Promise<void> {
    this.calls.push(`revokeToken ${repo} ${tokenId}`);
    const token = this.kv.get<StoredToken>(`token:${tokenId}`);
    if (token && token.repo === repo) this.kv.put(`token:${tokenId}`, { ...token, revoked: true });
  }

  async readCommit(repo: string, sha: string): Promise<HostCommit | null> {
    if (!this.repo(repo)) throw hostError('NOT_FOUND', `no repo ${repo}`);
    return this.kv.get<HostCommit>(`commit:${sha}`) ?? null;
  }

  async readTree(repo: string, tree: string): Promise<HostTreeEntry[] | null> {
    if (!this.repo(repo)) throw hostError('NOT_FOUND', `no repo ${repo}`);
    return this.kv.get<HostTreeEntry[]>(`tree:${tree}`) ?? null;
  }

  async readFile(repo: string, ref: string, path: string): Promise<string | null> {
    if (!this.repo(repo)) throw hostError('NOT_FOUND', `no repo ${repo}`);
    return this.files(ref).get(path) ?? null;
  }

  async readHead(repo: string): Promise<string | null> {
    const r = this.repo(repo);
    if (!r) throw hostError('NOT_FOUND', `no repo ${repo}`);
    return r.head ?? null;
  }

  // ---- what a git client would do ------------------------------------------

  // Would a push with this token be accepted?
  canPush(repo: string, secret: string): boolean {
    const id = this.kv.get<string>(`secret:${secret}`);
    const token = id ? this.kv.get<StoredToken>(`token:${id}`) : undefined;
    return !!token && token.repo === repo && token.scope === 'write' && !token.revoked && token.expiresAt > this.clock.now();
  }

  // Commit file changes on top of the repo's head (null deletes a file) and
  // move the head. Returns { before, after } as a push event would carry them.
  commit(repo: string, changes: Record<string, string | null>, message = 'change'): { before: string | null; after: string; message: string } {
    const r = this.repo(repo);
    if (!r) throw hostError('NOT_FOUND', `no repo ${repo}`);
    const files = r.head ? this.files(r.head) : new Map<string, string>();
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) files.delete(path);
      else files.set(path, content);
    }
    const tree = this.writeTree(files);
    const parents = r.head ? [r.head] : [];
    const sha = hash(`commit ${tree} ${parents.join(' ')} ${message} ${this.clock.now()}`);
    this.kv.put(`commit:${sha}`, { sha, tree, parents, message } satisfies HostCommit);
    this.kv.put(`repo:${repo}`, { ...r, head: sha });
    return { before: r.head ?? null, after: sha, message };
  }

  // Merge `sha` (from any repo: objects are shared here) into `into`'s head,
  // as a merge commit. A file changed differently on both sides since their
  // common ancestor is a conflict, and nothing is written.
  merge(into: string, sha: string, message: string): { merge: string } | { conflict: string[] } {
    const r = this.repo(into);
    if (!r) throw hostError('NOT_FOUND', `no repo ${into}`);
    const ours = r.head;
    const baseSha = ours ? this.commonAncestor(ours, sha) : undefined;
    const base = baseSha ? this.files(baseSha) : new Map<string, string>();
    const mine = ours ? this.files(ours) : new Map<string, string>();
    const theirs = this.files(sha);
    const out = new Map(mine);
    const conflict: string[] = [];
    for (const path of new Set([...base.keys(), ...mine.keys(), ...theirs.keys()])) {
      const b = base.get(path);
      const m = mine.get(path);
      const t = theirs.get(path);
      if (t === b || t === m) continue; // they did not change it, or made the same change
      if (m === b) {
        if (t === undefined) out.delete(path);
        else out.set(path, t);
      } else conflict.push(path);
    }
    if (conflict.length) return { conflict: conflict.sort() };
    const tree = this.writeTree(out);
    const parents = ours ? [ours, sha] : [sha];
    const merge = hash(`commit ${tree} ${parents.join(' ')} ${message} ${this.clock.now()}`);
    this.kv.put(`commit:${merge}`, { sha: merge, tree, parents, message } satisfies HostCommit);
    this.kv.put(`repo:${into}`, { ...r, head: merge });
    return { merge };
  }

  head(repo: string): string | undefined {
    return this.repo(repo)?.head;
  }

  // Every file at a commit, path -> content.
  files(sha: string): Map<string, string> {
    const commit = this.kv.get<HostCommit>(`commit:${sha}`);
    const out = new Map<string, string>();
    if (commit) this.collect(commit.tree, '', out);
    return out;
  }

  tokens(repo: string): StoredToken[] {
    const n = this.kv.get<number>('tokens:n') ?? 0;
    const out: StoredToken[] = [];
    for (let i = 1; i <= n; i++) {
      const t = this.kv.get<StoredToken>(`token:tok-${i}`);
      if (t && t.repo === repo) out.push(t);
    }
    return out;
  }

  exists(repo: string): boolean {
    return !!this.repo(repo);
  }

  // ---- internals -------------------------------------------------------------

  private commonAncestor(a: string, b: string): string | undefined {
    const seen = new Set<string>();
    const walk = [a];
    while (walk.length) {
      const sha = walk.pop()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      walk.push(...(this.kv.get<HostCommit>(`commit:${sha}`)?.parents ?? []));
    }
    const queue = [b];
    const visited = new Set<string>();
    while (queue.length) {
      const sha = queue.shift()!;
      if (seen.has(sha)) return sha;
      if (visited.has(sha)) continue;
      visited.add(sha);
      queue.push(...(this.kv.get<HostCommit>(`commit:${sha}`)?.parents ?? []));
    }
    return undefined;
  }

  private repo(name: string): StoredRepo | undefined {
    return this.kv.get<StoredRepo>(`repo:${name}`);
  }

  private describe(r: StoredRepo): HostRepo {
    return { name: r.name, remote: `https://fake.artifacts.test/superpose/${r.name}.git`, head: r.head };
  }

  private maybeFail(kind: keyof FakeRepoHost['failNext']) {
    const code = this.failNext[kind];
    if (code) {
      delete this.failNext[kind];
      throw hostError(code, `${kind} failed (${code})`);
    }
  }

  private writeTree(files: Map<string, string>): string {
    const here: HostTreeEntry[] = [];
    const dirs = new Map<string, Map<string, string>>();
    for (const [path, content] of files) {
      const slash = path.indexOf('/');
      if (slash === -1) {
        const blob = hash(`blob ${content}`);
        this.kv.put(`blob:${blob}`, content);
        here.push({ name: path, type: 'blob', hash: blob });
      } else {
        const dir = path.slice(0, slash);
        if (!dirs.has(dir)) dirs.set(dir, new Map());
        dirs.get(dir)!.set(path.slice(slash + 1), content);
      }
    }
    for (const [dir, inner] of dirs) here.push({ name: dir, type: 'tree', hash: this.writeTree(inner) });
    here.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const tree = hash(`tree ${here.map((e) => `${e.type} ${e.name} ${e.hash}`).join('\n')}`);
    this.kv.put(`tree:${tree}`, here);
    return tree;
  }

  private collect(tree: string, prefix: string, out: Map<string, string>) {
    for (const e of this.kv.get<HostTreeEntry[]>(`tree:${tree}`) ?? []) {
      if (e.type === 'tree') this.collect(e.hash, `${prefix}${e.name}/`, out);
      else out.set(`${prefix}${e.name}`, this.kv.get<string>(`blob:${e.hash}`) ?? '');
    }
  }
}

export class HostError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function hostError(code: string, message: string) {
  return new HostError(code, message);
}

// A 40-hex content hash (FNV-1a in five lanes). Not SHA-1, but stable and
// collision-free enough for tests.
function hash(text: string): string {
  let out = '';
  for (let lane = 0; lane < 5; lane++) {
    let h = 0x811c9dc5 ^ lane;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}
