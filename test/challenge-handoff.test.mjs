import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { retireLocalContext } from '../runner/challenge-handoff.mjs';

test('replacement keeps useful code and history but cannot reread abandoned local context', () => {
  const root = mkdtempSync('/tmp/challenge-handoff-');
  const cwd = join(root, 'work'), archive = join(root, 'operator-archive');
  try {
    for (const name of ['src', '.git', '.experiment', '.superpose']) mkdirSync(join(cwd, name), { recursive: true });
    writeFileSync(join(cwd, 'src/accounting.mjs'), 'independently correct accounting');
    writeFileSync(join(cwd, '.git/retired-commit'), 'preserved history');
    writeFileSync(join(cwd, '.experiment/progress.json'), 'old P0-dependent reasoning');
    writeFileSync(join(cwd, '.superpose/STALE'), 'old holder state');
    const evidence = { report: { checked: true, cause: 'capacity_limit' } };
    retireLocalContext(cwd, archive, evidence);
    expect(readdirSync(join(cwd, '.experiment'))).toEqual(['evidence.json']);
    expect(JSON.parse(readFileSync(join(cwd, '.experiment/evidence.json')))).toEqual(evidence);
    expect(existsSync(join(cwd, '.superpose'))).toBe(false);
    expect(readFileSync(join(archive, '.experiment/progress.json'), 'utf8')).toBe('old P0-dependent reasoning');
    expect(readFileSync(join(archive, '.superpose/STALE'), 'utf8')).toBe('old holder state');
    expect(readFileSync(join(cwd, 'src/accounting.mjs'), 'utf8')).toBe('independently correct accounting');
    expect(readFileSync(join(cwd, '.git/retired-commit'), 'utf8')).toBe('preserved history');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
