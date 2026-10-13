import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MUST_READ_NOTICES,
  STANDING_NOTICES,
  adviceFor,
  advanceSeenSeq,
  describeNotice,
  indexSnapshot,
  latestSeq,
  mustRead,
  noticesAbout,
  peekUnread,
  readNotices,
  readSeenSeq,
  recordNotices,
  takeUnread,
} from '../runner/lib.mjs';

// How what the platform says reaches a working copy. The pricing test's
// second arm (graph shop-sp-1, 2026-10-13) showed two holes: a finding
// verified before its target claim was taken never reached the agent, and
// one verified while the agent worked arrived only with the next renewal,
// after the agent had finished. These pin the pieces that close them.

const snap = {
  lines: [{ name: 'main', inherits: [] }],
  nodes: [
    { id: 'a1', kind: 'assumption', status: 'holding', statement: 'a price stays the same while its page is cached' },
    { id: 'c2', kind: 'claim', line: 'main', status: 'open', statement: 'Product pages load fast.', scope: ['src/pages.js'] },
    { id: 'c3', kind: 'claim', line: 'main', status: 'claimed', statement: 'Prices follow demand.', scope: ['src/pricing.js'] },
    { id: 'c4', kind: 'claim', line: 'main', status: 'claimed', statement: 'Buying moves the price.', scope: ['src/orders.js'] },
    { id: 'f3', kind: 'finding', effect: 'helps', status: 'verified', finder: 'c3', targets: ['c2'], statement: 'a cached page keeps the old price after a buy' },
    { id: 'f5', kind: 'finding', effect: 'helps', status: 'unverified', finder: 'c4', targets: ['c2'], statement: 'the page can be re-rendered after a purchase' },
    { id: 'f6', kind: 'finding', effect: 'contradicts', status: 'unverified', finder: 'c4', targets: ['a1'], statement: 'prices move on every purchase' },
    { id: 'f7', kind: 'finding', effect: 'helps', status: 'refuted', finder: 'c3', targets: ['c2'], statement: 'wrong advice' },
  ],
  edges: [{ source: 'a1', target: 'c2', purpose: 'required for' }],
  pushes: [],
  events: [
    { seq: 1, at: 1, type: 'claim.checked', claims: ['c3'], data: { sha: 'abc', verdict: 'checks-passed' } },
    { seq: 2, at: 2, type: 'finding.verified', claims: ['c3'], data: { finding: 'f3' } },
    { seq: 3, at: 3, type: 'claim.helped', claims: ['c2'], data: { finding: 'f3', statement: 'a cached page keeps the old price after a buy' } },
    { seq: 4, at: 4, type: 'scope.touched', claims: ['c2'], data: { by: 'c4', sha: 'def', paths: ['src/pages.js'] } },
    { seq: 5, at: 5, type: 'claim.checked', claims: ['c2'], data: { sha: 'ghi', verdict: 'checks-passed' } },
  ],
};
const index = indexSnapshot(snap);

describe('what the platform said about a claim', () => {
  it('is read from the graph, addressed to that claim, after a given point', () => {
    expect(noticesAbout(index, 'c2').map((n) => n.seq)).toEqual([3, 4, 5]);
    expect(noticesAbout(index, 'c2', { afterSeq: 4 }).map((n) => n.seq)).toEqual([5]);
    expect(noticesAbout(index, 'c2', { types: STANDING_NOTICES }).map((n) => n.type)).toEqual(['claim.helped', 'scope.touched']);
    expect(noticesAbout(index, 'c3').map((n) => n.type)).toEqual(['claim.checked', 'finding.verified']);
    expect(noticesAbout(null, 'c2')).toEqual([]);
    expect(latestSeq(index)).toBe(5);
    expect(latestSeq(null)).toBe(0);
  });

  it('a helpful finding reads as a notice with the finder named', () => {
    const [helped] = noticesAbout(index, 'c2', { types: new Set(['claim.helped']) });
    expect(helped.title).toContain('HELP');
    expect(helped.text).toContain('filed by c3');
    expect(helped.text).toContain('a cached page keeps the old price after a buy');
  });

  it('unverified findings addressed to the claim are advice and doubts, never its own, never refuted ones', () => {
    const advice = adviceFor(index, 'c2');
    expect(advice.map((n) => n.key)).toEqual(['finding:f5', 'finding:f6']);
    expect(advice[0]).toMatchObject({ type: 'local.advice' });
    expect(advice[0].title).toContain('c4');
    expect(advice[0].text).toContain('the page can be re-rendered after a purchase');
    expect(advice[1]).toMatchObject({ type: 'local.doubt' });
    expect(advice[1].text).toContain('a1');
    expect(advice[1].text).toContain('prices move on every purchase');
    expect(adviceFor(index, 'c4')).toEqual([]); // it filed them
    expect(adviceFor(index, 'c3')).toEqual([]); // nothing is addressed to it, and it rests on nothing
    expect(adviceFor(null, 'c2')).toEqual([]);
    for (const n of advice) expect(MUST_READ_NOTICES.has(n.type)).toBe(true);
  });
});

describe('what the gate says about a pair', () => {
  const withArticle = indexSnapshot({
    ...snap,
    nodes: [...snap.nodes, { id: 'a9', kind: 'assumption', status: 'holding', statement: 'What you see is what you pay.', constitution: true, check: 'node --test constitution/see-is-pay.test.js' }],
  });
  const ev = (type, data) => ({ seq: 9, at: 9, type, claims: ['c2'], data });

  it('a broken pair must be read; a kept one is a receipt', () => {
    const broken = describeNotice(ev('claim.pair_checked', { sha: 'a'.repeat(40), lineHead: 'b'.repeat(40), status: 'broken', broken: ['a9'], partner: 'c3', current: true }), withArticle, 'c2');
    expect(broken.title).toContain('CONSTITUTION BROKEN');
    expect(broken.text).toContain('What you see is what you pay.');
    expect(broken.text).toContain('together with c3');
    expect(mustRead({ ...broken, type: 'claim.pair_checked' })).toBe(true);
    const kept = describeNotice(ev('claim.pair_checked', { sha: 'a'.repeat(40), lineHead: 'b'.repeat(40), status: 'passed' }), withArticle, 'c2');
    expect(kept.title).toContain('CONSTITUTION KEPT');
    expect(mustRead({ ...kept, type: 'claim.pair_checked' })).toBe(false);
    const conflict = describeNotice(ev('claim.pair_checked', { sha: 'a'.repeat(40), lineHead: 'b'.repeat(40), status: 'conflict', files: ['src/pages.js'] }), withArticle, 'c2');
    expect(conflict.title).toContain('CONFLICT WITH THE LINE');
    expect(mustRead({ ...conflict, type: 'claim.pair_checked' })).toBe(true);
  });

  it('a stale notice from the gate says what broke, with whom, and what to do', () => {
    const n = describeNotice(
      ev('claim.stale', { finding: 'f9', statement: '“What you see is what you pay.” is false where c2 at abc1234 and c3 are together: purchase 2 charged $42.00', assumptions: ['a9'], where: ['c2', 'c3'], constitution: true }),
      withArticle,
      'c2',
    );
    expect(n.title).toContain('CONSTITUTION BROKEN');
    expect(n.text).toContain('purchase 2 charged $42.00');
    expect(n.text).toContain('with c3 “Prices follow demand.” (already landed)');
    expect(n.text).toContain('replan --rests-on');
    expect(n.text).toContain('WITHOUT breaking the article');
    expect(n.text).toContain('--where c2,c3');
    expect(mustRead({ ...n, type: 'claim.stale' })).toBe(true);
  });

  it('a plain stale notice is unchanged', () => {
    const n = describeNotice(ev('claim.stale', { finding: 'f6', statement: 'prices move on every purchase', assumptions: ['a1'] }), withArticle, 'c2');
    expect(n.title).toContain('STALE: an assumption under claim c2');
    expect(n.text).toContain('Re-plan:');
  });
});

describe('recording notices in a working copy', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sp-notices-'));
    mkdirSync(join(dir, '.superpose'));
    writeFileSync(join(dir, '.superpose', 'claim.json'), JSON.stringify({ claim: 'c2' }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps each platform event and each piece of advice once, whichever way it arrives', () => {
    const first = recordNotices(dir, [...noticesAbout(index, 'c2', { types: STANDING_NOTICES }), ...adviceFor(index, 'c2')]);
    expect(first.map((n) => n.key ?? n.seq)).toEqual([3, 4, 'finding:f5', 'finding:f6']);
    // The renewal brings the helped event again, the poll brings the advice again.
    const again = recordNotices(dir, [...noticesAbout(index, 'c2'), ...adviceFor(index, 'c2')]);
    expect(again.map((n) => n.seq)).toEqual([5]);
    expect(readNotices(dir)).toHaveLength(5);
    expect(recordNotices(dir, [])).toEqual([]);
    const md = readFileSync(join(dir, '.superpose', 'NOTICES.md'), 'utf8');
    expect(md).toContain('# Notices for claim c2');
    expect(md.match(/^## \d+\. /gm)).toHaveLength(5);
  });

  it('notices without a seq or key are always kept', () => {
    recordNotices(dir, [{ title: 'a', text: 'b', at: 1, type: 'local.lost' }]);
    recordNotices(dir, [{ title: 'a', text: 'b', at: 1, type: 'local.lost' }]);
    expect(readNotices(dir)).toHaveLength(2);
  });

  it('peeking leaves the unread as they are; taking marks them shown on that channel only', () => {
    recordNotices(dir, noticesAbout(index, 'c2'));
    expect(peekUnread(dir, 'agent')).toHaveLength(3);
    expect(peekUnread(dir, 'agent')).toHaveLength(3);
    expect(takeUnread(dir, 'agent')).toHaveLength(3);
    expect(peekUnread(dir, 'agent')).toHaveLength(0);
    expect(peekUnread(dir, 'push')).toHaveLength(3);
  });

  it('the seen seq only moves forward', () => {
    expect(readSeenSeq(dir)).toBe(0);
    advanceSeenSeq(dir, 5);
    advanceSeenSeq(dir, 3);
    expect(readSeenSeq(dir)).toBe(5);
    advanceSeenSeq(dir, 9);
    expect(readSeenSeq(dir)).toBe(9);
  });
});
