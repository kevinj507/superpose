#!/usr/bin/env node
// The Superpose runner: one command starts N agents on a project graph.
//
//   node runner/run.mjs --graph <gid> --agents 3 [--agent claude|scripted] [--model <m>] [--max-turns <n>]
//
// Each agent slot loops: take a ready claim (atomically: if another agent
// wins it, try the next), clone the claim's own repository into
// work/<gid>/<claim> with the git token in repo-local config, write CLAIM.md,
// the claim file and the git hooks, and start the agent there. While the
// agent works, the runner renews the lease (which renews the git token and
// brings notices: stale, scope touched, checked, helped) and writes what it
// hears into .superpose/NOTICES.md. When the agent exits, the runner makes
// sure the work is pushed, then finishes the claim, or hands it back if the
// agent gave up. Ctrl-C ends the agents and hands back their claims.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  Api,
  CLI,
  CMD,
  REPO_DIR,
  RUNNER_DIR,
  STANDING_NOTICES,
  UsageError,
  adviceFor,
  advanceSeenSeq,
  agentEnv,
  atomicWrite,
  canvasUrl,
  servedUrl,
  clearMarker,
  describeNotice,
  explainError,
  latestSeq,
  noticesAbout,
  readSeenSeq,
  formatDuration,
  git,
  gitAsync,
  gitAuthEnv,
  hasMarker,
  inScope,
  indexSnapshot,
  installGitAuth,
  loadEnv,
  localNotice,
  readJson,
  recordNotices,
  renderClaimMd,
  serviceUrl,
  setMarker,
  shortSha,
  sleep,
  stateFile,
  updateClaim,
  writeClaim,
  writeGitAuth,
} from './lib.mjs';

const USAGE = `Usage: node runner/run.mjs --graph <gid> [options]

  --graph <gid>          the project graph to work on (required)
  --agents <n>           how many agents to run at once (default 1)
  --agent <kind>         claude (default): Claude Code, \`claude -p\`, logged in on this machine
                         scripted: a deterministic stand-in that edits, commits, pushes, finishes
  --model <m>            Claude model, e.g. haiku, sonnet, opus (default: Claude Code's own)
  --max-turns <n>        stop a Claude agent after this many turns
  --effort <level>       Claude effort: low, medium, high, xhigh, max
  --budget <usd>         stop a Claude agent after it spends this much on one claim
  --only <ids>           take only these claims (comma-separated)
  --once                 each agent takes one claim, then stops
  --hold <seconds>       scripted agents hold each claim this long before finishing
  --skip-stale           do not take over stale claims nobody holds (by default an agent
                         takes one when nothing is ready, and re-plans it first)
  --max-attempts <n>     take the same claim at most this many times in one run (default 2)
  --renew-every <s>      renew leases this often (default: a third of the lease, at most 60 s)
  --poll-every <s>       read the graph this often for notices to the claims held, so an agent
                         hears within seconds rather than at the next renewal (default 10)
  --patience <s>         stop waiting for claims to become ready after this long without
                         any change in the graph (default 600)
  --name <prefix>        agent names are <prefix>-1, <prefix>-2, ... (default: the agent kind)
  --url <url>            the Superpose service (default: $SUPERPOSE_URL or the hosted one)
  --env <file>           load secrets from a dotenv file first
  --work <dir>           where working copies go (default: work/)
  --runs <dir>           where transcripts and logs go (default: runs/)
  --quiet                log lines only, no live status block

Needs SUPERPOSE_AGENT_KEY in the environment (or in --env).`;

const OPTIONS = {
  graph: { type: 'string' },
  agents: { type: 'string', default: '1' },
  agent: { type: 'string', default: 'claude' },
  model: { type: 'string' },
  'max-turns': { type: 'string' },
  effort: { type: 'string' },
  budget: { type: 'string' },
  only: { type: 'string' },
  once: { type: 'boolean' },
  hold: { type: 'string' },
  'skip-stale': { type: 'boolean' },
  'max-attempts': { type: 'string', default: '2' },
  'renew-every': { type: 'string' },
  'poll-every': { type: 'string', default: '10' },
  patience: { type: 'string', default: '600' },
  name: { type: 'string' },
  url: { type: 'string' },
  env: { type: 'string' },
  work: { type: 'string' },
  runs: { type: 'string' },
  quiet: { type: 'boolean' },
  claude: { type: 'string', default: 'claude' },
  help: { type: 'boolean', short: 'h' },
};

// Claude Code tools an agent working one claim has no use for, and some that
// would take it out of its working copy or keep it running.
const DISALLOWED_TOOLS = [
  'EnterWorktree',
  'ExitWorktree',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'Workflow',
  'SendMessage',
  'DesignSync',
];

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const clock = () => new Date().toISOString().slice(11, 19);

// ---- the live status display ---------------------------------------------------------------

class Display {
  constructor({ tty, logFile }) {
    this.tty = tty;
    this.logFile = logFile;
    this.rows = new Map();
    this.drawn = 0;
    this.header = '';
    if (tty) this.timer = setInterval(() => this.draw(), 1000);
  }

  setHeader(text) {
    this.header = text;
  }

  update(name, fields) {
    const row = { ...(this.rows.get(name) ?? {}), ...fields };
    this.rows.set(name, row);
    if (this.tty) this.draw();
  }

  log(name, text) {
    const line = `[${clock()}] ${name ? `${name}: ` : ''}${text}`;
    if (this.logFile) appendFileSync(this.logFile, line + '\n');
    if (this.tty) {
      this.clear();
      process.stdout.write(line + '\n');
      this.draw();
    } else {
      process.stdout.write(line + '\n');
    }
  }

  clear() {
    if (!this.drawn) return;
    process.stdout.write(`\x1b[${this.drawn}A`);
    for (let i = 0; i < this.drawn; i++) process.stdout.write('\x1b[2K\n');
    process.stdout.write(`\x1b[${this.drawn}A`);
    this.drawn = 0;
  }

  draw() {
    if (!this.tty) return;
    const width = Math.max(40, (process.stdout.columns || 100) - 1);
    const lines = [this.header, ...[...this.rows.entries()].map(([name, r]) => statusLine(name, r))].map((l) =>
      l.length > width ? l.slice(0, width - 1) + '…' : l,
    );
    this.clear();
    process.stdout.write(lines.join('\n') + '\n');
    this.drawn = lines.length;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.tty) this.draw();
  }
}

function statusLine(name, r) {
  const parts = [name.padEnd(12), (r.claim ?? '-').padEnd(5), (r.state ?? '').padEnd(11)];
  if (r.since) parts.push(formatDuration(Date.now() - r.since).padStart(6));
  if (r.claim && r.state !== 'waiting') {
    if (r.pushes !== undefined) parts.push(`pushes ${r.pushes}`);
    if (r.verdict) parts.push(`verdict ${r.verdict}`);
    if (r.turns) parts.push(`turn ${r.turns}`);
    if (r.cost) parts.push(`$${r.cost.toFixed(3)}`);
  }
  if (r.last) parts.push(`· ${r.last}`);
  return parts.join('  ');
}

// ---- the runner -----------------------------------------------------------------------------------

class Runner {
  constructor(api, opts) {
    this.api = api;
    this.opts = opts;
    this.inFlight = new Set();
    this.results = [];
    this.stopping = false;
    this.cache = null;
    this.cacheAt = 0;
    this.pending = null;
    this.wakers = new Set();
    // How many times this run has taken each claim: one that keeps coming
    // back (its agents give up, or cannot re-plan it) is left for a human.
    this.attempts = new Map();
  }

  mayTake(id) {
    if (this.opts.only && !this.opts.only.has(id)) return false;
    return (this.attempts.get(id) ?? 0) < this.opts.maxAttempts;
  }

  // The graph, shared by every slot, at most a few seconds old.
  async snapshot({ maxAgeMs = 3000 } = {}) {
    if (this.cache && Date.now() - this.cacheAt < maxAgeMs) return this.cache;
    this.pending ??= this.api.snapshot().then((res) => {
      this.pending = null;
      if (res.ok) {
        this.cache = indexSnapshot(res.data);
        this.cacheAt = Date.now();
      }
      return this.cache;
    });
    return this.pending;
  }

  // The scheduler sees the project; each agent receives its authorized context.
  async claimSnapshot(lease) {
    const res = await this.api.request('GET', '/snapshot', { token: lease });
    return res.ok ? indexSnapshot(res.data) : null;
  }

  async sleep(ms) {
    if (this.stopping) return;
    await new Promise((resolveSleep) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolveSleep();
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }

  wakeAll() {
    for (const w of this.wakers) w();
    this.wakers.clear();
  }

  async start() {
    const { opts } = this;
    mkdirSync(opts.runsDir, { recursive: true });
    this.display = new Display({ tty: process.stdout.isTTY && !opts.quiet, logFile: join(opts.runsDir, 'runner.log') });
    this.display.setHeader(
      `Superpose · graph ${opts.graph} · ${opts.agents} ${opts.agent} agent${opts.agents === 1 ? '' : 's'} · ${canvasUrl(opts.url, opts.graph)}`,
    );
    this.display.log(null, `Starting ${opts.agents} ${opts.agent} agent(s) on graph ${opts.graph} (${opts.url})`);
    process.on('SIGINT', () => this.interrupt());
    process.on('SIGTERM', () => this.interrupt());
    this.slots = Array.from({ length: opts.agents }, (_, i) => new Slot(this, i + 1));
    const statusTimer = setInterval(() => this.refreshStatus().catch(() => {}), 5000);
    await Promise.all(this.slots.map((s) => s.loop()));
    clearInterval(statusTimer);
    this.display.stop();
    this.summarise();
  }

  // Pushes and verdicts come from the platform's ledger, not from the agents.
  async refreshStatus() {
    const index = await this.snapshot();
    if (!index) return;
    for (const slot of this.slots) {
      if (!slot.claimId) continue;
      const rows = index.pushes.filter((p) => p.claim === slot.claimId).sort((a, b) => a.at - b.at);
      const node = index.nodes.get(slot.claimId);
      const head = node?.headSha ? rows.find((p) => p.sha === node.headSha) : rows.at(-1);
      slot.set({ pushes: rows.length, verdict: head?.verdict });
    }
  }

  interrupt() {
    if (this.stopping) {
      process.stdout.write('\nStopping now, without waiting.\n');
      for (const slot of this.slots ?? []) slot.kill('SIGKILL');
      process.exit(130);
    }
    this.stopping = true;
    this.display?.log(null, 'Stopping: ending the agents and handing back their claims (Ctrl-C again to quit at once)');
    for (const slot of this.slots ?? []) slot.kill('SIGTERM');
    this.wakeAll();
  }

  summarise() {
    const rows = this.results;
    const lines = ['', `Summary for graph ${this.opts.graph}:`];
    if (!rows.length) lines.push('  No claims were worked on.');
    for (const r of rows) {
      lines.push(
        `  ${r.agent.padEnd(12)} ${r.claim.padEnd(5)} ${r.result.padEnd(9)} ${formatDuration(r.ms).padStart(6)}  ` +
          `pushes ${r.pushes ?? 0}  verdict ${r.verdict ?? '-'}` +
          (r.turns ? `  turns ${r.turns}` : '') +
          (r.cost ? `  $${r.cost.toFixed(3)}` : '') +
          (r.transcript ? `  ${relative(process.cwd(), r.transcript)}` : ''),
      );
    }
    lines.push(`  Canvas: ${canvasUrl(this.opts.url, this.opts.graph)}`, `  Served: ${servedUrl(this.opts.url, this.opts.graph)}`);
    process.stdout.write(lines.join('\n') + '\n');
    writeFileSync(join(this.opts.runsDir, 'summary.json'), JSON.stringify({ graph: this.opts.graph, results: rows }, null, 2) + '\n');
  }
}

// ---- one agent slot ---------------------------------------------------------------------------------

class Slot {
  constructor(runner, n) {
    this.runner = runner;
    this.opts = runner.opts;
    this.api = runner.api;
    this.n = n;
    this.name = `${this.opts.name}-${n}`;
    this.child = null;
    this.claimId = null;
    this.set({ state: 'starting' });
  }

  set(fields) {
    this.runner.display.update(this.name, fields);
  }

  log(text) {
    this.runner.display.log(this.name, text);
  }

  async loop() {
    while (!this.runner.stopping) {
      this.set({ claim: null, state: 'looking', since: undefined, last: '', pushes: undefined, verdict: undefined, turns: 0, cost: 0 });
      const grant = await this.take();
      if (grant === 'finished') break;
      if (!grant) {
        this.set({ state: 'waiting', last: 'no claim is ready yet' });
        await this.runner.sleep(5000);
        continue;
      }
      try {
        await this.work(grant);
      } catch (err) {
        this.log(`error on ${grant.id}: ${err?.message ?? err}`);
        await this.handBack(grant, 'the runner hit an error');
      } finally {
        this.runner.inFlight.delete(grant.id);
        this.claimId = null;
      }
      if (this.opts.once) break;
    }
    this.set({ claim: null, state: 'stopped', since: undefined, last: '' });
  }

  // Take a ready claim. Several agents may race for one; exactly one wins and
  // the others move on to the next.
  async take() {
    const ready = await this.api.ready();
    if (!ready.ok) {
      this.log(`could not read the ready claims: ${explainError(ready)}`);
      return null;
    }
    const wanted = (c) =>
      !this.runner.inFlight.has(c.id) && this.runner.mayTake(c.id) && !(this.opts.skipStale && c.status === 'stale');
    // Open claims first; then claims whose agent stopped renewing, which the
    // ready list also offers (the work so far is in their repo).
    const fresh = ready.data.filter((c) => wanted(c) && c.status === 'open');
    const lapsed = ready.data.filter((c) => wanted(c) && c.status !== 'open');
    // Agents start at different places in the list, so they rarely collide.
    const k = fresh.length ? (this.n - 1) % fresh.length : 0;
    const candidates = [...fresh.slice(k), ...fresh.slice(0, k), ...lapsed];
    // Claims that went stale with nobody holding them (a verified finding
    // reached them while they waited, or after they were finished): whoever
    // takes one re-plans it before working on it. Older deployments leave
    // them out of the ready list, so look in the graph as well.
    if (!this.opts.skipStale) {
      const index = await this.runner.snapshot({ maxAgeMs: 0 });
      const now = Date.now();
      const listed = new Set(candidates.map((c) => c.id));
      const orphans = [...(index?.nodes.values() ?? [])].filter(
        (n) => n.kind === 'claim' && n.status === 'stale' && (!n.lease || n.lease.expiresAt <= now) && wanted(n) && !listed.has(n.id),
      );
      candidates.push(...orphans);
    }
    for (const c of candidates) {
      if (this.runner.stopping) return null;
      this.runner.inFlight.add(c.id);
      const t0 = Date.now();
      const res = await this.api.claim(this.opts.agentKey, c.id, this.name);
      if (res.ok) {
        this.runner.attempts.set(c.id, (this.runner.attempts.get(c.id) ?? 0) + 1);
        const stale =
          res.data.status === 'stale'
            ? ' (stale: it must be re-planned first)'
            : c.status === 'claimed'
              ? ` (taken over from ${c.lease?.holder ?? 'an agent'} whose lease lapsed)`
              : '';
        this.log(`took ${c.id} in ${Date.now() - t0} ms${stale}: ${c.statement}`);
        return { id: c.id, node: c, ...res.data };
      }
      this.runner.inFlight.delete(c.id);
      if (res.status === 409) {
        this.log(`${c.id} was taken by another agent first; trying the next`);
        continue;
      }
      if (res.status === 401) {
        this.log(`the agent key was refused: ${explainError(res)}`);
        this.runner.interrupt();
        return 'finished';
      }
      this.log(`could not take ${c.id}: ${explainError(res)}`);
    }
    if (candidates.length) return null;
    return (await this.nothingLeft()) ? 'finished' : null;
  }

  // Nothing is ready, and nothing in motion can make a claim ready: no lease
  // is live, and no finished claim is still on its way to landing (a claim
  // that builds on another waits for it to land). A graph that stops changing
  // for --patience seconds counts as finished too.
  async nothingLeft() {
    const index = await this.runner.snapshot({ maxAgeMs: 0 });
    if (!index) return false;
    const claims = [...index.nodes.values()].filter((n) => n.kind === 'claim');
    const now = Date.now();
    const lapsed = (c) => !c.lease || c.lease.expiresAt <= now;
    const takeable = (c) =>
      this.runner.mayTake(c.id) &&
      (c.status === 'open' || (c.status === 'claimed' && lapsed(c)) || (c.status === 'stale' && !this.opts.skipStale && lapsed(c)));
    if (!claims.some(takeable)) return true;
    if (this.runner.inFlight.size) return false;
    const live = claims.some((c) => (c.status === 'claimed' || c.status === 'stale') && c.lease && c.lease.expiresAt > Date.now());
    const landing = claims.some((c) => landingPending(c, index));
    if (live || landing) {
      const fingerprint = JSON.stringify([index.events.length, index.pushes.length, claims.map((c) => c.status)]);
      if (fingerprint !== this.runner.fingerprint) {
        this.runner.fingerprint = fingerprint;
        this.runner.changedAt = Date.now();
      }
      return Date.now() - (this.runner.changedAt ?? Date.now()) > this.opts.patience * 1000;
    }
    return true;
  }

  async work(grant) {
    const id = grant.id;
    const dir = join(this.opts.workDir, this.opts.graph, id);
    this.claimId = id;
    this.dir = dir;
    this.transcript = null;
    this.set({ claim: id, state: 'preparing', since: Date.now(), last: 'cloning its repository' });
    const t0 = Date.now();
    await this.prepare(dir, grant);
    if (grant.git) {
      this.log(`cloned ${grant.repo.name} at ${shortSha(grant.baseSha)} into ${relative(process.cwd(), dir)} in ${Date.now() - t0} ms`);
    } else {
      this.log(`${id} is stale, so it comes without write access; its code arrives when the agent re-plans it`);
      this.set({ state: 'stale' });
    }

    const lease = new LeaseKeeper(this, dir, id, grant);
    lease.start();
    let outcome;
    try {
      outcome = this.runner.stopping ? { ok: false, why: 'interrupted before it started' } : await this.runAgent(dir, id);
      await this.wrapUp(dir, id, outcome);
    } finally {
      lease.stop();
    }
  }

  // The working copy: a clone of the claim's repo with the git token in
  // repo-local config, the agent's brief, the claim file and the hooks. A
  // stale claim gets no git token until it is re-planned, so its copy starts
  // empty and the CLI fetches the code after the re-plan.
  async prepare(dir, grant) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    if (grant.git) {
      await gitAsync(dirname(dir), ['clone', '--quiet', grant.repo.remote, grant.id], { env: gitAuthEnv(grant.git.token) });
      installGitAuth(dir, grant.repo.remote, grant.git.token);
    } else {
      mkdirSync(dir);
      git(dir, ['init', '--quiet', '-b', 'main']);
      git(dir, ['remote', 'add', 'origin', grant.repo.remote]);
      installGitAuth(dir, grant.repo.remote, 'none-until-the-claim-is-re-planned');
    }
    git(dir, ['config', 'user.name', this.name]);
    git(dir, ['config', 'user.email', `${this.name}@agents.superpose.invalid`]);
    // An empty line clones with no commits; make sure the first one goes on main.
    if (git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], { check: false }).code !== 0) {
      git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    }
    appendFileSync(join(dir, '.git', 'info', 'exclude'), '\n# Superpose: the brief and the claim state are not part of the work\nCLAIM.md\n.superpose/\n');
    const hook = (name) => {
      const file = join(dir, '.git', 'hooks', name);
      writeFileSync(file, `#!/bin/sh\n# Installed by the Superpose runner.\nexec ${shq(process.execPath)} ${shq(CLI)} hook ${name} "$@"\n`);
      chmodSync(file, 0o755);
    };
    hook('pre-push');
    hook('commit-msg');
    const claim = {
      url: this.opts.url,
      graph: this.opts.graph,
      claim: grant.id,
      lease: grant.token,
      expiresAt: grant.expiresAt,
      agent: this.name,
      statement: grant.node.statement,
      scope: grant.node.scope,
      baseSha: grant.baseSha ?? null,
      repo: grant.repo,
      gitExpiresAt: grant.git?.expiresAt ?? null,
      status: grant.status,
      takenAt: Date.now(),
    };
    writeClaim(dir, claim);
    atomicWrite(stateFile(dir, 'NOTICES.md'), `# Notices for claim ${grant.id} (newest first)\n\nNone yet. The runner adds to this file as the platform speaks.\n`);
    const index = await this.runner.claimSnapshot(grant.token);
    if (!index) throw new Error('Could not read this claim’s authorized context; retry before starting the agent.');
    // Whoever takes a claim hears what was said about it before: a finding
    // filed to help it while it was open, a push into its scope, why it went
    // stale. Verdicts on old pushes are left out; the poll carries what comes next.
    const earlier = [...noticesAbout(index, grant.id, { types: STANDING_NOTICES }), ...adviceFor(index, grant.id)];
    for (const n of recordNotices(dir, earlier)) this.log(`${grant.id} starts with a notice: ${n.title}`);
    advanceSeenSeq(dir, latestSeq(index));
    if (grant.status === 'stale') {
      setMarker(
        dir,
        'STALE',
        `Claim ${grant.id} was stale when this agent took it over: something it rested on was shown to be false. ` +
          `Re-plan it before anything else; the claim's code arrives in this folder with the re-plan.`,
      );
    }
    atomicWrite(join(dir, 'CLAIM.md'), renderClaimMd(claim, index, dir));
  }

  transcriptPath(id) {
    const base = join(this.opts.runsDir, id);
    if (!existsSync(`${base}.jsonl`)) return `${base}.jsonl`;
    for (let i = 2; ; i++) if (!existsSync(`${base}.${i}.jsonl`)) return `${base}.${i}.jsonl`;
  }

  // Start the agent in the working copy and wait for it to exit.
  runAgent(dir, id) {
    const transcript = this.transcriptPath(id);
    this.transcript = transcript;
    const stderrLog = transcript.replace(/\.jsonl$/, '.stderr.log');
    const { cmd, args, env } = this.opts.agent === 'scripted' ? this.scriptedCommand() : this.claudeCommand(dir, id);
    this.set({ state: 'working', last: `${this.opts.agent} agent started` });
    this.log(`started a ${this.opts.agent} agent on ${id}; transcript ${relative(process.cwd(), transcript)}`);
    return new Promise((resolveRun) => {
      const child = spawn(cmd, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      this.child = child;
      const outcome = { ok: false, code: null, signal: null, result: null, turns: 0, cost: 0 };
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim()) this.onAgentLine(line, transcript, outcome);
        }
      });
      child.stderr.on('data', (chunk) => appendFileSync(stderrLog, chunk));
      child.on('error', (err) => {
        this.log(`could not start the agent: ${err.message}`);
      });
      child.on('close', (code, signal) => {
        if (buffer.trim()) this.onAgentLine(buffer, transcript, outcome);
        this.child = null;
        outcome.code = code;
        outcome.signal = signal;
        const r = outcome.result;
        outcome.ok =
          code === 0 && !this.runner.stopping && (this.opts.agent === 'scripted' || (r?.subtype === 'success' && !r?.is_error));
        resolveRun(outcome);
      });
    });
  }

  claudeCommand(dir, id) {
    const settings = {
      // The working copy is the agent's whole world: instructions in folders
      // above it (this machine's own CLAUDE.md files) are not for it.
      claudeMdExcludes: ancestorInstructionFiles(dir),
      autoMemoryEnabled: false,
      hooks: {
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${shq(process.execPath)} ${shq(CLI)} hook claude-notices --dir ${shq(dir)}` }] }],
        Stop: [{ hooks: [{ type: 'command', command: `${shq(process.execPath)} ${shq(CLI)} hook claude-stop --dir ${shq(dir)}` }] }],
      },
    };
    const settingsFile = stateFile(dir, 'claude-settings.json');
    atomicWrite(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    const args = [
      '-p',
      prompt(dir, id),
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--settings',
      settingsFile,
      '--strict-mcp-config',
      '--no-session-persistence',
      '--disallowed-tools',
      DISALLOWED_TOOLS.join(','),
    ];
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.maxTurns) args.push('--max-turns', String(this.opts.maxTurns));
    if (this.opts.effort) args.push('--effort', this.opts.effort);
    if (this.opts.budget) args.push('--max-budget-usd', String(this.opts.budget));
    return { cmd: this.opts.claudeBin, args, env: agentEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }) };
  }

  scriptedCommand() {
    return {
      cmd: process.execPath,
      args: [join(RUNNER_DIR, 'scripted-agent.mjs')],
      env: agentEnv({
        SUPERPOSE_SCRIPTED_HOLD: String(this.opts.hold ?? 0),
        ...(process.env.SUPERPOSE_SCRIPTED_STRAY ? { SUPERPOSE_SCRIPTED_STRAY: process.env.SUPERPOSE_SCRIPTED_STRAY } : {}),
        ...(process.env.SUPERPOSE_SCRIPTED_FINDINGS ? { SUPERPOSE_SCRIPTED_FINDINGS: process.env.SUPERPOSE_SCRIPTED_FINDINGS } : {}),
      }),
    };
  }

  // One line of the agent's output: kept in the transcript, summarised on
  // the status line.
  onAgentLine(line, transcript, outcome) {
    if (this.opts.agent === 'scripted') {
      appendFileSync(transcript, JSON.stringify({ type: 'scripted', at: Date.now(), text: line }) + '\n');
      this.set({ last: line.slice(0, 100) });
      if (/refused|stale|failed|Finished|Handed back|Re-planned/i.test(line)) this.log(line);
      return;
    }
    appendFileSync(transcript, line + '\n');
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === 'system' && event.subtype === 'init') {
      outcome.model = event.model;
      this.set({ last: `model ${event.model}` });
    } else if (event.type === 'assistant') {
      for (const part of event.message?.content ?? []) {
        if (part.type === 'tool_use') {
          outcome.turns++;
          this.set({ turns: outcome.turns, last: describeTool(part, this.dir) });
        }
      }
    } else if (event.type === 'result') {
      outcome.result = event;
      outcome.cost = event.total_cost_usd ?? null;
      this.set({ cost: outcome.cost, last: `agent finished: ${event.subtype}${event.is_error ? ' (error)' : ''}` });
      this.log(`agent ended: ${event.subtype}, ${event.num_turns} actions${outcome.cost === null ? ', dollar usage unavailable' : `, $${outcome.cost.toFixed(3)}`}`);
    }
  }

  kill(signal) {
    if (!this.child) return;
    try {
      process.kill(-this.child.pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // already gone
      }
    }
    if (signal === 'SIGTERM') {
      const child = this.child;
      setTimeout(() => {
        if (this.child === child) this.kill('SIGKILL');
      }, 10_000).unref();
    }
  }

  // After the agent: if it neither finished nor handed back the claim, save
  // and push its work, then finish (it ended normally) or hand back (it gave
  // up, failed, or was stopped).
  async wrapUp(dir, id, outcome) {
    let result;
    if (hasMarker(dir, 'DONE')) result = 'done';
    else if (hasMarker(dir, 'RELEASED')) result = 'released';
    else if (hasMarker(dir, 'LOST')) result = 'lost';
    else {
      this.set({ state: 'wrapping up', last: 'saving the work' });
      this.saveLeftovers(dir, id);
      if (outcome.ok && !hasMarker(dir, 'STALE')) {
        this.log(`the agent ended without running done; finishing ${id} for it`);
        const r = await runCli(dir, ['done']);
        this.log(r.out.split('\n').slice(-1)[0] ?? '');
      }
      if (hasMarker(dir, 'DONE')) result = 'done';
      else {
        const why = this.runner.stopping
          ? 'the runner was stopped'
          : outcome.result?.subtype && outcome.result.subtype !== 'success'
            ? `the agent stopped: ${outcome.result.subtype}`
            : `the agent exited (code ${outcome.code}${outcome.signal ? `, ${outcome.signal}` : ''}) without finishing`;
        const r = await runCli(dir, ['release', why]);
        result = hasMarker(dir, 'RELEASED') ? 'released' : 'lost';
        this.log(r.out.split('\n').slice(-1)[0] ?? '');
      }
    }
    const index = await this.runner.snapshot({ maxAgeMs: 0 });
    const rows = index?.pushes.filter((p) => p.claim === id) ?? [];
    const node = index?.nodes.get(id);
    const head = rows.find((p) => p.sha === node?.headSha);
    const since = this.runner.display.rows.get(this.name)?.since ?? Date.now();
    this.runner.results.push({
      agent: this.name,
      claim: id,
      result,
      ms: Date.now() - since,
      pushes: rows.length,
      verdict: head?.verdict,
      headSha: node?.headSha,
      turns: outcome.result?.num_turns ?? (outcome.turns || undefined),
      cost: outcome.cost ?? null,
      transcript: this.transcript,
    });
    // What the run cost goes into the graph, beside the claim's verdicts.
    if (outcome.result && outcome.cost !== null) {
      await this.runner.api
        .spend(this.opts.agentKey, id, { usd: outcome.cost ?? 0, turns: outcome.result.num_turns ?? outcome.turns ?? 0, model: outcome.model })
        .catch(() => {});
    }
    this.set({ state: result, last: '' });
    this.log(`${id}: ${result}`);
  }

  // Commit what the agent left uncommitted inside the scope, and push
  // committed work, so whoever takes the claim next starts from it.
  saveLeftovers(dir, id) {
    try {
      const claim = JSON.parse(readFileSync(stateFile(dir, 'claim.json'), 'utf8'));
      const dirty = git(dir, ['status', '--porcelain', '--untracked-files=all'])
        .stdout.split('\n')
        .filter(Boolean)
        .map((l) => l.slice(3));
      const keep = dirty.filter((p) => inScope(p, claim.scope));
      const leave = dirty.filter((p) => !inScope(p, claim.scope));
      if (keep.length) {
        git(dir, ['add', '-A', '--', ...keep]);
        git(dir, ['commit', '--quiet', '-m', `Save unfinished work on ${id} (the agent stopped)`]);
        this.log(`committed ${keep.length} unsaved file(s) the agent left: ${keep.join(', ')}`);
      }
      if (leave.length) this.log(`left ${leave.length} file(s) outside the scope uncommitted: ${leave.join(', ')}`);
      if (hasMarker(dir, 'STALE') || hasMarker(dir, 'LOST')) return;
      const head = git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], { check: false }).stdout.trim();
      const remote = git(dir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { check: false }).stdout.trim();
      if (head && head !== remote) {
        const r = git(dir, ['push', 'origin', 'HEAD:refs/heads/main'], { check: false, timeoutMs: 120_000 });
        this.log(r.code === 0 ? `pushed ${shortSha(head)}` : `could not push ${shortSha(head)}: ${r.stderr.trim().split('\n').at(-1)}`);
      }
    } catch (err) {
      this.log(`could not save the work: ${err.message}`);
    }
  }

  async handBack(grant, why) {
    const res = await this.api.release(grant.token, grant.id);
    this.log(res.ok ? `handed back ${grant.id} (${why})` : `could not hand back ${grant.id}: ${explainError(res)}`);
  }
}

// ---- keeping the lease ----------------------------------------------------------------------------------

// Renews the lease on a timer. Each renewal brings a fresh git token (written
// into the working copy's config) and the notices since the last one (written
// into NOTICES.md, where the hooks and the agent read them).
class LeaseKeeper {
  constructor(slot, dir, id, grant) {
    this.slot = slot;
    this.runner = slot.runner;
    this.dir = dir;
    this.id = id;
    this.token = grant.token;
    this.remote = grant.repo.remote;
    this.expiresAt = grant.expiresAt;
    const leaseMs = Math.max(60_000, grant.expiresAt - Date.now());
    const every = Number(slot.opts.renewEvery) * 1000;
    this.interval = every > 0 ? every : Math.min(60_000, Math.max(5_000, leaseMs / 3));
    this.pollInterval = Math.max(2_000, (Number(slot.opts.pollEvery) || 10) * 1000);
    this.stopped = false;
  }

  start() {
    this.slot.log(
      `renewing the lease on ${this.id} every ${formatDuration(this.interval)} (it runs ${formatDuration(this.expiresAt - Date.now())} at a time); ` +
        `reading the graph for notices every ${formatDuration(this.pollInterval)}`,
    );
    this.schedule(this.interval);
    this.schedulePoll();
  }

  schedule(ms) {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.renew().finally(() => this.schedule(this.next ?? this.interval)), ms);
  }

  schedulePoll() {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => this.poll().finally(() => this.schedulePoll()), this.pollInterval);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.pollTimer);
  }

  // A renewal replaces the git token, so it happens once a minute; a notice
  // cannot wait that long. Between renewals the claim's scoped snapshot is read for anything new said
  // about this claim, and for advice filed for it that no checker has ruled
  // on yet. Whatever the renewal brings later is recognised and not repeated.
  async poll() {
    if (this.stopped || hasMarker(this.dir, 'DONE') || hasMarker(this.dir, 'RELEASED')) return;
    let index;
    try {
      index = await this.runner.claimSnapshot(this.token);
    } catch {
      return;
    }
    if (!index || this.stopped) return;
    const fresh = recordNotices(this.dir, [...noticesAbout(index, this.id, { afterSeq: readSeenSeq(this.dir) }), ...adviceFor(index, this.id)]);
    advanceSeenSeq(this.dir, latestSeq(index));
    for (const n of fresh) this.slot.log(`notice: ${n.title}`);
    // A claim that went stale is stale now, not at the next renewal: the
    // marker the hooks and the agent read goes down with the notice.
    const stale = fresh.find((n) => n.type === 'claim.stale');
    if (stale && !hasMarker(this.dir, 'STALE') && !hasMarker(this.dir, 'DONE')) {
      const claim = updateClaim(this.dir, { status: 'stale' });
      this.slot.set({ state: 'stale' });
      const left = this.expiresAt - Date.now();
      setMarker(
        this.dir,
        'STALE',
        `Claim ${this.id} is stale: ${stale.title}. Re-plan within ${formatDuration(left)} (before ${new Date(this.expiresAt).toISOString()}), or the lease runs out.`,
      );
      atomicWrite(join(this.dir, 'CLAIM.md'), renderClaimMd(claim, index, this.dir));
      this.slot.log(`${this.id} is STALE; the agent has ${formatDuration(left)} to re-plan`);
    }
  }

  async renew() {
    if (this.stopped || hasMarker(this.dir, 'DONE') || hasMarker(this.dir, 'RELEASED')) return this.stop();
    // A renewal replaces the git token and the old one stops working at once,
    // so wait for a push in flight to end, unless the lease is running out.
    if (pushInFlight(this.dir) && this.expiresAt - Date.now() > 90_000) {
      this.next = 3000;
      return;
    }
    const res = await this.runner.api.renew(this.token, this.id);
    if (this.stopped) return;
    this.next = this.interval;
    if (res.ok) {
      const v = res.data;
      const patch = {};
      if (v.git?.token) {
        writeGitAuth(this.dir, v.git.remote ?? this.remote, v.git.token);
        patch.gitExpiresAt = v.git.expiresAt;
      }
      if (v.notices?.length) {
        const index = await this.runner.claimSnapshot(this.token);
        // The poll usually got here first; only what it missed is new.
        for (const n of recordNotices(this.dir, v.notices.map((n) => describeNotice(n, index, this.id)))) this.slot.log(`notice: ${n.title}`);
      }
      if (v.ok) {
        this.expiresAt = v.expiresAt;
        patch.expiresAt = v.expiresAt;
        patch.status = 'claimed';
        if (hasMarker(this.dir, 'STALE')) {
          clearMarker(this.dir, 'STALE');
          this.slot.log(`${this.id} was re-planned; the lease renews again`);
        }
        this.slot.set({ state: 'working' });
      } else if (v.reason === 'stale') {
        patch.status = 'stale';
        this.slot.set({ state: 'stale' });
      } else if (v.reason === 'hedge-expired') {
        setMarker(this.dir, 'HEDGE_EXPIRED', 'This speculative investigation needs an owner decision before more work.');
        this.slot.log(`${this.id}: investigation budget expired; parking this agent without affecting other work`);
        this.slot.kill('SIGTERM');
        return this.stop();
      }
      const claim = Object.keys(patch).length ? updateClaim(this.dir, patch) : null;
      if (v.reason === 'stale' && !hasMarker(this.dir, 'STALE')) {
        const left = this.expiresAt - Date.now();
        setMarker(
          this.dir,
          'STALE',
          `Claim ${this.id} is stale: an assumption it rests on was contradicted. Re-plan within ${formatDuration(left)} ` +
            `(before ${new Date(this.expiresAt).toISOString()}), or the lease runs out.`,
        );
        // The brief now opens with the stale warning.
        atomicWrite(join(this.dir, 'CLAIM.md'), renderClaimMd(claim, await this.runner.claimSnapshot(this.token), this.dir));
        this.slot.log(`${this.id} is STALE; the agent has ${formatDuration(left)} to re-plan`);
      }
      return;
    }
    if (res.status === 401 || res.status === 404) {
      if (hasMarker(this.dir, 'DONE') || hasMarker(this.dir, 'RELEASED')) return this.stop();
      const index = await this.runner.snapshot({ maxAgeMs: 0 });
      const node = index?.nodes.get(this.id);
      if (node && (node.status === 'done' || node.status === 'landed')) return this.stop();
      setMarker(this.dir, 'LOST', explainError(res));
      recordNotices(this.dir, [
        localNotice(`LOST: the lease on claim ${this.id} is gone`, `${explainError(res)}\nStop working on this claim: pushes are no longer possible.`, 'local.lost'),
      ]);
      this.slot.log(`lost the lease on ${this.id}: ${explainError(res)}; ending the agent`);
      this.slot.kill('SIGTERM');
      return this.stop();
    }
    this.next = 5000;
    this.slot.log(`renewal failed (${explainError(res)}); trying again in 5 s`);
  }
}

// ---- helpers -------------------------------------------------------------------------------------------------

// The pre-push hook records the `git push` process; it is in flight while
// that process lives (markers older than five minutes are ignored).
function pushInFlight(dir) {
  const p = readJson(stateFile(dir, 'pushing.json'), null);
  if (!p?.pid || Date.now() - p.at > 300_000) return false;
  try {
    process.kill(p.pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A finished claim the platform will still land by itself: its head passed
// its checks, or they have not finished yet, and its landing has not failed.
function landingPending(c, index) {
  if (c.status !== 'done') return false;
  if (c.landing && !['queued', 'landing'].includes(c.landing.status)) return false;
  if (!c.headSha) return true;
  const row = index.pushes.find((p) => p.claim === c.id && p.sha === c.headSha);
  return !row || row.verdict === 'checks-passed' || row.verdict === 'unverified';
}

function runCli(dir, args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [CLI, ...args, '--dir', dir], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolveRun({ code, out: out.trim() }));
  });
}

// CLAUDE.md and AGENTS.md files in the folders above a working copy.
function ancestorInstructionFiles(dir) {
  const out = [];
  let d = dirname(resolve(dir));
  for (;;) {
    for (const f of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude/CLAUDE.md', '.claude/rules/**']) out.push(join(d, f));
    const up = dirname(d);
    if (up === d) return out;
    d = up;
  }
}

function prompt(dir, id) {
  const brief = readFileSync(join(dir, 'CLAIM.md'), 'utf8');
  const stale = hasMarker(dir, 'STALE')
    ? `\n\nThis claim is STALE: something it rested on was shown to be false (see .superpose/NOTICES.md). Re-plan it before ` +
      `anything else, as CLAIM.md explains; this folder has no code yet, and the claim's code arrives when the re-plan succeeds.`
    : '';
  return (
    `You are an autonomous software agent working on claim ${id} of a project coordinated by Superpose. ` +
    'Your current directory is the git repository for this claim. Everything you need is in CLAIM.md, reproduced ' +
    'below (it is also in this directory). Follow it exactly. Nobody will answer questions: make your own decisions ' +
    `and keep going until you have run \`${CMD} done\` (or, if you truly cannot finish, \`${CMD} release "<why>"\`).${stale}\n\n---\n\n${brief}`
  );
}

function describeTool(part, dir) {
  const input = part.input ?? {};
  const rel = (p) => (p && dir && p.startsWith(dir) ? p.slice(dir.length + 1) : p);
  if (part.name === 'Bash') return `$ ${String(input.command ?? '').split('\n')[0].slice(0, 80)}`;
  if (input.file_path) return `${part.name} ${rel(input.file_path)}`;
  if (input.pattern) return `${part.name} ${input.pattern}`;
  return part.name;
}

// ---- main --------------------------------------------------------------------------------------------------

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ args: process.argv.slice(2), options: OPTIONS, strict: true }));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  try {
    loadEnv(values.env);
    const graph = values.graph;
    if (!graph || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(graph)) throw new UsageError('--graph <gid> is required (letters, digits, - and _).');
    if (!['claude', 'scripted'].includes(values.agent)) throw new UsageError('--agent must be claude or scripted.');
    const agents = Number(values.agents);
    if (!Number.isInteger(agents) || agents < 1) throw new UsageError('--agents must be a positive whole number.');
    const agentKey = process.env.SUPERPOSE_AGENT_KEY || process.env.SUPERPOSE_ADMIN_TOKEN;
    if (!agentKey) throw new UsageError('SUPERPOSE_AGENT_KEY is not set: export it, or pass --env <file> that defines it.');
    if (values.agent === 'claude') {
      const probe = spawnSync(values.claude, ['--version'], { encoding: 'utf8' });
      if (probe.status !== 0) throw new UsageError(`Claude Code (\`${values.claude}\`) was not found. Install it and log in, or use --agent scripted.`);
    }
    const url = serviceUrl(values.url);
    const opts = {
      graph,
      url,
      agents,
      agent: values.agent,
      agentKey,
      model: values.model,
      maxTurns: values['max-turns'] ? Number(values['max-turns']) : undefined,
      effort: values.effort,
      budget: values.budget ? Number(values.budget) : undefined,
      only: values.only ? new Set(values.only.split(',').map((s) => s.trim()).filter(Boolean)) : null,
      once: !!values.once,
      hold: values.hold ? Number(values.hold) : 0,
      skipStale: !!values['skip-stale'],
      maxAttempts: Number(values['max-attempts']) || 2,
      renewEvery: values['renew-every'],
      pollEvery: Number(values['poll-every']) || 10,
      patience: Number(values.patience) || 600,
      name: values.name || values.agent,
      workDir: resolve(values.work ?? join(REPO_DIR, 'work')),
      runsDir: join(resolve(values.runs ?? join(REPO_DIR, 'runs')), graph),
      quiet: !!values.quiet,
      claudeBin: values.claude,
      host: hostname(),
    };
    const runner = new Runner(new Api(url, graph, opts.agentKey), opts);
    await runner.start();
    return runner.stopping ? 130 : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`run failed: ${err?.stack ?? err}\n`);
    return 1;
  }
}

process.exitCode = await main();
