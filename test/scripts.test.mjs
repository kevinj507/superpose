import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT_FETCH_FAILED, EXIT_MERGE_CONFLICT, FETCH_SCRIPT, RUN_SCRIPT } from '../src/core/checks';
import { MERGE_SCRIPT, PROMOTE_SCRIPT } from '../src/core/landing';
import { PAIR_MERGE_SCRIPT, PAIR_RUN_SCRIPT, pairResult } from '../src/core/pair';

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

// The gate on combinations, against real repos on disk: the merge step makes
// the pair and a worktree per landing with the head merged in; the run step
// runs the constitution's checks on the pair and, when one breaks, finds the
// partner among the landings.
function pairMerge(dir, env) {
  const script = join(dir, 'pair-merge.sh');
  writeFileSync(script, PAIR_MERGE_SCRIPT.replaceAll('/work', join(dir, 'w')));
  const r = spawnSync('sh', [script], {
    env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', LINE_TOKEN: 'x', CLAIM_TOKEN: 'x', CANDIDATES: '', ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function pairRun(dir, env) {
  const script = join(dir, 'pair-run.sh');
  // /tmp/ first: the sandbox itself lives under /tmp, so the other order would
  // rewrite the paths it has just put in.
  writeFileSync(script, PAIR_RUN_SCRIPT.replaceAll('/tmp/', `${join(dir, 'tmp')}/`).replaceAll('/work', join(dir, 'w')));
  execFileSync('mkdir', ['-p', join(dir, 'tmp')]);
  const r = spawnSync('sh', [script], { env: { PATH: process.env.PATH, SETUP: '', TIMEOUT: '20', CANDIDATES: '', ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// A line with a seed and one landing, and a claim forked at the seed with a
// commit of its own.
function lineAndClaim(dir) {
  const work = join(dir, 'line-work');
  const git = (...args) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  writeFileSync(join(work, 'seed.txt'), 'seed');
  git('add', '.');
  git('commit', '-q', '-m', 'Start');
  const seed = git('rev-parse', 'HEAD');
  const claimWork = join(dir, 'claim-work');
  execFileSync('git', ['clone', '-q', work, claimWork]);
  writeFileSync(join(work, 'pricing.txt'), 'prices move');
  git('add', '.');
  git('commit', '-q', '-m', 'Land c3');
  const m3 = git('rev-parse', 'HEAD');
  execFileSync('git', ['clone', '-q', '--bare', work, join(dir, 'line.git')]);
  const cgit = (...args) => execFileSync('git', ['-C', claimWork, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  writeFileSync(join(claimWork, 'pages.txt'), 'pages cached');
  cgit('add', '.');
  cgit('commit', '-q', '-m', 'c2 work');
  execFileSync('git', ['clone', '-q', '--bare', claimWork, join(dir, 'claim.git')]);
  return { line: join(dir, 'line.git'), claim: join(dir, 'claim.git'), seed, m3, sha: cgit('rev-parse', 'HEAD') };
}

describe('the pair scripts', () => {
  it('parse', () => {
    for (const s of [PAIR_MERGE_SCRIPT, PAIR_RUN_SCRIPT]) expect(spawnSync('sh', ['-n'], { input: s }).status).toBe(0);
  });

  it('the merge step makes the pair and a worktree per landing, with no token in the run step', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-pair-'));
    try {
      const w = lineAndClaim(dir);
      const r = pairMerge(dir, { LINE_REMOTE: w.line, CLAIM_REMOTE: w.claim, SHA: w.sha, CANDIDATES: `c3=${w.m3}` });
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain(`BASE ${w.m3}`);
      expect(r.out).toMatch(/MERGED [0-9a-f]{40}/);
      expect(r.out).toContain('CAND c3 ok');
      // The pair holds both sides' work; the candidate worktree is c3's landing plus the head.
      expect(execFileSync('ls', [join(dir, 'w')], { encoding: 'utf8' })).toContain('pages.txt');
      expect(execFileSync('ls', [join(dir, 'w')], { encoding: 'utf8' })).toContain('pricing.txt');
      expect(execFileSync('ls', [join(dir, 'w-c3')], { encoding: 'utf8' })).toContain('pages.txt');
      expect(PAIR_RUN_SCRIPT).not.toMatch(/TOKEN/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an empty line is skipped, and a line that cannot be read is a failed fetch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-pair-'));
    try {
      const w = lineAndClaim(dir);
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'empty.git')]);
      expect(pairMerge(dir, { LINE_REMOTE: join(dir, 'empty.git'), CLAIM_REMOTE: w.claim, SHA: w.sha })).toMatchObject({ code: 0, out: expect.stringContaining('EMPTY LINE') });
      expect(pairMerge(dir, { LINE_REMOTE: join(dir, 'nope.git'), CLAIM_REMOTE: w.claim, SHA: w.sha }).code).toBe(EXIT_FETCH_FAILED);
      // Without the merge step's marker the run step does nothing.
      expect(pairRun(dir, { CHECKS: 'x\ttrue' })).toMatchObject({ code: 0, out: expect.stringContaining('PAIR SKIPPED') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a conflict with the line is reported with its files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-pair-'));
    try {
      const w = lineAndClaim(dir);
      // The claim changes pricing.txt too, differently from the landing.
      const claimWork = join(dir, 'claim-work');
      writeFileSync(join(claimWork, 'pricing.txt'), 'prices are fixed');
      execFileSync('git', ['-C', claimWork, 'add', '.']);
      execFileSync('git', ['-C', claimWork, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c2 conflicts']);
      const sha = execFileSync('git', ['-C', claimWork, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['-C', claimWork, 'push', '-q', join(dir, 'claim.git'), 'HEAD:main']);
      const r = pairMerge(dir, { LINE_REMOTE: w.line, CLAIM_REMOTE: w.claim, SHA: sha });
      expect(r.code).toBe(EXIT_MERGE_CONFLICT);
      expect(r.out).toContain('CONFLICT');
      expect(r.out).toContain('pricing.txt');
      expect(pairResult({ exitCode: r.code, stdout: r.out, stderr: '', ms: 1, step: 0 }, 0, 1)).toMatchObject({ status: 'conflict', files: ['pricing.txt'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the run step runs each article on the pair, names the broken ones, and finds the partner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-pair-'));
    try {
      const w = join(dir, 'w');
      execFileSync('mkdir', ['-p', w, join(dir, 'w-c3'), join(dir, 'w-c5')]);
      writeFileSync(join(w, '.pair-ready'), '');
      // An article that breaks when both pages.txt and pricing.txt exist.
      const both = `test -f pages.txt && test -f pricing.txt && exit 1; exit 0`;
      writeFileSync(join(w, 'pages.txt'), '');
      writeFileSync(join(w, 'pricing.txt'), '');
      writeFileSync(join(dir, 'w-c5', 'pages.txt'), ''); // c5's landing plus the head: no pricing, holds
      writeFileSync(join(dir, 'w-c3', 'pages.txt'), '');
      writeFileSync(join(dir, 'w-c3', 'pricing.txt'), ''); // c3's landing plus the head: breaks
      const r = pairRun(dir, { CHECKS: `a1\ttrue\na9\t${both}`, CANDIDATES: 'c5 c3' });
      expect(r.code, r.err).toBe(1);
      expect(r.out).toContain('ARTICLE pair a1 ok');
      expect(r.out).toContain('ARTICLE pair a9 BROKEN');
      expect(r.out).toContain('BROKEN a9');
      expect(r.out).toContain('CAND c5 passes');
      expect(r.out).toContain('PARTNER c3');
      const parsed = pairResult({ exitCode: 1, stdout: `BASE ${'b'.repeat(40)}\nMERGED ${'c'.repeat(40)}\n${r.out}`, stderr: '', ms: 1, step: 1 }, 0, 1);
      expect(parsed).toMatchObject({ status: 'broken', broken: ['a9'], partner: 'c3', lineHead: 'b'.repeat(40), merge: 'c'.repeat(40) });
      // Every article holds: the pair is fine.
      expect(pairRun(dir, { CHECKS: 'a1\ttrue' })).toMatchObject({ code: 0, out: expect.stringContaining('PAIR OK') });
      expect(pairResult({ exitCode: 0, stdout: 'PAIR OK', stderr: '', ms: 1, step: 1 }, 0, 1).status).toBe('passed');
      // A setup that fails is the platform's problem, not a verdict.
      expect(pairRun(dir, { CHECKS: 'a1\ttrue', SETUP: 'exit 7' }).code).toBe(2);
      expect(pairResult({ exitCode: 2, stdout: 'SETUP FAILED (pair)', stderr: '', ms: 1, step: 1 }, 0, 1).status).toBe('error');
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
