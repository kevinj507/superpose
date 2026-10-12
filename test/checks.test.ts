import { describe, expect, it } from 'vitest';
import { CHECK_SCRIPT, EXIT_FETCH_FAILED, checkRunFrom, readCheckConfig, runCheck, type ExecJob } from '../src/core/checks';
import { FakeRepoHost, MapKeyValue } from '../src/core/fake-host';

const clock = { t: 5_000, now() { return this.t; } };

async function repoWith(files: Record<string, string>) {
  const host = new FakeRepoHost(new MapKeyValue(), clock);
  await host.ensure('r');
  const { after } = host.commit('r', files);
  return { host, sha: after };
}

describe('what a commit says its checks are', () => {
  it('reads superpose.json from the exact commit', async () => {
    const { host, sha } = await repoWith({ 'superpose.json': '{"setup":"npm ci","check":"npm run verify","timeoutSeconds":90}' });
    expect(await readCheckConfig(host, 'r', sha)).toEqual({ setup: 'npm ci', check: 'npm run verify', timeoutSeconds: 90 });
  });

  it('falls back to npm test when package.json has a test script, and to nothing otherwise', async () => {
    const npm = await repoWith({ 'package.json': '{"scripts":{"test":"node --test"}}' });
    expect(await readCheckConfig(npm.host, 'r', npm.sha)).toMatchObject({ check: 'npm test' });
    const none = await repoWith({ 'README.md': 'hi', 'package.json': '{"name":"x"}' });
    expect(await readCheckConfig(none.host, 'r', none.sha)).toBeNull();
  });

  it('keeps timeouts within bounds and ignores a broken superpose.json', async () => {
    const big = await repoWith({ 'superpose.json': '{"check":"make test","timeoutSeconds":99999}' });
    expect((await readCheckConfig(big.host, 'r', big.sha))!.timeoutSeconds).toBe(1200);
    const broken = await repoWith({ 'superpose.json': '{not json', 'package.json': '{"scripts":{"test":"x"}}' });
    expect(await readCheckConfig(broken.host, 'r', broken.sha)).toMatchObject({ check: 'npm test' });
  });
});

describe('running checks on one commit', () => {
  it('hands the container a read token for this run only, and revokes it after', async () => {
    const { host, sha } = await repoWith({ 'package.json': '{"scripts":{"test":"x"}}' });
    const jobs: ExecJob[] = [];
    const run = await runCheck(host, async (job) => (jobs.push(job), { exitCode: 0, stdout: 'ok 1', stderr: '', ms: 10 }), { name: 'r', remote: 'https://git/r.git' }, sha, { check: 'npm test', timeoutSeconds: 60 }, () => clock.now());
    expect(run).toMatchObject({ status: 'passed', exitCode: 0, command: 'npm test', log: 'ok 1' });
    expect(jobs[0]!.script).toBe(CHECK_SCRIPT);
    expect(jobs[0]!.script).not.toContain(jobs[0]!.env.GIT_TOKEN!);
    expect(jobs[0]!.env).toMatchObject({ REMOTE: 'https://git/r.git', SHA: sha, CHECK: 'npm test', TIMEOUT: '60' });
    const [token] = host.tokens('r');
    expect(token).toMatchObject({ scope: 'read', revoked: true });
  });

  it('tells the code failing apart from the platform failing', () => {
    const cfg = { check: 'npm test', timeoutSeconds: 60 };
    const at = (exitCode: number | null, extra = {}) => checkRunFrom({ exitCode, stdout: '', stderr: '', ms: 1, ...extra }, cfg, 0, 1).status;
    expect(at(0)).toBe('passed');
    expect(at(1)).toBe('failed');
    expect(at(124)).toBe('timeout');
    expect(at(EXIT_FETCH_FAILED)).toBe('error');
    expect(at(null, { error: 'container not ready' })).toBe('error');
  });
});

describe('the check script', () => {
  it('drops the token before any code from the repo runs, and runs no git hooks', () => {
    const unset = CHECK_SCRIPT.indexOf('unset GIT_TOKEN');
    expect(unset).toBeGreaterThan(CHECK_SCRIPT.indexOf('git checkout'));
    expect(unset).toBeLessThan(CHECK_SCRIPT.indexOf('$SETUP'));
    expect(CHECK_SCRIPT).toContain('core.hooksPath /dev/null');
  });
});
