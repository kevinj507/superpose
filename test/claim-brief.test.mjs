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

  it('asks both ways, and asks for assumptions before any code', () => {
    const md = brief('c2');
    expect(md).toContain('Could your work make false something listed here');
    expect(md).toContain("Could another claim's work make false something your work relies on?");
    expect(md).toMatch(/1\. Before you write code, declare what your approach relies on/);
  });
});
