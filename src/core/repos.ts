import type { RepoRef } from './types';

// What Superpose needs from a git host. Cloudflare Artifacts implements it in
// production (src/artifacts-host.ts); tests use FakeRepoHost, because the
// Artifacts binding is not emulated locally.
export interface RepoHost {
  // Make an empty repo, or return it if it already exists.
  ensure(name: string): Promise<HostRepo>;
  // Fork `source` as `name`, or return `name` if it already exists.
  fork(source: string, name: string): Promise<HostRepo>;
  mintToken(repo: string, scope: 'read' | 'write', ttlSeconds: number): Promise<HostToken>;
  revokeToken(repo: string, tokenId: string): Promise<void>;
  readCommit(repo: string, sha: string): Promise<HostCommit | null>;
  readTree(repo: string, tree: string): Promise<HostTreeEntry[] | null>;
  // Tip of the default branch, or null for an empty repo.
  readHead(repo: string): Promise<string | null>;
}

export interface HostRepo extends RepoRef {
  head?: string; // tip of the default branch; absent for an empty repo
}

export interface HostToken {
  id: string;
  secret: string; // what git sends as the bearer token
  expiresAt: number;
}

export interface HostCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
}

export interface HostTreeEntry {
  name: string;
  type: 'tree' | 'blob';
  hash: string;
}

// What an agent gets to work in its claim's repo.
export interface GitAccess {
  remote: string;
  token: string;
  expiresAt: number;
}

// Repo names carry the graph and what the repo is for, so a push event (which
// names only the repo) can be routed back to its graph and claim.
//   <graph>.line.<line>    one line: the code of one reality
//   <graph>.claim.<claim>  one claim's fork of its line
const NAME = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.(line|claim)\.([A-Za-z0-9_-]+)$/;

export function lineRepoName(graph: string, line: string): string {
  return `${graph}.line.${line}`;
}

export function claimRepoName(graph: string, claim: string): string {
  return `${graph}.claim.${claim}`;
}

export function parseRepoName(name: string): { graph: string; kind: 'line' | 'claim'; id: string } | null {
  const m = NAME.exec(name);
  return m ? { graph: m[1]!, kind: m[2] as 'line' | 'claim', id: m[3]! } : null;
}

const NO_COMMIT = /^0{40}$/;

// The claims a commit names in its trailer, e.g. "Superpose-Claim: c12".
export function trailerClaims(message: string): string[] {
  const out: string[] = [];
  for (const m of message.matchAll(/^Superpose-Claim:[ \t]*(.+)$/gim)) {
    out.push(...m[1]!.split(/[\s,]+/).filter(Boolean));
  }
  return out;
}

export class UnknownCommitError extends Error {
  code = 'unknown_commit';
}

// The paths that differ between two commits. A push event carries no file
// list, so the scope check compares trees, descending only into directories
// whose hashes differ. A missing `before` (a new branch) compares against an
// empty tree.
export async function changedPaths(host: RepoHost, repo: string, before: string | null, after: string): Promise<string[]> {
  const treeOf = async (sha: string | null) => {
    if (!sha || NO_COMMIT.test(sha)) return null;
    const commit = await host.readCommit(repo, sha);
    if (!commit) throw new UnknownCommitError(`commit ${sha} not found in ${repo}`);
    return commit.tree;
  };
  const [a, b] = await Promise.all([treeOf(before), treeOf(after)]);
  const out: string[] = [];
  await diffTrees(host, repo, a, b, '', out);
  return out.sort();
}

async function diffTrees(
  host: RepoHost,
  repo: string,
  a: string | null,
  b: string | null,
  prefix: string,
  out: string[],
): Promise<void> {
  if (a === b) return;
  const [left, right] = await Promise.all([entries(host, repo, a), entries(host, repo, b)]);
  const names = new Set([...left.keys(), ...right.keys()]);
  const pending: Promise<void>[] = [];
  for (const name of names) {
    const x = left.get(name);
    const y = right.get(name);
    if (x && y && x.hash === y.hash && x.type === y.type) continue;
    const path = prefix + name;
    const xTree = x?.type === 'tree' ? x.hash : null;
    const yTree = y?.type === 'tree' ? y.hash : null;
    if (xTree || yTree) pending.push(diffTrees(host, repo, xTree, yTree, `${path}/`, out));
    if ((x && x.type !== 'tree') || (y && y.type !== 'tree')) out.push(path);
  }
  await Promise.all(pending);
}

async function entries(host: RepoHost, repo: string, tree: string | null): Promise<Map<string, HostTreeEntry>> {
  if (!tree) return new Map();
  const list = await host.readTree(repo, tree);
  if (!list) throw new Error(`tree ${tree} not found in ${repo}`);
  return new Map(list.map((e) => [e.name, e]));
}
