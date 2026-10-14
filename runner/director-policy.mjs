// Time alone is never authority to verify, publish or adopt a statement.
export function directorActions(nodes, policy = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const actions = [];
  for (const n of nodes) {
    if (n.kind === 'finding' && n.status === 'unverified') {
      const choice = policy.findings?.[n.id];
      if (choice) {
        if (!choice.reason?.trim() || !['verify', 'refute', 'publish'].includes(choice.action)) throw new Error(`Invalid owner policy for ${n.id}`);
        if (choice.action === 'publish' && !choice.lines?.length) throw new Error(`Publication of ${n.id} needs destination lines`);
        actions.push({ id: n.id, ...choice });
      } else if (!n.evidence && n.effect === 'contradicts' && n.where?.length && n.targets?.every((id) => {
        const a = byId.get(id);
        return a?.constitution && a.check && !a.supersededBy && !a.supersededOn?.[n.line ?? 'main'];
      })) actions.push({ id: n.id, action: 'check', reason: 'Reproduce the located contradiction against adopted executable articles.' });
    }
    if (n.kind === 'assumption' && n.proposal && !n.proposal.resolution) {
      const choice = policy.articles?.[n.id];
      if (!choice) continue;
      if (!choice.reason?.trim() || !['adopt', 'reject'].includes(choice.action)) throw new Error(`Invalid owner policy for ${n.id}`);
      actions.push({ id: n.id, ...choice });
    }
  }
  return actions;
}
