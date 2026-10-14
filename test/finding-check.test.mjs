import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { findingEvidence, findingScripts } from '../src/core/finding-check';
import { landingChecks } from '../src/core/landing';

const temporary = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function git(path, ...args) {
  const result = spawnSync('git', args, { cwd: path, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'superpose-finding-'));
  temporary.push(root);
  const line = join(root, 'line');
  mkdirSync(line);
  git(line, 'init', '-q', '-b', 'main');
  git(line, 'config', 'user.name', 'Test');
  git(line, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(line, 'cache'), '0');
  writeFileSync(join(line, 'pricing'), '0');
  git(line, 'add', '.');
  git(line, 'commit', '-qm', 'baseline');
  const base = git(line, 'rev-parse', 'HEAD');
  const heads = ['cache', 'pricing'].map((file, i) => {
    const directory = join(root, `claim-${i}`);
    git(root, 'clone', '-q', line, directory);
    git(directory, 'config', 'user.name', 'Test');
    git(directory, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(directory, file), '1');
    git(directory, 'add', '.');
    git(directory, 'commit', '-qm', `change ${file}`);
    return { claim: `c${i + 1}`, sha: git(directory, 'rev-parse', 'HEAD'), repo: { name: file, remote: directory } };
  });
  const article = { id: 'a1', check: '[ "$(cat cache)" != 1 ] || [ "$(cat pricing)" != 1 ]' };
  const context = { finding: 'f1', line: { name: 'main', remote: line }, heads, articles: [article],
    evidence: { status: 'running', line: 'main', lineHead: base, heads: heads.map(({ claim, sha }) => ({ claim, sha })), articles: [article], at: 0 } };
  return { root, context };
}

function execute(context, root) {
  const scripts = findingScripts(context);
  const rewrite = (script) => script.replaceAll('/work', join(root, 'work')).replaceAll('/tmp/merge.log', join(root, 'merge.log')).replaceAll('/tmp/check.log', join(root, 'check.log'));
  const credentials = Object.fromEntries(context.heads.flatMap((head, i) => [[`TOKEN_${i}`, 'test-read'], [`REMOTE_${i}`, head.repo.remote], [`SHA_${i}`, head.sha]]));
  const merge = spawnSync('sh', ['-c', rewrite(scripts.merge)], { encoding: 'utf8', env: {
    PATH: process.env.PATH, LINE_TOKEN: 'test-read', LINE_REMOTE: context.line.remote, LINE_HEAD: context.evidence.lineHead, ...credentials,
  } });
  expect(merge.status, merge.stderr).toBe(0);
  const checked = spawnSync('sh', ['-c', rewrite(scripts.check)], { encoding: 'utf8', env: {
    PATH: process.env.PATH, TIMEOUT: '2', SETUP: '', ...Object.fromEntries(context.articles.map((a, i) => [`ARTICLE_${i}`, a.check])),
  } });
  return findingEvidence(context, { exitCode: checked.status, stdout: checked.stdout, stderr: checked.stderr, ms: 1, step: 1 });
}

describe('checking a reported interaction on real Git code', () => {
  it('confirms a failure that appears only when the two independently passing changes are combined', () => {
    const { context, root } = fixture();
    for (const head of context.heads) {
      const single = { ...context, heads: [head], evidence: { ...context.evidence, heads: [{ claim: head.claim, sha: head.sha }] } };
      expect(execute(single, root).status).toBe('refuted');
    }
    expect(execute(context, root).status).toBe('confirmed');
  });

  it('keeps a result inconclusive if the alleged article already fails before the selected work', () => {
    const { context, root } = fixture();
    context.articles[0].check = 'false';
    expect(execute(context, root).status).toBe('inconclusive');
  });

  it('cannot turn a timeout or a Git conflict into a verified contradiction', () => {
    const { context } = fixture();
    for (const exitCode of [91, 124, 137]) {
      expect(findingEvidence(context, { exitCode, stdout: 'FINDING confirmed', stderr: '', ms: 1 }).status).toBe('inconclusive');
    }
  });

  it('runs adopted articles even when the product declares no other CI command', () => {
    const combined = landingChecks(null, [{ check: 'false' }]);
    expect(combined).not.toBeNull();
    const result = spawnSync('sh', ['-c', combined.check]);
    expect(result.status).not.toBe(0);
    expect(landingChecks(null, [])).toBeNull();
  });
});
