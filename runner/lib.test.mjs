// The runner's local checks must agree with the platform's: a pre-push hook
// that disagrees refuses good pushes or lets bad ones through. Run with
// `node --test runner/lib.test.mjs` (Node 22.18+ reads the platform's TypeScript as is).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as platformRepos from '../src/core/repos.ts';
import * as platformScope from '../src/core/scope.ts';
import { describeNotice, explainError, inScope, indexSnapshot, outOfScope, trailerClaims } from './lib.mjs';

const PATTERNS = ['src/**', 'src/*.js', 'src/rate/**', '**/*.test.js', 'test/slugify.test.js', 'docs/*', '*.md', 'a/**/b.js', '**', 'src/**/index.ts'];
const PATHS = [
  'src/a.js',
  'src/rate/limit.ts',
  'src/rate/x/y.ts',
  'src/index.ts',
  'src/deep/er/index.ts',
  'test/slugify.test.js',
  'test/sub/a.test.js',
  'README.md',
  'docs/x.md',
  'docs/sub/x.md',
  'a/b.js',
  'a/x/y/b.js',
  'srcx/a.js',
  'src',
  '.github/workflows/ci.yml',
];

test('scope patterns match exactly what the platform matches', () => {
  for (const pattern of PATTERNS) {
    for (const path of PATHS) {
      assert.equal(inScope(path, [pattern]), platformScope.inScope(path, [pattern]), `${pattern} against ${path}`);
    }
  }
  assert.deepEqual(outOfScope(PATHS, ['src/**', '*.md']), platformScope.outOfScope(PATHS, ['src/**', '*.md']));
});

test('claim trailers are read the way the platform reads them', () => {
  const messages = [
    'Work\n\nSuperpose-Claim: c3',
    'Work\n\nsuperpose-claim:c3, c4',
    'Work\n\nSuperpose-Claim:\tc12 c13\nSigned-off-by: x',
    'No trailer here',
    'Superpose-Claim c3',
  ];
  for (const m of messages) assert.deepEqual(trailerClaims(m), platformRepos.trailerClaims(m), m);
});

test('every kind of notice reads as plain words', () => {
  const index = indexSnapshot({
    nodes: [
      { id: 'a1', kind: 'assumption', statement: 'Input is ASCII', status: 'contradicted' },
      { id: 'f1', kind: 'finding', statement: 'Titles have accents', finder: 'c2' },
    ],
  });
  const notices = [
    { seq: 1, type: 'claim.stale', data: { finding: 'f1', statement: 'Titles have accents', assumptions: ['a1'] } },
    { seq: 2, type: 'claim.helped', data: { finding: 'f1', statement: 'A helper exists' } },
    { seq: 3, type: 'claim.replanned', data: { version: 2 } },
    { seq: 4, type: 'scope.touched', data: { by: 'c2', sha: 'abcdef0123', paths: ['src/a.js'] } },
    { seq: 5, type: 'claim.checked', data: { sha: 'abcdef0123', verdict: 'checks-failed', exitCode: 1 } },
    { seq: 6, type: 'finding.filed', data: { finding: 'f1' } },
    { seq: 7, type: 'finding.verified', data: { finding: 'f1' } },
    { seq: 8, type: 'finding.refuted', data: { finding: 'f1' } },
    { seq: 9, type: 'finding.hedge_expired', data: { finding: 'f1' } },
    { seq: 10, type: 'reality.at_risk', data: { finding: 'f1', assumptions: ['a1'] } },
    { seq: 11, type: 'claim.landed', data: { line: 'main', merge: 'fedcba9876' } },
    { seq: 12, type: 'claim.landing_failed', data: { status: 'conflict', files: ['src/a.js'] } },
  ];
  for (const n of notices) {
    const d = describeNotice(n, index, 'c1');
    assert.ok(d.title && d.text, n.type);
    assert.doesNotMatch(`${d.title} ${d.text}`, /undefined|\[object Object\]/, n.type);
  }
  assert.match(describeNotice(notices[0], index, 'c1').text, /a1 “Input is ASCII”/);
  assert.match(describeNotice(notices[4], index, 'c1').text, /Fix the problem/);
});

test('failed calls are explained in plain words', () => {
  assert.match(explainError({ status: 409, data: { error: 'stale', message: 'claim c1 is stale' } }), /Re-plan it first/);
  assert.match(explainError({ status: 0, data: { error: 'network', message: 'fetch failed' } }), /could not be reached/);
  assert.equal(explainError({ status: 418, data: null }), 'http_418');
});
