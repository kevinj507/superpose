import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT_FETCH_FAILED, FETCH_SCRIPT, RUN_SCRIPT } from '../src/core/checks';
import { MERGE_SCRIPT, PROMOTE_SCRIPT } from '../src/core/landing';

// Plain JavaScript (the type check targets the Workers runtime, which has no
// child processes). The container scripts, run for real with sh on this machine (the check
// itself, without git), so a quoting slip shows up here and not in a
// container on the account.

function runScript(env) {
  const dir = mkdtempSync(join(tmpdir(), 'sp-run-'));
  try {
    const script = join(dir, 'run.sh');
    writeFileSync(script, RUN_SCRIPT.replaceAll('/work', join(dir, 'w')).replaceAll('/tmp/out.log', join(dir, 'out.log')));
    execFileSync('mkdir', ['-p', join(dir, 'w')]);
    const r = spawnSync('sh', [script], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the container scripts', () => {
  it('parse', () => {
    for (const s of [FETCH_SCRIPT, RUN_SCRIPT, MERGE_SCRIPT, PROMOTE_SCRIPT]) {
      expect(spawnSync('sh', ['-n'], { input: s }).status).toBe(0);
    }
  });

  it('the check passes on success, fails with the code, and stops after a failing setup', () => {
    expect(runScript({ SETUP: 'echo installing', CHECK: 'echo ok', TIMEOUT: '5' })).toMatchObject({ code: 0, out: expect.stringContaining('ok') });
    expect(runScript({ SETUP: '', CHECK: 'exit 3', TIMEOUT: '5' }).code).toBe(3);
    const broken = runScript({ SETUP: 'echo broke; exit 7', CHECK: 'echo never', TIMEOUT: '5' });
    expect(broken.code).toBe(7);
    expect(broken.out).not.toContain('never');
  });

  it('a check that runs too long is stopped with the timeout code', () => {
    expect(runScript({ SETUP: '', CHECK: 'sleep 5', TIMEOUT: '1' }).code).toBe(124);
  });

  it('keeps only the end of a flood of output', () => {
    const r = runScript({ SETUP: '', CHECK: 'yes | head -c 500000; echo tail-marker', TIMEOUT: '5' });
    expect(r.code).toBe(0);
    expect(r.out.length).toBeLessThan(70_000);
    expect(r.out).toContain('tail-marker');
  });

  it('the run step is never given a token', () => {
    expect(RUN_SCRIPT).not.toMatch(/TOKEN/);
  });
});

// The merge script against real bare repos on disk (git ignores the
// Authorization header for local paths).
function mergeIn(dir, env) {
  const script = join(dir, 'merge.sh');
  writeFileSync(script, MERGE_SCRIPT.replaceAll('/work', join(dir, 'w')));
  const r = spawnSync('sh', [script], {
    env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', LINE_TOKEN: 'x', CLAIM_TOKEN: 'x', MESSAGE: 'Land c1', STAGING: 'refs/heads/superpose/landing-c1', ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout };
}

function bareWithCommit(dir, name, file) {
  const work = join(dir, `${name}-work`);
  const git = (...args) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  writeFileSync(join(work, file), name);
  git('add', '.');
  git('commit', '-q', '-m', name);
  execFileSync('git', ['clone', '-q', '--bare', work, join(dir, `${name}.git`)]);
  return { remote: join(dir, `${name}.git`), sha: git('rev-parse', 'HEAD') };
}

describe('the merge script', () => {
  it('lands a claim on an empty line as the line\'s first history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-merge-'));
    try {
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'line.git')]);
      const claim = bareWithCommit(dir, 'claim', 'a.txt');
      const r = mergeIn(dir, { LINE_REMOTE: join(dir, 'line.git'), CLAIM_REMOTE: claim.remote, SHA: claim.sha });
      expect(r).toMatchObject({ code: 0, out: expect.stringContaining(`MERGED ${claim.sha}`) });
      expect(r.out).not.toContain('BASE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a line it cannot read as a failed fetch, never as an empty line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-merge-'));
    try {
      const claim = bareWithCommit(dir, 'claim', 'a.txt');
      const r = mergeIn(dir, { LINE_REMOTE: join(dir, 'no-such-line.git'), CLAIM_REMOTE: claim.remote, SHA: claim.sha });
      expect(r.code).toBe(EXIT_FETCH_FAILED);
      expect(r.out).not.toContain('MERGED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the playground bundle', () => {
  it('matches the runner and the world scenario on disk (run npm run build:play after changing them)', async () => {
    const { readFileSync } = await import('node:fs');
    const { PLAY_FILES } = await import('../src/play-bundle');
    const root = new URL('..', import.meta.url).pathname;
    for (const [path, text] of Object.entries(PLAY_FILES)) expect(readFileSync(join(root, path), 'utf8'), path).toBe(text);
    expect(Object.keys(PLAY_FILES)).toContain('runner/play-director.mjs');
  });
});
