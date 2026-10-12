// Shared pieces of the Superpose runner: the HTTP client, git helpers, the
// claim's state files inside a working copy, scope matching, and notices in
// plain English. Plain Node 22, no dependencies.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = resolve(RUNNER_DIR, '..');
export const CLI = join(RUNNER_DIR, 'superpose.mjs');
// How an agent runs the CLI, as written in CLAIM.md and in notices.
export const CMD = `node ${/\s/.test(CLI) ? JSON.stringify(CLI) : CLI}`;
export const DEFAULT_URL = 'https://superpose.kevinj507.workers.dev';
export const STATE_DIR = '.superpose';
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- configuration -----------------------------------------------------------

// Secrets come from the environment. `--env <file>` (or SUPERPOSE_ENV) loads a
// dotenv-style file first, the same as `node --env-file=<file>`.
export function loadEnv(file) {
  const path = file || process.env.SUPERPOSE_ENV;
  if (!path) return;
  if (!existsSync(path)) throw new UsageError(`env file not found: ${path}`);
  process.loadEnvFile(path);
}

export function serviceUrl(flag) {
  return (flag || process.env.SUPERPOSE_URL || DEFAULT_URL).replace(/\/+$/, '');
}

export function canvasUrl(url, graph) {
  return `${url}/g/${encodeURIComponent(graph)}`;
}

export class UsageError extends Error {}

// The environment an agent runs with: everything except the planner's and the
// platform's secrets. An agent holds its own lease and git token, nothing more.
export function agentEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_)/.test(k)) env[k] = v;
    else if (/^(SUPERPOSE_|CLOUDFLARE_|CF_|GRAPHTASK_|OPENREVIEW_)/.test(k)) continue;
    else if (/(TOKEN|SECRET|PASSWORD|_KEY)$/i.test(k)) continue;
    else env[k] = v;
  }
  return { ...env, ...extra };
}

// ---- the Superpose API ---------------------------------------------------------

// Every call returns { status, ok, data }; status 0 means the service could not
// be reached. Reads are retried; writes are not, because a retried write
// whose first attempt did land would be refused or doubled.
export class Api {
  constructor(url, graph) {
    this.url = url;
    this.graph = graph;
  }

  async request(method, path, { token, body, timeoutMs = 30_000, retries } = {}) {
    retries ??= method === 'GET' ? 3 : 0;
    const target = `${this.url}/api/graphs/${encodeURIComponent(this.graph)}${path}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(target, {
          method,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let data;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { error: 'bad_response', message: text.slice(0, 300) };
        }
        if (res.status >= 500 && attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        return { status: res.status, ok: res.ok, data };
      } catch (err) {
        if (attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        return { status: 0, ok: false, data: { error: 'network', message: String(err?.message ?? err) } };
      }
    }
  }

  snapshot() {
    return this.request('GET', '/snapshot');
  }
  ready() {
    return this.request('GET', '/ready');
  }
  impact(finding) {
    return this.request('GET', `/findings/${finding}/impact`);
  }
  addAssumption(admin, statement) {
    return this.request('POST', '/assumptions', { token: admin, body: { statement } });
  }
  addClaim(admin, claim) {
    return this.request('POST', '/claims', { token: admin, body: claim });
  }
  lineAccess(admin, line, scope, ttl) {
    return this.request('POST', `/lines/${line}/access`, { token: admin, body: { scope, ttl } });
  }
  verify(admin, finding) {
    return this.request('POST', `/findings/${finding}/verify`, { token: admin });
  }
  refute(admin, finding) {
    return this.request('POST', `/findings/${finding}/refute`, { token: admin });
  }
  claim(agentKey, id, agent) {
    return this.request('POST', `/claims/${id}/claim`, { token: agentKey, body: { agent }, timeoutMs: 90_000 });
  }
  renew(lease, id) {
    // Renewal only extends a lease, so a retry is safe.
    return this.request('POST', `/claims/${id}/renew`, { token: lease, retries: 2 });
  }
  notePush(lease, id, sha) {
    return this.request('POST', `/claims/${id}/push`, { token: lease, body: { sha }, timeoutMs: 60_000 });
  }
  declare(lease, id, input) {
    return this.request('POST', `/claims/${id}/assumptions`, { token: lease, body: input });
  }
  finding(lease, input) {
    return this.request('POST', '/findings', { token: lease, body: input });
  }
  replan(lease, id, change) {
    return this.request('POST', `/claims/${id}/replan`, { token: lease, body: change, timeoutMs: 60_000 });
  }
  finish(lease, id) {
    return this.request('POST', `/claims/${id}/finish`, { token: lease, timeoutMs: 60_000 });
  }
  release(lease, id) {
    return this.request('POST', `/claims/${id}/release`, { token: lease, timeoutMs: 60_000 });
  }
}

const HINTS = {
  network: 'Superpose could not be reached; try again in a few seconds.',
  bad_token: 'This lease is no longer valid: the claim was finished, handed back, or taken over.',
  expired: 'The lease on this claim has expired, so another agent may take it.',
  stale: 'The claim is stale: an assumption it rests on was contradicted. Re-plan it first.',
  contradicted: 'That assumption has been contradicted, so nothing can rest on it any more.',
  not_ready: 'The claim is not ready: someone else holds it, or what it depends on is not done.',
  repo_unavailable: 'The git host had a problem; try again in a few seconds.',
  unknown_commit: "The platform cannot find that commit in the claim's repository. Push it first.",
  unauthorized: 'The token was refused.',
};

// A one-line explanation of a failed call, for people and agents.
export function explainError(res) {
  const code = res.data?.error ?? `http_${res.status}`;
  const message = res.data?.message ?? '';
  return [HINTS[code], message && `(${code}: ${message})`].filter(Boolean).join(' ') || code;
}

// ---- git -------------------------------------------------------------------------

export function git(cwd, args, { env, input, check = true, timeoutMs = 120_000 } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: '0' },
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
  if (check && out.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${(out.stderr || out.stdout).trim().split('\n').slice(-3).join(' | ')}`);
  }
  return out;
}

// The same, without blocking the event loop (clones and pushes in the runner).
export function gitAsync(cwd, args, { env, check = true, timeoutMs = 180_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: '0' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = { code: code ?? -1, stdout, stderr };
      if (check && out.code !== 0) {
        reject(new Error(`git ${args[0]} failed: ${(stderr || stdout).trim().split('\n').slice(-3).join(' | ')}`));
      } else resolvePromise(out);
    });
  });
}

// Git configuration passed through the environment, so a token never appears
// on a command line or in a remote URL.
export function gitAuthEnv(token, base = process.env) {
  const n = Number(base.GIT_CONFIG_COUNT ?? 0) || 0;
  return {
    ...base,
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'http.extraHeader',
    [`GIT_CONFIG_VALUE_${n}`]: `Authorization: Bearer ${token}`,
  };
}

// A working copy keeps its git token in a file of its own inside .git,
// included from the repo's config and scoped to the claim's remote. Renewals
// replace the file atomically, so a push in flight never reads half a token.
const AUTH_FILE = 'superpose-auth.config';

export function installGitAuth(dir, remote, token) {
  writeGitAuth(dir, remote, token);
  const current = git(dir, ['config', '--get-all', 'include.path'], { check: false }).stdout.split('\n');
  if (!current.includes(AUTH_FILE)) git(dir, ['config', '--add', 'include.path', AUTH_FILE]);
}

export function writeGitAuth(dir, remote, token) {
  const quote = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const body =
    '# Written by the Superpose runner: this claim\'s git token, replaced at every lease renewal.\n' +
    `[http ${quote(remote)}]\n\textraHeader = ${quote(`Authorization: Bearer ${token}`)}\n`;
  atomicWrite(join(dir, '.git', AUTH_FILE), body, 0o600);
}

export function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : '-------';
}

// ---- files -------------------------------------------------------------------------

export function atomicWrite(file, text, mode = 0o644) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ---- a claim's state inside its working copy ----------------------------------------
//
//   .superpose/claim.json    service, graph, claim id, lease token, scope, base commit
//   .superpose/NOTICES.md    what the platform said at each renewal, newest first
//   .superpose/notices.json  the same, structured; the hooks use it to find unread ones
//   .superpose/STALE         present while the claim is stale (must re-plan)
//   .superpose/LOST          the lease is gone; stop working
//   .superpose/DONE          finished
//   .superpose/RELEASED      handed back

export const stateFile = (dir, name) => join(dir, STATE_DIR, name);

export function findClaimDir(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(stateFile(dir, 'claim.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function readClaim(dir) {
  const c = readJson(stateFile(dir, 'claim.json'), null);
  if (!c) throw new UsageError(`no claim found: ${stateFile(dir, 'claim.json')} is missing or unreadable`);
  return c;
}

export function updateClaim(dir, patch) {
  const next = { ...readClaim(dir), ...patch };
  atomicWrite(stateFile(dir, 'claim.json'), JSON.stringify(next, null, 2) + '\n', 0o600);
  return next;
}

export function writeClaim(dir, claim) {
  atomicWrite(stateFile(dir, 'claim.json'), JSON.stringify(claim, null, 2) + '\n', 0o600);
}

export function hasMarker(dir, name) {
  return existsSync(stateFile(dir, name));
}

export function readMarker(dir, name) {
  try {
    return readFileSync(stateFile(dir, name), 'utf8');
  } catch {
    return null;
  }
}

export function setMarker(dir, name, text = '') {
  atomicWrite(stateFile(dir, name), text.endsWith('\n') || !text ? text : text + '\n');
}

export function clearMarker(dir, name) {
  rmSync(stateFile(dir, name), { force: true });
}

export function readNotices(dir) {
  return readJson(stateFile(dir, 'notices.json'), []);
}

// Add notices (already described in plain English) and rewrite NOTICES.md.
export function recordNotices(dir, entries) {
  if (!entries.length) return;
  const all = [...readNotices(dir), ...entries];
  atomicWrite(stateFile(dir, 'notices.json'), JSON.stringify(all, null, 2) + '\n');
  const claim = readJson(stateFile(dir, 'claim.json'), {});
  const lines = [
    `# Notices for claim ${claim.claim ?? ''} (newest first)`,
    '',
    'What Superpose has told this claim: findings that affect it, pushes by others into its scope,',
    'check results. The runner adds to this file at every lease renewal.',
    '',
  ];
  [...all].reverse().forEach((n, i) => {
    lines.push(`## ${all.length - i}. ${n.title}  (${new Date(n.at).toISOString().slice(11, 19)} UTC)`, '', n.text, '');
  });
  atomicWrite(stateFile(dir, 'NOTICES.md'), lines.join('\n'));
}

// Notices not yet shown on one channel ('push' for the pre-push hook, 'agent'
// for the hook inside the agent's session). Marks them shown.
export function takeUnread(dir, channel) {
  const all = readNotices(dir);
  const seenFile = stateFile(dir, 'seen.json');
  const seen = readJson(seenFile, {});
  const from = seen[channel] ?? 0;
  if (from >= all.length) return [];
  atomicWrite(seenFile, JSON.stringify({ ...seen, [channel]: all.length }) + '\n');
  return all.slice(from);
}

// ---- scope ------------------------------------------------------------------------------

// The platform's scope rule, kept identical to src/core/scope.ts: `**` matches
// any number of path segments, `*` matches within one segment, anything else
// is literal.
function patternToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      const slashAfter = pattern[i + 2] === '/';
      re += slashAfter ? '(?:.*/)?' : '.*';
      i += slashAfter ? 2 : 1;
    } else if (ch === '*') {
      re += '[^/]*';
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function inScope(path, scope) {
  return scope.some((p) => patternToRegExp(p).test(path));
}

export function outOfScope(paths, scope) {
  return paths.filter((p) => !inScope(p, scope));
}

// Files a commit changes relative to the claim's base, the way the platform
// computes them (trees compared, renames as delete plus add).
export function changedSince(dir, base, sha) {
  let from = base;
  if (!from || git(dir, ['cat-file', '-e', `${from}^{commit}`], { check: false }).code !== 0) from = EMPTY_TREE;
  const out = git(dir, ['diff', '--name-only', '--no-renames', '-z', from, sha]).stdout;
  return out.split('\0').filter(Boolean).sort();
}

// ---- reading the graph --------------------------------------------------------------------

export function indexSnapshot(snap) {
  const nodes = new Map((snap?.nodes ?? []).map((n) => [n.id, n]));
  return { snap, nodes, edges: snap?.edges ?? [], pushes: snap?.pushes ?? [], events: snap?.events ?? [] };
}

// What one claim rests on and builds on, from the graph's edges.
export function claimContext(index, id) {
  const restsOn = [];
  const requires = [];
  for (const e of index.edges) {
    if (e.target !== id || e.purpose !== 'required for') continue;
    const src = index.nodes.get(e.source);
    if (src?.kind === 'assumption') restsOn.push(src);
    else if (src?.kind === 'claim') requires.push(src);
  }
  const pushes = index.pushes.filter((p) => p.claim === id).sort((a, b) => a.at - b.at);
  return { claim: index.nodes.get(id), restsOn, requires, pushes };
}

export function quoteStatement(node) {
  return node ? `“${node.statement}”` : '(unknown)';
}

// ---- notices in plain English ---------------------------------------------------------------

export function describeNotice(n, index, claimId) {
  const d = n.data ?? {};
  const node = (id) => index?.nodes.get(id);
  const assumptionList = (ids = []) =>
    ids.map((id) => `${id} ${quoteStatement(node(id))}`).join('; ') || '(unknown assumption)';
  const base = { seq: n.seq, type: n.type, at: Date.now(), data: d };
  switch (n.type) {
    case 'claim.stale':
      return {
        ...base,
        title: `STALE: an assumption under claim ${claimId} was shown to be false`,
        text:
          `Finding ${d.finding} was verified: “${d.statement ?? node(d.finding)?.statement ?? ''}”.\n` +
          `It contradicts ${assumptionList(d.assumptions)}, which this claim rests on (directly, or through a claim it builds on).\n` +
          'Your claim is now stale: pushes are refused and the lease is not renewed until you re-plan.\n' +
          'Do this now, before the lease runs out:\n' +
          '1. Decide how the work must change now that the assumption is false.\n' +
          `2. If the new approach relies on something new, declare it: \`${CMD} assume "<statement>"\` (prints its id).\n` +
          `3. Re-plan: \`${CMD} replan --rests-on <ids that still hold>\` (add \`--scope <patterns>\` if the scope must change).\n` +
          '4. Rework the code, commit, and push again.',
      };
    case 'claim.helped':
      return {
        ...base,
        title: `HELP: a verified finding helps claim ${claimId}`,
        text: `Finding ${d.finding} (filed by ${node(d.finding)?.finder ?? 'another claim'}) was verified for this claim: “${d.statement ?? ''}”. Use it if it makes your work easier.`,
      };
    case 'claim.replanned':
      return { ...base, title: `Re-planned: claim ${claimId} is at version ${d.version}`, text: 'The new plan is in force; pushes are accepted again.' };
    case 'scope.touched':
      return {
        ...base,
        title: `SCOPE TOUCHED: claim ${d.by} changed files in your scope`,
        text:
          `Claim ${d.by} pushed commit ${shortSha(d.sha)}, which changes files inside your scope that are outside its own: ${(d.paths ?? []).join(', ')}.\n` +
          'Your copy does not have their change. Keep your own edits to those files focused, so the two can be merged when the work lands.',
      };
    case 'claim.checked': {
      const failed = d.verdict === 'checks-failed' || d.verdict === 'verifier-failed' || d.verdict === 'scope-violation';
      return {
        ...base,
        title: `CHECKED: commit ${shortSha(d.sha)} → ${d.verdict}`,
        text:
          `The platform's checks finished on your commit ${shortSha(d.sha)}: ${d.verdict}${d.exitCode !== undefined ? ` (exit code ${d.exitCode})` : ''}.` +
          (failed ? '\nFix the problem, commit, and push again before you finish.' : ''),
      };
    }
    case 'finding.filed':
      return {
        ...base,
        title: `Your finding ${d.finding} is filed`,
        text: 'Nobody is stopped while it is unverified. A human or a checker will verify or refute it.',
      };
    case 'finding.verified':
      return {
        ...base,
        title: `Your finding ${d.finding} was verified`,
        text: 'The claims that rested on the contradicted assumption have been told to re-plan.',
      };
    case 'finding.refuted':
      return {
        ...base,
        title: `Your finding ${d.finding} was refuted`,
        text:
          'A checker decided the assumption holds after all. Work built on the finding is parked, and this claim is stale until you re-plan:\n' +
          `\`${CMD} replan --rests-on <assumption ids>\` (the original assumption may be among them again).`,
      };
    case 'finding.hedge_expired':
      return {
        ...base,
        title: `Your finding ${d.finding} is waiting for a decision`,
        text: 'It has been unverified for longer than the hedge window; a human has been asked to decide. Carry on meanwhile.',
      };
    case 'reality.at_risk':
      return {
        ...base,
        title: 'AT RISK: landed work rests on a contradicted assumption',
        text: `Finding ${d.finding} contradicts ${assumptionList(d.assumptions)}, which landed work rests on.`,
      };
    case 'claim.landed':
      return {
        ...base,
        title: `LANDED: claim ${claimId} is in the ${d.line ?? 'main'} line`,
        text: d.merge ? `It was merged as ${shortSha(d.merge)}, with the tests passing on the merged result.` : 'It was marked landed.',
      };
    case 'claim.landing_failed':
      return {
        ...base,
        title: `LANDING FAILED: claim ${claimId} (${d.status})`,
        text:
          d.status === 'conflict'
            ? `Merging it into the line conflicts in: ${(d.files ?? []).join(', ')}. A human decides what happens next; it may be reopened for an agent to bring up to date.`
            : d.status === 'failed'
              ? 'The tests failed on the merged result. A human decides what happens next.'
              : 'The landing could not run. A human decides what happens next.',
      };
    default:
      return { ...base, title: n.type, text: JSON.stringify(d) };
  }
}

// The claims a commit message names in its trailer, e.g. "Superpose-Claim: c12"
// (the platform's rule, from src/core/repos.ts).
export function trailerClaims(message) {
  const out = [];
  for (const m of message.matchAll(/^Superpose-Claim:[ \t]*(.+)$/gim)) out.push(...m[1].split(/[\s,]+/).filter(Boolean));
  return out;
}

// ---- CLAIM.md -----------------------------------------------------------------------------------

// The brief an agent works from: what to make true, where it may write, what
// the claim rests on, and the rules. Written by the runner when the claim is
// taken, and again by the CLI after a re-plan.
export function renderClaimMd(claim, index, dir) {
  const ctx = index ? claimContext(index, claim.claim) : { restsOn: [], requires: [] };
  const node = ctx.claim;
  const statement = node?.statement ?? claim.statement;
  const scope = node?.scope ?? claim.scope;
  const id = claim.claim;
  const lines = [];
  lines.push(`# Claim ${id}`, '');
  lines.push(`**Make this true:** ${statement}`, '');
  lines.push(
    'You are one of several agents working on this project at the same time. Superpose coordinates the work:',
    'each agent holds one claim, works in its own copy of the code, and pushes to its own repository.',
    `This directory is a clone of the repository for claim ${id}; nobody else pushes here.`,
    '',
  );
  if (claim.status === 'stale' || hasMarker(dir, 'STALE')) {
    lines.push(
      '> **This claim is STALE.** An assumption it rested on was shown to be false. Before any other work,',
      '> read `.superpose/NOTICES.md` and re-plan (see "If your claim goes stale" below).',
      '',
    );
  }
  lines.push('## Scope: the only files you may change', '');
  for (const p of scope) lines.push(`- \`${p}\``);
  lines.push(
    '',
    '`**` matches any number of folders and `*` matches within one name. The platform checks every push against',
    'this scope from the commit itself, and the pre-push hook refuses a push that changes anything else. If the claim',
    `truly cannot be done inside this scope, widen it with \`${CMD} replan --scope <patterns>\` rather than editing other files.`,
    '',
  );
  lines.push('## What this claim rests on', '');
  if (ctx.restsOn.length) {
    for (const a of ctx.restsOn) lines.push(`- \`${a.id}\` (${a.status}): ${a.statement}`);
  } else {
    lines.push('- (no assumptions declared)');
  }
  lines.push(
    '',
    'If you find that one of these is false, do not quietly work around it: file a finding (see Commands) with the',
    'evidence. Other claims rest on the same assumptions; if a checker verifies your finding, exactly those agents are',
    `told to re-plan. If your work relies on something that is not listed, declare it with \`${CMD} assume "<statement>"\`.`,
    '',
  );
  if (ctx.requires.length) {
    lines.push('## Builds on', '');
    for (const c of ctx.requires) {
      const where = c.status === 'landed' ? 'landed: its code is in this repository' : `${c.status}: its code may not be here yet`;
      lines.push(`- \`${c.id}\` (${where}): ${c.statement}`);
    }
    lines.push('', 'Use that work as it is; if it is missing or wrong, file a finding rather than changing its files.', '');
  }
  const others = index
    ? [...index.nodes.values()].filter((n) => n.kind === 'claim' && n.id !== id && ['claimed', 'stale', 'open'].includes(n.status))
    : [];
  if (others.length) {
    lines.push('## Other claims in this project (not yours: leave their files alone)', '');
    for (const c of others.slice(0, 12)) {
      const who = c.lease?.holder && c.status !== 'open' ? `, held by ${c.lease.holder}` : '';
      lines.push(`- \`${c.id}\` (${c.status}${who}): ${c.statement} Scope: ${c.scope.map((p) => `\`${p}\``).join(', ')}`);
    }
    if (others.length > 12) lines.push(`- ... and ${others.length - 12} more`);
    lines.push('');
  }
  lines.push(
    '## How to work',
    '',
    '1. Make the statement true, with tests. Run the tests before you finish (`npm test` if there is a package.json).',
    `2. Commit early and often. Every commit message ends with the trailer line \`Superpose-Claim: ${id}\` (a commit hook adds it if you forget).`,
    '3. Push to `origin main` often: `git push origin main`. Before each push, read `.superpose/NOTICES.md`; the pre-push hook also prints anything new.',
    '   The platform checks every pushed commit against the scope and runs the project\'s tests on it in a fresh container; the result comes back as a CHECKED notice.',
    '4. A refused push says why: the claim went stale, a file outside the scope changed, or (rarely) the access token was being renewed; then wait five seconds and push again.',
    `5. When the statement is true, the tests pass, and everything is committed and pushed, run \`${CMD} done\`. Then stop.`,
    `6. If you cannot finish, run \`${CMD} release "<why>"\` to hand the claim back. Then stop.`,
    '',
    '## Commands',
    '',
    'Run these from this directory:',
    '',
    `- \`${CMD} status\`: the claim, its assumptions, the platform's verdict on your last push, recent notices`,
    `- \`${CMD} assume "<statement>"\`: declare something your work relies on`,
    `- \`${CMD} finding --contradicts <assumption id> "<what is false, and the evidence>"\`: report a false assumption`,
    `- \`${CMD} finding --helps <claim id> "<what helps that claim>"\`: offer something useful to another claim`,
    `- \`${CMD} replan --rests-on <assumption ids> [--scope <patterns>]\`: re-plan a stale claim`,
    `- \`${CMD} done\`: push if needed, wait for the platform's verdict on that exact commit (scope, then tests), then finish the claim; if the tests fail it shows the output and does not finish`,
    `- \`${CMD} release "<why>"\`: give the claim back`,
    '',
    '## If your claim goes stale',
    '',
    'Someone showed that an assumption your claim rests on is false, and a checker agreed. A STALE notice appears in',
    '`.superpose/NOTICES.md` and after your next command. Pushes are refused and the lease stops renewing, so act within a few minutes:',
    '',
    '1. Read the notice: which assumption fell, and what was found.',
    `2. Decide how the work must change. If the new approach relies on something new, declare it: \`${CMD} assume "<statement>"\` (it prints an id).`,
    `3. Re-plan: \`${CMD} replan --rests-on <ids that still hold>\` (add \`--scope\` if the scope must change).`,
    '4. Rework the code to match the new plan, commit, push, and carry on.',
    '',
  );
  return lines.join('\n');
}

// A local notice the runner or the CLI adds itself (no sequence number).
export function localNotice(title, text, type = 'local') {
  return { seq: null, type, at: Date.now(), title, text, data: {} };
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '?';
  const neg = ms < 0;
  let s = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const t = h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
  return neg ? `-${t}` : t;
}
