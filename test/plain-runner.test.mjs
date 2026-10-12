// runner/plain.mjs, the plain-git arm of the experiment, run end to end with a
// stub in place of Claude Code (test/fixtures/stub-claude.mjs): no model, no
// network. Plain JavaScript, like the runner.

import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLAIN = join(ROOT, 'runner', 'plain.mjs');
const STUB = join(ROOT, 'test', 'fixtures', 'stub-claude.mjs');
const TINY = join(ROOT, 'scenarios', 'tiny');

const made = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

// A fresh folder, with an executable that starts the stub (so the test does
// not depend on the stub file keeping its executable bit).
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'plain-runner-'));
  made.push(dir);
  const claude = join(dir, 'claude');
  writeFileSync(claude, `#!/bin/sh\nexec '${process.execPath}' '${STUB}' "$@"\n`, { mode: 0o755 });
  return { dir, claude, work: join(dir, 'work'), runs: join(dir, 'runs') };
}

// npm (the stub's tests, the end-of-run `npm install` and `npm test`) stays off the network.
function runPlain(args, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [PLAIN, ...args], {
      cwd: ROOT,
      env: { ...process.env, npm_config_offline: 'true', npm_config_update_notifier: 'false', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolveRun({ code, out }));
  });
}

const readSummary = (runs) => JSON.parse(readFileSync(join(runs, 'summary.json'), 'utf8'));
const events = (transcript) => readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const stubReport = (transcript) => events(transcript).find((e) => e.type === 'result').stub;
const gitOk = (repo, ...args) => {
  try {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// Each run takes a few seconds; the generous time limits are for a busy machine.
describe('the plain-git runner', () => {
  it('works every task of scenarios/tiny onto main with two agents, in dependency order', async () => {
    const { claude, work, runs } = sandbox();
    const r = await runPlain([TINY, '--agents', '2', '--model', 'haiku', '--max-turns', '7', '--work', work, '--runs', runs, '--claude', claude], {
      // slugify and truncate start together; make them push at the same moment.
      STUB_PUSH_BARRIER: join(work, '..', 'barrier'),
      STUB_PUSH_BARRIER_TASKS: 'slugify,truncate',
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('All 4 tasks are done.');
    const summary = readSummary(runs);
    const by = Object.fromEntries(summary.tasks.map((t) => [t.key, t]));
    const origin = summary.repo;

    expect(summary.outcome).toBe('done');
    expect(summary.tasks.map((t) => [t.key, t.status])).toEqual([
      ['slugify', 'done'],
      ['truncate', 'done'],
      ['word-count', 'done'],
      ['unique-slug', 'done'],
    ]);

    // unique-slug requires slugify: it started only once slugify's work was on
    // main, and its clone started from a main that had it.
    expect(by['unique-slug'].startedAt).toBeGreaterThanOrEqual(by.slugify.endedAt);
    expect(by.slugify.commits).toHaveLength(1);
    expect(gitOk(origin, 'merge-base', '--is-ancestor', by.slugify.commits[0], by['unique-slug'].base)).toBe(true);

    // main holds every task's commit.
    expect(summary.main).toBe(execFileSync('git', ['-C', origin, 'rev-parse', 'main'], { encoding: 'utf8' }).trim());
    for (const t of summary.tasks) {
      expect(t.commits, t.key).toHaveLength(1);
      expect(gitOk(origin, 'merge-base', '--is-ancestor', t.commits[0], 'main'), t.key).toBe(true);
    }

    // slugify and truncate pushed from the same main at nearly the same time:
    // one got there first, the other was rejected, rebased, and pushed again.
    const [a, b] = [stubReport(by.slugify.transcript), stubReport(by.truncate.transcript)];
    const winner = a.rejected === 0 ? a : b;
    const loser = winner === a ? b : a;
    expect(winner).toMatchObject({ rejected: 0, rebases: 0, pushed: true });
    expect(loser.rejected).toBeGreaterThanOrEqual(1);
    expect(loser.rebases).toBeGreaterThanOrEqual(1);
    expect(loser.pushed).toBe(true);
    expect(gitOk(origin, 'merge-base', '--is-ancestor', winner.head, loser.head)).toBe(true);

    // The agents were started the way run.mjs starts Claude Code, minus the Superpose hooks.
    const init = events(by.slugify.transcript)[0];
    expect(init.type).toBe('system');
    expect(init.stub_args).toEqual(
      expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--strict-mcp-config', '--no-session-persistence', '--model', 'haiku', '--max-turns', '7']),
    );
    expect(init.stub_args[init.stub_args.indexOf('--disallowed-tools') + 1]).toContain('EnterWorktree');
    const settings = JSON.parse(readFileSync(init.stub_args[init.stub_args.indexOf('--settings') + 1], 'utf8'));
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.claudeMdExcludes.length).toBeGreaterThan(0);
    expect(settings.hooks).toBeUndefined();

    // The brief: the task, its expected files, what it builds on, the other
    // work, the README, the tests, the plain-git workflow, and no Superpose.
    // Git ignores it.
    const brief = readFileSync(join(work, 'unique-slug', 'TASK.md'), 'utf8');
    for (const text of [
      '# Task unique-slug',
      '- `src/unique-slug.js`',
      '- `slugify` (done',
      '## Other work in this project',
      '- `truncate` (',
      'Small text helpers for Node 22',
      '1. Make the statement true, with tests. Run the tests before you finish: `npm test`.',
      'git push origin HEAD:main',
    ]) {
      expect(brief).toContain(text);
    }
    expect(brief).not.toMatch(/superpose/i);
    // The baseline asks nothing about assumptions; only --ask-both-ways does.
    expect(brief).not.toContain('Check both ways');
    expect(brief).not.toContain('work out what your approach relies on');
    expect(gitOk(join(work, 'unique-slug'), 'check-ignore', '--quiet', 'TASK.md')).toBe(true);

    // What was recorded.
    expect(summary.totals).toMatchObject({ tasks: 4, done: 4, failed: 0, blocked: 0, cost: 0, turns: 4, commits: 4 });
    for (const t of summary.tasks) expect(t, t.key).toMatchObject({ agent: expect.stringMatching(/^claude-[12]$/), cost: 0, turns: 1, result: 'success' });
    expect(summary.tasks.every((t) => t.ms > 0)).toBe(true);
    expect(summary.visible).toMatchObject({ status: 'pass', pass: true, setup: 'npm install --no-audit --no-fund', command: 'npm test', exitCode: 0 });
    expect(summary.hidden).toMatchObject({ status: 'none' });
  }, 120_000);

  it('stops when nothing can progress: work left off main fails its task, which blocks the tasks that need it', async () => {
    const { dir, claude, work, runs } = sandbox();
    // tiny, with a hidden check that wants every task's file.
    const scenario = join(dir, 'scenario');
    cpSync(TINY, scenario, { recursive: true });
    mkdirSync(join(scenario, 'hidden'));
    writeFileSync(
      join(scenario, 'hidden', 'check.mjs'),
      `import { existsSync } from 'node:fs';
import { join } from 'node:path';
const checkout = process.argv[2];
const missing = ['slugify', 'truncate', 'word-count', 'unique-slug'].map((k) => 'src/' + k + '.js').filter((f) => !existsSync(join(checkout, f)));
console.log('looked in ' + checkout);
console.log(JSON.stringify({ hidden: missing.length ? 'fail' : 'pass', missing }));
`,
    );
    // slugify's agent commits, never pushes, and says it succeeded.
    const r = await runPlain([scenario, '--agents', '2', '--work', work, '--runs', runs, '--claude', claude], { STUB_FAIL_TASKS: 'slugify' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Stopped: nothing can progress');
    const summary = readSummary(runs);
    const by = Object.fromEntries(summary.tasks.map((t) => [t.key, t]));

    expect(summary.outcome).toBe('stuck');
    expect(summary.tasks.map((t) => [t.key, t.status])).toEqual([
      ['slugify', 'failed'],
      ['truncate', 'done'],
      ['word-count', 'done'],
      ['unique-slug', 'blocked'],
    ]);
    expect(by.slugify).toMatchObject({ result: 'success', commits: [], why: expect.stringMatching(/not on main/) });
    expect(by.slugify.unpushed).toHaveLength(1);
    expect(by['unique-slug']).toMatchObject({ agent: null, waitsFor: ['slugify'], commits: [], transcript: null });
    expect(summary.totals).toMatchObject({ tasks: 4, done: 2, failed: 1, blocked: 1, commits: 2 });
    expect(summary.visible.status).toBe('pass');
    expect(summary.hidden).toMatchObject({ status: 'fail', hidden: 'fail', missing: ['src/slugify.js', 'src/unique-slug.js'], exitCode: 0 });
  }, 120_000);

  it('asks both ways only in the control arm (--ask-both-ways)', async () => {
    const { claude, work, runs } = sandbox();
    const r = await runPlain([TINY, '--agents', '1', '--ask-both-ways', '--work', work, '--runs', runs, '--claude', claude]);
    expect(r.code).toBe(0);
    const brief = readFileSync(join(work, 'unique-slug', 'TASK.md'), 'utf8');
    expect(brief).toContain("Could another task's work make false something your work relies on?");
    expect(brief).toContain('0. Before you write code, work out what your approach relies on');
  }, 120_000);

  it('refuses a work directory that is not empty', async () => {
    const { claude, work, runs } = sandbox();
    mkdirSync(work);
    writeFileSync(join(work, 'left-over'), '');
    const r = await runPlain([TINY, '--work', work, '--runs', runs, '--claude', claude]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('is not empty');
  });
});
