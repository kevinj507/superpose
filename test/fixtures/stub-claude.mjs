#!/usr/bin/env node
// A stand-in for `claude -p` that runner/plain.mjs can start instead of Claude
// Code (--claude test/fixtures/stub-claude.mjs): no model, no network, no cost.
//
// It accepts the flags the runners pass to Claude Code, and refuses any other,
// so a wrong flag fails loudly. From the prompt it reads the task key, the
// first expected file and the test command, then does what the prompt asks,
// mechanically: a small commit on its branch, the tests, then `git fetch
// origin`, a rebase onto origin/main if main has moved, the tests again, and
// `git push origin HEAD:main`, fetching and rebasing again whenever the push is
// rejected. It prints stream-json the way `claude -p --output-format
// stream-json --verbose` does: an init event, an assistant event with a
// tool_use for every command, and a result event (total_cost_usd 0,
// num_turns 1) that also says what it did, under `stub`.
//
// Knobs for tests, in the environment:
//   STUB_PUSH_BARRIER=<dir> with STUB_PUSH_BARRIER_TASKS=<key>,<key>,...
//       those tasks wait for one another after fetching main and before their
//       first push, so they push at nearly the same moment and all but one
//       are rejected and must rebase
//   STUB_FAIL_TASKS=<key>,...
//       those tasks commit but never push, and still report success: the
//       runner must look at main, not take the agent's word

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const started = Date.now();
const session = `stub-${process.pid}-${started}`;
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = (name) => (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      print: { type: 'boolean', short: 'p' },
      version: { type: 'boolean' },
      'output-format': { type: 'string' },
      verbose: { type: 'boolean' },
      'dangerously-skip-permissions': { type: 'boolean' },
      settings: { type: 'string' },
      'strict-mcp-config': { type: 'boolean' },
      'no-session-persistence': { type: 'boolean' },
      'disallowed-tools': { type: 'string' },
      model: { type: 'string' },
      'max-turns': { type: 'string' },
      effort: { type: 'string' },
      'max-budget-usd': { type: 'string' },
    },
  });
} catch (err) {
  process.stderr.write(`stub-claude: ${err.message}\n`);
  process.exit(2);
}
const { values, positionals } = parsed;
if (values.version) {
  process.stdout.write('0.0.0 (stub-claude, no model)\n');
  process.exit(0);
}

const prompt = positionals.join('\n');
const dir = process.cwd();
emit({
  type: 'system',
  subtype: 'init',
  cwd: dir,
  session_id: session,
  model: values.model ?? 'stub',
  tools: ['Bash'],
  // Every argument but the prompt, so a test can see how the agent was started.
  stub_args: process.argv.slice(2).filter((a) => !positionals.includes(a)),
});

const key = /^# Task (\S+)/m.exec(prompt)?.[1];
const files = [...(/## Files this task is expected to change\n\n((?:- `[^`]+`\n)+)/.exec(prompt)?.[1] ?? '').matchAll(/- `([^`]+)`/g)].map((m) => m[1]);
const testCommand = /Run the tests before you finish: `([^`]+)`/.exec(prompt)?.[1];

let tools = 0;
function run(cmd, args) {
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `stub-${++tools}`, name: 'Bash', input: { command: [cmd, ...args].join(' ') } }] } });
  const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', npm_config_update_notifier: 'false' } });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}
const git = (...args) => run('git', args);
const tests = () => !testCommand || run('sh', ['-c', testCommand]).code === 0;

const did = { key, file: null, rebases: 0, pushes: 0, rejected: 0, pushed: false, head: null };
function finish(ok, text) {
  emit({
    type: 'result',
    subtype: ok ? 'success' : 'error_during_execution',
    is_error: !ok,
    num_turns: 1,
    total_cost_usd: 0,
    duration_ms: Date.now() - started,
    session_id: session,
    result: text,
    stub: did,
  });
  process.exitCode = ok ? 0 : 1;
}

// Wait until every task named in the barrier has arrived (at most a minute,
// so a slow, busy machine still gets its simultaneous pushes).
async function barrier() {
  const at = process.env.STUB_PUSH_BARRIER;
  const tasks = list('STUB_PUSH_BARRIER_TASKS');
  if (!at || !tasks.includes(key)) return;
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, key), '');
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(20)) {
    if (tasks.every((t) => existsSync(join(at, t)))) return;
  }
}

async function work() {
  if (!key) return finish(false, 'The prompt names no task ("# Task <key>").');
  const file = files.find((f) => !f.includes('*')) ?? `stub-${key}.txt`;
  did.file = file;
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  appendFileSync(join(dir, file), `${/\.[cm]?[jt]s$/.test(file) ? '// ' : ''}${key}: a small change by the stub agent\n`);
  git('add', '--', file);
  const committed = git('commit', '--quiet', '-m', `Work on ${key}`);
  if (committed.code !== 0) return finish(false, `Could not commit: ${committed.out}`);
  if (!tests()) return finish(false, 'The tests fail on my branch.');
  if (list('STUB_FAIL_TASKS').includes(key)) return finish(true, `Committed ${file} on my branch. Done.`);

  for (let attempt = 1; ; attempt++) {
    if (attempt > 20) return finish(false, `Gave up after ${did.rejected} rejected pushes.`);
    const fetched = git('fetch', '--quiet', 'origin');
    if (fetched.code !== 0) return finish(false, `git fetch failed: ${fetched.out}`);
    if (git('merge-base', '--is-ancestor', 'origin/main', 'HEAD').code !== 0) {
      const rebased = git('rebase', 'origin/main');
      if (rebased.code !== 0) {
        git('rebase', '--abort');
        return finish(false, `Rebasing onto origin/main conflicts: ${rebased.out}`);
      }
      did.rebases++;
      if (!tests()) return finish(false, 'The tests fail after rebasing onto origin/main.');
    }
    if (attempt === 1) await barrier();
    did.pushes++;
    if (git('push', '--quiet', 'origin', 'HEAD:main').code === 0) break;
    did.rejected++;
    await sleep(10 + Math.random() * 40);
  }
  git('fetch', '--quiet', 'origin');
  did.head = git('rev-parse', 'HEAD').out;
  did.pushed = git('merge-base', '--is-ancestor', 'HEAD', 'origin/main').code === 0;
  if (!did.pushed) return finish(false, 'My push went through, but my work is not on main.');
  finish(true, `Task ${key} is on main at ${did.head.slice(0, 7)} (${did.rebases} rebase(s), ${did.rejected} rejected push(es)).`);
}

await work();
