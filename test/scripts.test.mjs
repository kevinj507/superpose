import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FETCH_SCRIPT, RUN_SCRIPT } from '../src/core/checks';
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
