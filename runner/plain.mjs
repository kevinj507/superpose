#!/usr/bin/env node
// The plain-git arm of the experiment: the same Claude Code agents on the same
// scenario as runner/run.mjs, coordinated by nothing but a shared git
// repository. No Superpose service, CLI, hooks or notices.
//
//   node runner/plain.mjs <scenario dir> --agents 3 [--model haiku] [--max-turns <n>]
//                         [--work <dir>] [--runs <dir>] [--claude <cmd>]
//
// The scenario's seed/ folder becomes one commit on main in a local bare
// repository (<work>/_origin.git). Every claim in plan.json is a task: its key,
// statement, scope (the files it is expected to change: advice that nothing
// enforces) and requires. Assumptions, lines and restsOn belong to Superpose
// and are ignored. N agent slots take ready tasks in plan order; a task is
// ready once every task it requires is done, meaning its commits are on main.
// Each task gets a fresh clone (<work>/<key>) on a branch task/<key> and a
// Claude Code agent started the way run.mjs starts one, with a brief (TASK.md)
// that mirrors run.mjs's CLAIM.md without Superpose: commit on the branch, run
// the tests, fetch, rebase onto (or merge) origin/main, run the tests again,
// push HEAD:main, and fetch and repeat if the push is rejected. When the agent
// exits, the runner checks that its commits are on main and marks the task
// done or failed; a failed task blocks the tasks that need it. At the end it
// runs the visible tests on a fresh checkout of main, and the scenario's
// hidden/check.mjs if it has one, and writes <runs>/summary.json. Transcripts
// (the agents' stream-json) go to <runs>/<key>.jsonl, as run.mjs keeps them.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { REPO_DIR, UsageError, agentEnv, atomicWrite, formatDuration, git, gitAsync, readJson, shortSha } from './lib.mjs';

const USAGE = `Usage: node runner/plain.mjs <scenario dir> [options]

Runs Claude Code agents on a scenario's tasks with plain git: one shared
repository, a branch per task, and every agent putting its own work on main.
The "without Superpose" arm of the experiment (run.mjs is the other arm).

  --agents <n>           how many agents to run at once (default 1)
  --model <m>            Claude model, e.g. haiku, sonnet, opus (default: Claude Code's own)
  --max-turns <n>        stop a Claude agent after this many turns
  --effort <level>       Claude effort: low, medium, high, xhigh, max
  --budget <usd>         stop a Claude agent after it spends this much on one task
  --name <prefix>        agent names are <prefix>-1, <prefix>-2, ... (default: claude)
  --work <dir>           where the shared repository and the clones go; must be new or empty
                         (default: work/plain-<scenario>-<time>)
  --runs <dir>           where transcripts, the log and summary.json go
  --ask-both-ways        the control arm: also ask each agent to work out what its approach relies
                         on and to check both ways whether its work and others' break each other
                         (the baseline leaves this out: nothing asks about assumptions)
  --hidden <check.mjs>   the hidden check to run at the end (default: <scenario>/hidden/check.mjs)
                         (default: runs/plain-<scenario>-<time>)
  --claude <cmd>         the Claude Code executable (default: claude); a stub makes a dry
                         run without a model, e.g. --claude test/fixtures/stub-claude.mjs`;

const OPTIONS = {
  agents: { type: 'string', default: '1' },
  model: { type: 'string' },
  'max-turns': { type: 'string' },
  effort: { type: 'string' },
  budget: { type: 'string' },
  name: { type: 'string', default: 'claude' },
  work: { type: 'string' },
  runs: { type: 'string' },
  claude: { type: 'string', default: 'claude' },
  'ask-both-ways': { type: 'boolean', default: false },
  hidden: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

// Kept identical to run.mjs: Claude Code tools an agent working one task has
// no use for, and some that would take it out of its working copy or keep it running.
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

// The platform's defaults for a project's checks (src/core/checks.ts).
const DEFAULT_TIMEOUT = 300;
const MAX_TIMEOUT = 1200;
// How long each end-of-run step may take, as in runner/final-check.mjs.
const FINAL_TIMEOUT = 300;

const clock = () => new Date().toISOString().slice(11, 19);
const rel = (p) => {
  const r = relative(process.cwd(), p);
  return r.startsWith('..') ? p : r || '.';
};
const lines = (s) => s.split('\n').filter(Boolean);
const tail = (s, n) => (s.length > n ? `...${s.slice(-n)}` : s);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- the scenario ----------------------------------------------------------------------------

// plan.json's claims, as tasks, in plan order. The same checks as plan.mjs
// makes on the claims; assumptions and lines are not read.
function readPlan(dir) {
  const file = join(dir, 'plan.json');
  if (!existsSync(file)) throw new UsageError(`${file} not found`);
  let plan;
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`${file} is not valid JSON: ${err.message}`);
  }
  const claims = plan.claims ?? [];
  if (!claims.length) throw new UsageError(`${file} lists no claims`);
  const keys = new Set();
  for (const c of claims) {
    if (!c.key || !c.statement || !Array.isArray(c.scope) || !c.scope.length) {
      throw new UsageError(`every claim needs a key, a statement and a scope: ${JSON.stringify(c)}`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(c.key)) {
      throw new UsageError(`claim key "${c.key}" must be letters, digits, - and _ (it names a branch and a folder)`);
    }
    if (keys.has(c.key)) throw new UsageError(`claim key "${c.key}" is used twice`);
    keys.add(c.key);
  }
  const byKey = new Map(claims.map((c) => [c.key, c]));
  const state = new Map();
  const visit = (c, path) => {
    if (state.get(c.key) === 'done') return;
    if (state.get(c.key) === 'visiting') throw new UsageError(`claims require each other in a cycle: ${[...path, c.key].join(' -> ')}`);
    state.set(c.key, 'visiting');
    for (const k of c.requires ?? []) {
      if (!byKey.has(k)) throw new UsageError(`claim "${c.key}" requires unknown claim "${k}"`);
      visit(byKey.get(k), [...path, c.key]);
    }
    state.set(c.key, 'done');
  };
  for (const c of claims) visit(c, []);
  return {
    name: plan.name ?? basename(dir),
    // The constitution, shown to every agent as the Superpose brief shows it.
    constitution: (plan.constitution ?? []).map((a) => ({ key: a.key, statement: a.statement, ...(a.check ? { check: a.check } : {}) })),
    tasks: claims.map((c) => ({ key: c.key, statement: c.statement, scope: c.scope, requires: c.requires ?? [], status: 'pending' })),
    // Lines forked from another build one decision two ways; plain git has one main.
    forks: (plan.lines ?? []).filter((l) => l.from).map((l) => l.name),
  };
}

// How the project runs its tests, read the way the platform reads it
// (src/core/checks.ts): superpose.json's setup and check, or else a
// package.json test script. Read from the seed, so no agent can change which
// commands judge the run (what `npm test` runs is main's package.json, as in
// the Superpose arm's final check).
function checkConfig(seedDir) {
  const clamp = (v) => Math.min(MAX_TIMEOUT, Math.max(10, typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : DEFAULT_TIMEOUT));
  const declared = readJson(join(seedDir, 'superpose.json'), null);
  if (declared && typeof declared.check === 'string' && declared.check.trim()) {
    const setup = typeof declared.setup === 'string' && declared.setup.trim() ? declared.setup : undefined;
    return { setup, check: declared.check, timeoutSeconds: clamp(declared.timeoutSeconds) };
  }
  const pkg = readJson(join(seedDir, 'package.json'), null);
  if (typeof pkg?.scripts?.test === 'string') return { setup: 'npm install --no-audit --no-fund', check: 'npm test', timeoutSeconds: DEFAULT_TIMEOUT };
  return null;
}

// ---- the brief -------------------------------------------------------------------------------------

// TASK.md: run.mjs's CLAIM.md (lib.mjs renderClaimMd) with Superpose taken
// out (no claim, scope enforcement, assumptions, findings, notices or CLI) and
// the plain-git workflow put in, plus the README and the exact test command.
// Where CLAIM.md says to declare an assumption, this says to work it out;
// where it says to file a finding, this says to put it in the commit message,
// the one channel plain git has between agents.
function renderTaskMd(task, { tasks, byKey, readme, check, askBothWays = false, constitution = [] }) {
  const branch = `task/${task.key}`;
  const out = [];
  out.push(`# Task ${task.key}`, '');
  out.push(`**Make this true:** ${task.statement}`, '');
  out.push(
    'You are one of several agents working on this project at the same time. Each agent works on one task, in its',
    "own clone of the project's git repository, and puts its work on the shared `main` branch when it is ready.",
    `This directory is your clone, on the branch \`${branch}\`; the other agents push to the same \`main\`.`,
    '',
  );
  // The constitution, as the Superpose brief shows it, with plain git's one
  // enforcement: the tests run it, and nothing else does.
  if (constitution.length) {
    out.push('## The constitution: what this product keeps, whatever you build', '');
    for (const a of constitution) out.push(`- \`${a.key}\`: ${a.statement}${a.check ? ` (checked by \`${a.check}\`)` : ' (no test: judged)'}`);
    out.push(
      '',
      'Your statement is a minimum; these are bounds, and every task keeps them. The tests run them (`npm test` includes',
      '`constitution/`), on your clone as it stands: work that is right on its own and wrong next to other work shows up',
      "only when your clone has the other work in it, so bring your branch up to date with main and run the tests again",
      'before you push. Before you write code, read the other work in this project below and ask whether your statement,',
      'built the obvious way, keeps every article next to it; if not, build it so that it does. If an article and your',
      'statement cannot both hold, say so in your commit message. The files under `constitution/` belong to the owner:',
      'never change them.',
      '',
    );
  }
  out.push('## Files this task is expected to change', '');
  for (const p of task.scope) out.push(`- \`${p}\``);
  out.push(
    '',
    "`**` matches any number of folders and `*` matches within one name. This is the plan's expectation, not a rule:",
    'nothing checks which files you change. The other agents are changing other files at the same time, so keep to',
    'these unless the task truly needs more.',
    '',
  );
  if (task.requires.length) {
    out.push('## Builds on', '');
    for (const k of task.requires) out.push(`- \`${k}\` (done: its work is on main, so it is in your clone): ${byKey.get(k).statement}`);
    out.push('', 'Use that work as it is; leave its files alone unless your task truly cannot be done without changing them.', '');
  }
  // Every other task, done ones included, as CLAIM.md lists the other work in
  // a claim's reality (without what each rests on: plain git has no assumptions).
  const others = tasks.filter((t) => t !== task);
  if (others.length) {
    out.push('## Other work in this project (not yours: leave their files alone)', '');
    for (const t of others.slice(0, 20)) {
      const status = { done: 'done: on main', running: `in progress, by ${t.agent}`, pending: 'not started' }[t.status] ?? 'not finished';
      out.push(`- \`${t.key}\` (${status}): ${t.statement} Files: ${t.scope.map((p) => `\`${p}\``).join(', ')}`);
    }
    if (others.length > 20) out.push(`- ... and ${others.length - 20} more`);
    out.push('');
  }
  // Only the control arm (--ask-both-ways) asks about assumptions: the
  // baseline is plain git with a task board, and nothing more.
  if (others.length && askBothWays) {
    out.push(
      'Work that is correct on its own can still break other work in the same product. Check both ways, now and',
      "whenever main moves on (`git fetch origin` brings in the other agents' work):",
      "- Could your work make false something listed here: what another task's statement promises?",
      "- Could another task's work make false something your work relies on?",
      '',
      'If so, do not quietly work around it: say what you found, and why it matters, in your commit message. The other',
      "agents see main's history when they fetch.",
      '',
    );
  }
  if (readme) out.push("## The project's README.md", '', fenced(readme), '');
  const tests = check
    ? `Run the tests before you finish: \`${check.check}\`${check.setup ? ` (after \`${check.setup}\`)` : ''}.`
    : 'Run the tests before you finish (`npm test` if there is a package.json).';
  out.push(
    '## How to work',
    '',
    ...(askBothWays
      ? [
          '0. Before you write code, work out what your approach relies on that other work could change. Check those again',
          '   each time you bring your branch up to date with main.',
        ]
      : []),
    `1. Make the statement true, with tests. ${tests}`,
    `2. Commit early and often, on your branch \`${branch}\`.`,
    '3. Put your work on main. The other agents push to the same main, so it may have moved on since you cloned it:',
    '   1. `git fetch origin`',
    '   2. Bring your branch up to date: `git rebase origin/main` (or `git merge origin/main`), and resolve any conflicts.',
    '   3. Run the tests again, and commit any fixes.',
    '   4. `git push origin HEAD:main`. If the push is rejected because main has moved on, start again at step 3.1.',
    '4. When the statement is true, the tests pass, and your work is on main, you are done. Then stop.',
    '5. If you cannot finish, say why. Then stop.',
    '',
  );
  return out.join('\n');
}

// A fence longer than any run of backticks in the text.
function fenced(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}markdown\n${text.trimEnd()}\n${fence}`;
}

// run.mjs's prompt, with the task in place of the claim and "your work is on
// main" in place of `superpose done`.
function prompt(key, brief) {
  return (
    `You are an autonomous software agent working on task ${key} of a project. ` +
    "Your current directory is your own clone of the project's git repository. Everything you need is in TASK.md, reproduced " +
    'below (it is also in this directory). Follow it exactly. Nobody will answer questions: make your own decisions ' +
    `and keep going until your work is on main (or, if you truly cannot finish, stop and say why).\n\n---\n\n${brief}`
  );
}

// CLAUDE.md and AGENTS.md files in the folders above a working copy (as run.mjs).
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

// ---- processes -------------------------------------------------------------------------------------

function killGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

// A child in its own process group (as run.mjs starts agents), its output
// streamed as text. If it exits but something it left behind still holds its
// output open, the group is ended after a grace period, so a stray background
// process cannot hang the run.
function startGroup(cmd, args, { cwd, env, onStdout, onStderr }) {
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', onStdout);
  child.stderr.on('data', onStderr);
  child.on('exit', () => {
    const t = setTimeout(() => {
      killGroup(child, 'SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    }, 10_000);
    t.unref();
    child.on('close', () => clearTimeout(t));
  });
  return child;
}

// Run a command to the end, with a time limit; output kept to its last 2 MB.
function runToEnd(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolveRun) => {
    let stdout = '';
    let stderr = '';
    let all = '';
    let timedOut = false;
    let error = null;
    const keep = (s, d) => (s.length + d.length > 4_000_000 ? (s + d).slice(-2_000_000) : s + d);
    const child = startGroup(cmd, args, {
      cwd,
      env,
      onStdout: (d) => ((stdout = keep(stdout, d)), (all = keep(all, d))),
      onStderr: (d) => ((stderr = keep(stderr, d)), (all = keep(all, d))),
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => (error = err.message));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr, all, timedOut, error });
    });
  });
}

// The environment for the project's own code (tests, the hidden check): the
// agents' environment, without npm's update check.
const checkEnv = () => agentEnv({ npm_config_update_notifier: 'false' });

// ---- the runner ------------------------------------------------------------------------------------

class PlainRunner {
  constructor(opts, plan) {
    this.opts = opts;
    this.plan = plan;
    this.tasks = plan.tasks;
    this.byKey = new Map(this.tasks.map((t) => [t.key, t]));
    this.origin = join(opts.workDir, '_origin.git');
    this.logFile = join(opts.runsDir, 'runner.log');
    this.stopping = false;
    this.slots = [];
  }

  log(name, text) {
    const line = `[${clock()}] ${name ? `${name}: ` : ''}${text}`;
    appendFileSync(this.logFile, line + '\n');
    process.stdout.write(line + '\n');
  }

  email(slot) {
    return `${slot.name}@agents.plain-git.invalid`;
  }

  async start() {
    const { opts } = this;
    const t0 = Date.now();
    mkdirSync(opts.runsDir, { recursive: true });
    mkdirSync(opts.workDir, { recursive: true });
    this.log(
      null,
      `Starting ${opts.agents} claude agent(s) on the ${this.tasks.length} tasks of ${this.plan.name} with plain git ` +
        `(shared repository ${rel(this.origin)}, transcripts in ${rel(opts.runsDir)})`,
    );
    if (this.plan.forks.length) {
      this.log(null, `warning: plan.json builds one decision two ways (lines ${this.plan.forks.join(', ')}); plain git has one main, so every claim is a task on it`);
    }
    this.seed();
    process.on('SIGINT', () => this.interrupt());
    process.on('SIGTERM', () => this.interrupt());
    this.slots = Array.from({ length: opts.agents }, (_, i) => ({ n: i + 1, name: `${opts.name}-${i + 1}`, child: null, busy: null }));
    await this.schedule();
    for (const t of this.tasks) {
      if (t.status !== 'pending') continue;
      t.status = this.stopping ? 'not started' : 'blocked';
      const waitsFor = t.requires.filter((k) => this.byKey.get(k).status !== 'done');
      if (waitsFor.length) t.waitsFor = waitsFor;
    }
    let visible = null;
    let hidden = null;
    let mainSha = null;
    let constitutionTouched = [];
    if (!this.stopping) ({ visible, hidden, mainSha, constitutionTouched } = await this.finalChecks());
    this.summarise({ t0, visible, hidden, mainSha, constitutionTouched });
  }

  // One commit on main with the scenario's seed, in a bare repository that,
  // like a protected branch on a git host, refuses force pushes and deletions.
  seed() {
    const { workDir, scenarioDir } = this.opts;
    git(workDir, ['init', '--quiet', '--bare', '--initial-branch=main', this.origin]);
    git(this.origin, ['config', 'receive.denyNonFastForwards', 'true']);
    git(this.origin, ['config', 'receive.denyDeletes', 'true']);
    const tmp = join(workDir, '_seed');
    git(workDir, ['init', '--quiet', '--initial-branch=main', tmp]);
    const seedDir = join(scenarioDir, 'seed');
    if (existsSync(seedDir)) cpSync(seedDir, tmp, { recursive: true });
    git(tmp, ['add', '-A']);
    git(tmp, ['-c', 'user.name=Plain-git planner', '-c', 'user.email=planner@plain-git.invalid', 'commit', '--quiet', '--allow-empty', '-m', `Start the ${this.plan.name} project`]);
    git(tmp, ['push', '--quiet', this.origin, 'HEAD:refs/heads/main']);
    const sha = git(tmp, ['rev-parse', 'HEAD']).stdout.trim();
    const files = lines(git(tmp, ['ls-files']).stdout).length;
    rmSync(tmp, { recursive: true, force: true });
    this.log(null, `Seeded main with ${plural(files, 'file')} from ${rel(seedDir)} at ${shortSha(sha)}`);
  }

  ready(t) {
    return t.status === 'pending' && t.requires.every((k) => this.byKey.get(k).status === 'done');
  }

  // Free slots take ready tasks in plan order; with nothing ready, wait for a
  // task in progress to end. Ends when no task is in progress and none is ready.
  async schedule() {
    for (;;) {
      if (!this.stopping) {
        for (const slot of this.slots) {
          if (slot.busy) continue;
          const task = this.tasks.find((t) => this.ready(t));
          if (!task) break;
          task.status = 'running';
          task.agent = slot.name;
          slot.busy = this.work(slot, task).finally(() => {
            slot.busy = null;
          });
        }
      }
      const busy = this.slots.map((s) => s.busy).filter(Boolean);
      if (!busy.length) return;
      await Promise.race(busy);
    }
  }

  interrupt() {
    if (this.stopping) {
      process.stdout.write('\nStopping now, without waiting.\n');
      for (const slot of this.slots) killGroup(slot.child, 'SIGKILL');
      process.exit(130);
    }
    this.stopping = true;
    this.log(null, 'Stopping: ending the agents; no new task starts (Ctrl-C again to quit at once)');
    for (const slot of this.slots) this.kill(slot, 'SIGTERM');
  }

  kill(slot, signal) {
    const child = slot.child;
    if (!child) return;
    killGroup(child, signal);
    if (signal === 'SIGTERM') {
      setTimeout(() => {
        if (slot.child === child) killGroup(child, 'SIGKILL');
      }, 10_000).unref();
    }
  }

  // One task, start to end. Never throws: a runner error fails the task.
  async work(slot, task) {
    const dir = join(this.opts.workDir, task.key);
    task.startedAt = Date.now();
    this.log(slot.name, `took ${task.key}: ${task.statement}`);
    let outcome = { ok: false, code: null, signal: null, result: null, turns: 0, cost: 0 };
    try {
      await this.prepare(slot, task, dir);
      this.log(slot.name, `cloned main at ${shortSha(task.base)} into ${rel(dir)}, on branch task/${task.key}`);
      if (!this.stopping) outcome = await this.runAgent(slot, task, dir);
      this.wrapUp(slot, task, dir, outcome);
    } catch (err) {
      task.status = 'failed';
      task.why = `the runner hit an error: ${err?.message ?? err}`;
    }
    task.endedAt = Date.now();
    task.ms = task.endedAt - task.startedAt;
    task.result = outcome.result?.subtype ?? null;
    task.cost = outcome.cost ?? 0;
    task.turns = outcome.result?.num_turns ?? outcome.turns ?? 0;
    task.exitCode = outcome.code;
    task.signal = outcome.signal;
    task.model = outcome.model ?? null;
    this.log(slot.name, `${task.key}: ${task.status}${task.why ? ` (${task.why})` : ''}`);
  }

  // A fresh clone of main on a branch task/<key>, with the agent's identity
  // and the brief, TASK.md, which git ignores (run.mjs writes CLAIM.md alike).
  async prepare(slot, task, dir) {
    rmSync(dir, { recursive: true, force: true });
    await gitAsync(this.opts.workDir, ['clone', '--quiet', this.origin, task.key]);
    git(dir, ['config', 'user.name', slot.name]);
    git(dir, ['config', 'user.email', this.email(slot)]);
    git(dir, ['checkout', '--quiet', '-b', `task/${task.key}`, '--track', 'origin/main']);
    task.base = git(dir, ['rev-parse', 'HEAD']).stdout.trim();
    appendFileSync(join(dir, '.git', 'info', 'exclude'), '\n# The plain-git runner: the brief is not part of the work\nTASK.md\n');
    const readme = join(dir, 'README.md');
    const brief = renderTaskMd(task, {
      tasks: this.tasks,
      byKey: this.byKey,
      readme: existsSync(readme) ? readFileSync(readme, 'utf8') : null,
      check: this.opts.check,
      askBothWays: this.opts.askBothWays,
      constitution: this.plan.constitution ?? [],
    });
    atomicWrite(join(dir, 'TASK.md'), brief);
  }

  transcriptPath(key) {
    const base = join(this.opts.runsDir, key);
    if (!existsSync(`${base}.jsonl`)) return `${base}.jsonl`;
    for (let i = 2; ; i++) if (!existsSync(`${base}.${i}.jsonl`)) return `${base}.${i}.jsonl`;
  }

  // Start the agent in the clone and wait for it to exit (as run.mjs does).
  runAgent(slot, task, dir) {
    const transcript = this.transcriptPath(task.key);
    task.transcript = transcript;
    const stderrLog = transcript.replace(/\.jsonl$/, '.stderr.log');
    const { cmd, args, env } = this.claudeCommand(task, dir);
    this.log(slot.name, `started a claude agent on ${task.key}; transcript ${rel(transcript)}`);
    const t0 = Date.now();
    return new Promise((resolveRun) => {
      const outcome = { ok: false, code: null, signal: null, result: null, turns: 0, cost: 0 };
      let buffer = '';
      const child = startGroup(cmd, args, {
        cwd: dir,
        env,
        onStdout: (chunk) => {
          buffer += chunk;
          let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.trim()) this.onAgentLine(slot, line, transcript, outcome);
          }
        },
        onStderr: (chunk) => appendFileSync(stderrLog, chunk),
      });
      slot.child = child;
      child.on('error', (err) => this.log(slot.name, `could not start the agent: ${err.message}`));
      child.on('close', (code, signal) => {
        if (buffer.trim()) this.onAgentLine(slot, buffer, transcript, outcome);
        slot.child = null;
        outcome.code = code;
        outcome.signal = signal;
        const r = outcome.result;
        outcome.ok = code === 0 && !this.stopping && r?.subtype === 'success' && !r?.is_error;
        task.agentMs = Date.now() - t0;
        resolveRun(outcome);
      });
    });
  }

  // run.mjs's claudeCommand without the Superpose hooks: the same flags, the
  // same settings otherwise, the same environment.
  claudeCommand(task, dir) {
    const settings = {
      // The working copy is the agent's whole world: instructions in folders
      // above it (this machine's own CLAUDE.md files) are not for it.
      claudeMdExcludes: ancestorInstructionFiles(dir),
      autoMemoryEnabled: false,
    };
    // Outside the clone, so the agent's repository holds nothing but the project.
    const settingsFile = join(this.opts.workDir, '_settings', `${task.key}.json`);
    atomicWrite(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    const args = [
      '-p',
      prompt(task.key, readFileSync(join(dir, 'TASK.md'), 'utf8')),
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

  // One line of the agent's stream-json: kept in the transcript; the init,
  // tool uses and result read as run.mjs reads them.
  onAgentLine(slot, line, transcript, outcome) {
    appendFileSync(transcript, line + '\n');
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === 'system' && event.subtype === 'init') {
      outcome.model = event.model;
    } else if (event.type === 'assistant') {
      for (const part of event.message?.content ?? []) if (part.type === 'tool_use') outcome.turns++;
    } else if (event.type === 'result') {
      outcome.result = event;
      outcome.cost = event.total_cost_usd ?? 0;
      this.log(slot.name, `agent ended: ${event.subtype}, ${event.num_turns} turns, $${(event.total_cost_usd ?? 0).toFixed(3)}`);
    }
  }

  // Done means on main: every commit on the task's branch (and wherever the
  // agent left HEAD) is in main's history. The task's commits are the agent's
  // own commits on main since the task's clone was made (a slot works on one
  // task at a time, under its own git identity).
  wrapUp(slot, task, dir, outcome) {
    git(dir, ['fetch', '--quiet', 'origin'], { check: false, timeoutMs: 120_000 });
    const main = git(dir, ['rev-parse', '--verify', 'refs/remotes/origin/main']).stdout.trim();
    const tip = (ref) => {
      const r = git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { check: false });
      return r.code === 0 ? r.stdout.trim() : null;
    };
    const tips = [...new Set([tip(`refs/heads/task/${task.key}`), tip('HEAD')].filter(Boolean))];
    task.commits = lines(git(dir, ['rev-list', '--reverse', '-F', `--author=<${this.email(slot)}>`, main, `^${task.base}`]).stdout);
    task.unpushed = tips.length ? lines(git(dir, ['rev-list', ...tips, `^${main}`]).stdout) : [];
    task.uncommitted = lines(git(dir, ['status', '--porcelain', '--untracked-files=all']).stdout).map((l) => l.slice(3));
    if (task.unpushed.length) {
      task.status = 'failed';
      task.why =
        `${plural(task.unpushed.length, 'commit')} on its branch ${task.unpushed.length === 1 ? 'is' : 'are'} not on main` +
        (this.stopping ? ' (the runner was stopped)' : '');
    } else if (!task.commits.length && !outcome.ok) {
      task.status = 'failed';
      const r = outcome.result;
      task.why = this.stopping
        ? 'the runner was stopped before the agent put any work on main'
        : r?.subtype && r.subtype !== 'success'
          ? `the agent stopped (${r.subtype}) without putting any work on main`
          : `the agent exited (code ${outcome.code}${outcome.signal ? `, ${outcome.signal}` : ''}) without putting any work on main`;
    } else {
      task.status = 'done';
      task.why = task.commits.length ? null : 'the agent changed nothing';
    }
    if (task.uncommitted.length) this.log(slot.name, `left ${plural(task.uncommitted.length, 'file')} uncommitted: ${task.uncommitted.join(', ')}`);
  }

  // A fresh checkout of main: the visible tests, then the hidden check.
  async finalChecks() {
    const checkout = join(this.opts.workDir, '_main');
    rmSync(checkout, { recursive: true, force: true });
    await gitAsync(this.opts.workDir, ['clone', '--quiet', '--branch', 'main', this.origin, '_main']);
    const mainSha = git(checkout, ['rev-parse', 'HEAD']).stdout.trim();
    this.log(null, `checked out main at ${shortSha(mainSha)} into ${rel(checkout)}`);
    const visible = await this.visibleTests(checkout);
    const script = this.opts.hiddenCheck ?? join(this.opts.scenarioDir, 'hidden', 'check.mjs');
    const hidden = existsSync(script) ? await this.hiddenCheck(script, checkout) : { status: 'none', why: 'the scenario has no hidden/check.mjs' };
    // Nothing stops a plain-git agent from editing the constitution: record
    // every commit on main after the seed that touched it.
    const constitutionTouched = git(checkout, ['log', '--format=%h%x09%an%x09%s', 'HEAD', '--', 'constitution/'], { check: false })
      .stdout.split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, author, subject] = l.split('\t');
        return { sha, author, subject };
      })
      .filter((c) => !/^Start the /.test(c.subject ?? ''));
    if (constitutionTouched.length) this.log(null, `constitution/ was changed on main by: ${constitutionTouched.map((c) => `${c.sha} (${c.author})`).join(', ')}`);
    return { visible, hidden, mainSha, constitutionTouched };
  }

  // The project's tests on the checkout, as runner/final-check.mjs runs them
  // for the Superpose arm: the declared setup, or else `npm install`, then the
  // declared check, or else `npm test`; each step bounded.
  async visibleTests(checkout) {
    const hasPackage = existsSync(join(checkout, 'package.json'));
    const check = this.opts.check;
    const setup = check?.setup ?? (hasPackage ? 'npm install --no-audit --no-fund' : null);
    const command = check?.check ?? (hasPackage ? 'npm test' : null);
    if (!command) return { status: 'none', pass: null, detail: 'the scenario declares no tests' };
    const seconds = Math.max(FINAL_TIMEOUT, check?.timeoutSeconds ?? 0);
    const logFile = join(this.opts.runsDir, 'visible.log');
    const t0 = Date.now();
    for (const [step, cmd] of [...(setup ? [['setup', setup]] : []), ['check', command]]) {
      this.log(null, `visible tests: $ ${cmd}`);
      const r = await runToEnd('sh', ['-c', cmd], { cwd: checkout, env: checkEnv(), timeoutMs: seconds * 1000 });
      appendFileSync(logFile, `$ ${cmd}\n${r.all}${r.all.endsWith('\n') ? '' : '\n'}`);
      if (step === 'setup' && r.code === 0 && !r.timedOut && !r.error) continue;
      const status = r.error ? 'error' : r.code === 0 && !r.timedOut ? 'pass' : 'fail';
      this.log(null, `visible tests: ${status}${step === 'setup' ? ' (the setup failed)' : ''}${r.timedOut ? ` (timed out after ${seconds} s)` : ''}`);
      return {
        status,
        pass: status === 'pass',
        command,
        setup,
        step,
        exitCode: r.code,
        timedOut: r.timedOut,
        ms: Date.now() - t0,
        log: logFile,
        tail: tail(r.all, 3000),
        ...(r.error ? { detail: r.error } : {}),
      };
    }
  }

  // node <scenario>/hidden/check.mjs <checkout>, which prints one JSON line
  // {"hidden": "pass" | "fail" | "error", ...}; kept as printed, with `status`.
  async hiddenCheck(script, checkout) {
    this.log(null, `hidden check: node ${rel(script)} ${rel(checkout)}`);
    const t0 = Date.now();
    const r = await runToEnd(process.execPath, [script, checkout], { cwd: checkout, env: checkEnv(), timeoutMs: FINAL_TIMEOUT * 1000 });
    const logFile = join(this.opts.runsDir, 'hidden.log');
    writeFileSync(logFile, r.all);
    let parsed = null;
    for (const line of r.timedOut ? [] : lines(r.stdout).reverse()) {
      try {
        const v = JSON.parse(line);
        if (v && typeof v === 'object' && typeof v.hidden === 'string') {
          parsed = v;
          break;
        }
      } catch {
        // not the result line
      }
    }
    const detail = r.timedOut
      ? `the hidden check did not finish within ${FINAL_TIMEOUT} s`
      : r.error ?? `the hidden check printed no {"hidden": ...} line (exit code ${r.code}): ${tail(r.stderr.trim() || r.stdout.trim(), 300)}`;
    const result = { ...(parsed ?? { hidden: 'error', detail }), status: parsed?.hidden ?? 'error', exitCode: r.code, ms: Date.now() - t0, log: logFile };
    this.log(null, `hidden check: ${result.status}`);
    return result;
  }

  summarise({ t0, visible, hidden, mainSha, constitutionTouched = [] }) {
    const { opts } = this;
    const count = (status) => this.tasks.filter((t) => t.status === status).length;
    const done = count('done');
    const outcome = this.stopping ? 'interrupted' : done === this.tasks.length ? 'done' : 'stuck';
    const failed = this.tasks.filter((t) => t.status === 'failed');
    const blocked = this.tasks.filter((t) => t.status === 'blocked');
    const verdict =
      outcome === 'done'
        ? `All ${plural(this.tasks.length, 'task')} are done.`
        : outcome === 'interrupted'
          ? `Interrupted: ${done} of ${plural(this.tasks.length, 'task')} done.`
          : `Stopped: nothing can progress. ${done} of ${plural(this.tasks.length, 'task')} done; ` +
            [
              failed.length && `failed: ${failed.map((t) => t.key).join(', ')}`,
              blocked.length && `blocked: ${blocked.map((t) => `${t.key} (waits for ${(t.waitsFor ?? []).join(', ')})`).join(', ')}`,
            ]
              .filter(Boolean)
              .join('; ') +
            '.';
    const tasks = this.tasks.map((t) => ({
      key: t.key,
      agent: t.agent ?? null,
      status: t.status,
      why: t.why ?? null,
      cost: t.cost ?? 0,
      turns: t.turns ?? 0,
      ms: t.ms ?? 0,
      agentMs: t.agentMs ?? 0,
      commits: t.commits ?? [],
      startedAt: t.startedAt ?? null,
      endedAt: t.endedAt ?? null,
      base: t.base ?? null,
      requires: t.requires,
      ...(t.waitsFor ? { waitsFor: t.waitsFor } : {}),
      result: t.result ?? null,
      exitCode: t.exitCode ?? null,
      signal: t.signal ?? null,
      model: t.model ?? null,
      unpushed: t.unpushed ?? [],
      uncommitted: t.uncommitted ?? [],
      transcript: t.transcript ?? null,
    }));
    const sum = (f) => tasks.reduce((a, t) => a + (t[f] ?? 0), 0);
    const totals = {
      tasks: tasks.length,
      done,
      failed: failed.length,
      blocked: blocked.length,
      notStarted: count('not started'),
      cost: sum('cost'),
      turns: sum('turns'),
      commits: tasks.reduce((a, t) => a + t.commits.length, 0),
      ms: sum('ms'),
      wallMs: Date.now() - t0,
    };
    const summary = {
      arm: 'plain-git',
      scenario: this.plan.name,
      scenarioDir: opts.scenarioDir,
      agents: opts.agents,
      model: opts.model ?? null,
      maxTurns: opts.maxTurns ?? null,
      effort: opts.effort ?? null,
      budget: opts.budget ?? null,
      startedAt: t0,
      endedAt: Date.now(),
      outcome,
      verdict,
      totals,
      tasks,
      main: mainSha,
      constitutionTouched,
      visible,
      hidden,
      repo: this.origin,
      work: opts.workDir,
      runs: opts.runsDir,
    };
    writeFileSync(join(opts.runsDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

    const out = ['', `Summary for ${plural(opts.agents, 'agent')} on ${this.plan.name}, plain git:`];
    const width = Math.max(...tasks.map((t) => t.key.length));
    for (const t of tasks) {
      out.push(
        `  ${(t.agent ?? '-').padEnd(12)} ${t.key.padEnd(width)}  ${t.status.padEnd(11)} ${(t.agent ? formatDuration(t.ms) : '').padStart(6)}` +
          (t.agent ? `  turns ${t.turns}  $${t.cost.toFixed(3)}  ${plural(t.commits.length, 'commit')}` : '') +
          (t.why ? `  (${t.why})` : '') +
          (t.waitsFor ? `  waits for ${t.waitsFor.join(', ')}` : '') +
          (t.transcript ? `  ${rel(t.transcript)}` : ''),
      );
    }
    out.push(`  ${verdict}`);
    if (visible) out.push(`  Visible tests on main ${shortSha(mainSha)}${visible.command ? ` (${visible.command})` : ''}: ${visible.status}`);
    if (hidden) out.push(`  Hidden check: ${hidden.status}`);
    out.push(
      `  Total: $${totals.cost.toFixed(3)}, ${plural(totals.turns, 'turn')}, ${plural(totals.commits, 'commit')}, ` +
        `wall ${formatDuration(totals.wallMs)}`,
      `  Summary: ${rel(join(opts.runsDir, 'summary.json'))}`,
    );
    process.stdout.write(out.join('\n') + '\n');
  }
}

// ---- main --------------------------------------------------------------------------------------------

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  try {
    if (!positionals[0]) throw new UsageError('Give the scenario directory, e.g. scenarios/tiny.');
    if (positionals.length > 1) throw new UsageError(`Unexpected argument: ${positionals[1]}`);
    const scenarioDir = resolve(positionals[0]);
    const plan = readPlan(scenarioDir);
    const agents = Number(values.agents);
    if (!Number.isInteger(agents) || agents < 1) throw new UsageError('--agents must be a positive whole number.');
    const maxTurns = values['max-turns'] !== undefined ? Number(values['max-turns']) : undefined;
    if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) throw new UsageError('--max-turns must be a positive whole number.');
    const budget = values.budget !== undefined ? Number(values.budget) : undefined;
    if (budget !== undefined && !(budget > 0)) throw new UsageError('--budget must be a positive number of dollars.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(values.name)) throw new UsageError('--name must be letters, digits, - and _.');
    const run = `plain-${basename(scenarioDir)}-${stamp()}`;
    const workDir = resolve(values.work ?? join(REPO_DIR, 'work', run));
    const runsDir = resolve(values.runs ?? join(REPO_DIR, 'runs', run));
    if (existsSync(workDir) && readdirSync(workDir).length) {
      throw new UsageError(`${workDir} is not empty. Give a new or empty --work directory: the shared repository and the clones go there.`);
    }
    if (existsSync(join(runsDir, 'summary.json'))) {
      throw new UsageError(`${runsDir} already holds a run (summary.json). Give a new --runs directory.`);
    }
    // A path is taken from here; a bare name is looked up on the PATH.
    const claudeBin = values.claude.includes('/') ? resolve(values.claude) : values.claude;
    const probe = spawnSync(claudeBin, ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) throw new UsageError(`Claude Code (\`${values.claude}\`) was not found. Install it and log in, or pass --claude <a stub>.`);
    const opts = {
      scenarioDir,
      agents,
      model: values.model,
      maxTurns,
      effort: values.effort,
      budget,
      name: values.name,
      workDir,
      runsDir,
      claudeBin,
      check: checkConfig(join(scenarioDir, 'seed')),
      askBothWays: values['ask-both-ways'],
      hiddenCheck: values.hidden ? resolve(values.hidden) : undefined,
    };
    const runner = new PlainRunner(opts, plan);
    await runner.start();
    return runner.stopping ? 130 : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`plain run failed: ${err?.stack ?? err}\n`);
    return 1;
  }
}

process.exitCode = await main();
