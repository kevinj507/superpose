import { describe, expect, it } from 'vitest';
import { indexSnapshot, renderClaimMd } from '../runner/lib.mjs';

// The brief an agent gets shows the rest of the work in its reality and what
// each piece rests on, so it can tell when its work breaks someone else's.

const snap = {
  lines: [
    { name: 'main', inherits: [] },
    { name: 'fast', from: 'main', inherits: ['c0'] },
  ],
  nodes: [
    { id: 'a1', kind: 'assumption', status: 'holding', statement: 'A price stays the same while its page is cached' },
    { id: 'c0', kind: 'claim', line: 'main', status: 'landed', statement: 'Seed pages.', scope: ['src/seed.js'] },
    { id: 'c1', kind: 'claim', line: 'fast', status: 'landed', statement: 'Pages are kept 60 s.', scope: ['src/pages.js'] },
    { id: 'c2', kind: 'claim', line: 'fast', status: 'claimed', statement: 'Each purchase raises the price.', scope: ['src/pricing.js'], lease: { holder: 'agent-2' } },
    { id: 'c3', kind: 'claim', line: 'main', status: 'open', statement: 'Only on main.', scope: ['src/other.js'] },
    { id: 'f1', kind: 'finding', effect: 'helps', status: 'verified', finder: 'c2', targets: ['c1'], statement: 'A cached page keeps showing the old price after a buy.' },
    { id: 'f2', kind: 'finding', effect: 'contradicts', status: 'unverified', finder: 'c2', targets: ['a1'], statement: 'Prices move on every purchase.' },
    { id: 'f3', kind: 'finding', effect: 'helps', status: 'unverified', finder: 'c1', targets: ['c2'], statement: 'There is a helper for this.' },
    { id: 'a9', kind: 'assumption', status: 'holding', statement: 'What you see is what you pay.', constitution: true, check: 'node --test constitution/see-is-pay.test.js' },
    { id: 'a10', kind: 'assumption', status: 'holding', statement: 'Prices are never surprising.', constitution: true },
    { id: 'f9', kind: 'finding', effect: 'contradicts', status: 'verified', finder: 'gate', targets: ['a9'], where: ['c1', 'c2'], statement: '“What you see is what you pay.” is false where c1 at abc1234 and c2 are together: purchase 2 charged $42.00, but its page showed $40.00' },
  ],
  edges: [{ source: 'a1', target: 'c1', purpose: 'required for' }],
  pushes: [],
  events: [],
};

function brief(id) {
  const node = snap.nodes.find((n) => n.id === id);
  return renderClaimMd({ claim: id, statement: node.statement, scope: node.scope, status: node.status }, indexSnapshot(snap), '/nonexistent');
}

describe('the claim brief', () => {
  it('lists the other work in the same reality, landed work and what it rests on included', () => {
    const md = brief('c2');
    expect(md).toContain('## Other work in this reality');
    expect(md).toContain('`c1` (landed): Pages are kept 60 s.');
    expect(md).toContain('rests on `a1` (holding): A price stays the same while its page is cached');
    expect(md).toContain('`c0` (landed)'); // carried from the line it was forked from
    expect(md).not.toContain('`c3`'); // on another line
  });

  it('opens with what others have already told the claim: advice for it, and doubts on what it rests on', () => {
    const md = brief('c1');
    expect(md).toContain('## What others have told this claim');
    expect(md).toContain('`f1` from `c2` (verified): A cached page keeps showing the old price after a buy.');
    expect(md).toContain('`f2` from `c2` (filed, not yet verified): Prices move on every purchase. It says this is false: `a1` “A price stays the same while its page is cached”.');
    expect(md).not.toContain('`f3`'); // addressed to c2
    expect(md.indexOf('## What others have told this claim')).toBeLessThan(md.indexOf('## Other work in this reality'));
    // c2 filed f1 and f2 and hears about neither; f3 is for it.
    const other = brief('c2');
    expect(other).toContain('`f3` from `c1` (filed, not yet verified): There is a helper for this.');
    expect(other).not.toContain('`f1`');
    // Nothing to tell: no section.
    expect(brief('c3')).not.toContain('## What others have told this claim');
  });

  it('shows the constitution first, with each article\'s check or that it is judged', () => {
    const md = brief('c2');
    expect(md).toContain('## The constitution: what this product keeps, whatever you build');
    expect(md).toContain('- `a9`: What you see is what you pay. (checked by `node --test constitution/see-is-pay.test.js`)');
    expect(md).toContain('- `a10`: Prices are never surprising. (judged: no test, a checker reads against it)');
    expect(md.indexOf('## The constitution')).toBeLessThan(md.indexOf('## Scope'));
    expect(md).toContain('merges\nyour commit with the line as it stands and runs them on the pair');
    expect(md).toContain('The files under `constitution/` belong to no claim: never change them.');
  });

  it('a gate finding located on the claim is among what it has been told, with where it holds', () => {
    const md = brief('c1');
    expect(md).toContain('`f9` from `gate` (measured by the gate):');
    expect(md).toContain('It holds where c1 and c2 are together.');
    expect(md).toContain('It says this is false: `a9` “What you see is what you pay.”');
    expect(brief('c2')).toContain('`f9` from `gate`');
    expect(brief('c3')).not.toContain('`f9`');
  });

  it('asks both ways, and asks for assumptions before any code', () => {
    const md = brief('c2');
    expect(md).toContain('Could your work make false something listed here');
    expect(md).toContain("Could another claim's work make false something your work relies on?");
    expect(md).toMatch(/1\. Before you write code, declare what your approach relies on/);
  });
});
