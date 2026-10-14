import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { git } from '../runner/lib.mjs';
import { prepareHostedOrigin } from '../runner/hosted-origin.mjs';

test('prepares main on the existing owner routes and pushes a Kevin Joo seed commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-origin-test-'));
  try {
    const seed = join(root, 'seed');
    const bare = join(root, 'origin.git');
    mkdirSync(seed);
    git(root, ['init', '--bare', '--quiet', bare]);
    git(seed, ['init', '--quiet', '-b', 'main']);
    writeFileSync(join(seed, 'README.md'), 'seed\n');

    const calls = [];
    const secret = 'operator-secret';
    const minted = 'git-write-secret';
    const fetchImpl = async (target, init) => {
      calls.push({ url: String(target), init });
      assert.equal(init.headers.authorization, `Bearer ${secret}`);
      if (String(target).endsWith('/lines/main')) return Response.json({ ok: true });
      return Response.json({ remote: bare, token: minted });
    };
    const result = await prepareHostedOrigin({ seedCheckout: seed, url: 'https://sp.example/', graphId: 'run_1', adminToken: secret, fetchImpl });

    assert.equal(result.remoteUrl, bare);
    assert.equal(result.graphId, 'run_1');
    assert.deepEqual(result.auth, { token: minted });
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes(minted), true); // auth is deliberately a separate private value
    assert.equal(calls.length, 2);
    assert.match(git(seed, ['log', '-1', '--format=%an <%ae>']).stdout, /^Kevin Joo <kevinj507@gmail.com>/);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']).stdout.trim(), git(seed, ['rev-parse', 'HEAD']).stdout.trim());
    assert.equal(calls[1].init.body, JSON.stringify({ scope: 'write', ttl: 3600 }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an invalid graph ID before making requests', async () => {
  let called = false;
  await assert.rejects(prepareHostedOrigin({ seedCheckout: '/tmp', url: 'https://sp.example', graphId: '../x', adminToken: 'x', fetchImpl: async () => { called = true; } }), /invalid graphId/);
  assert.equal(called, false);
});
