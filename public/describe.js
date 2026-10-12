// Words for the canvas: verdict labels, times, and one plain sentence per
// event in the feed. Pure functions; the only markup they emit is spans and
// the small id chips the feed and inspector make clickable.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const shortSha = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 7) : '');

export function kindOf(id) {
  if (typeof id !== 'string') return 'other';
  if (id.startsWith('c')) return 'claim';
  if (id.startsWith('a')) return 'assumption';
  if (id.startsWith('f')) return 'finding';
  return 'other';
}

// A clickable id. `nodes` lets the chip carry the node's status colour.
export function chip(id, nodes) {
  const n = nodes?.get(id);
  const kind = n?.kind ?? kindOf(id);
  const status = n?.status ? ` s-${esc(n.status)}` : '';
  const title = n?.statement ? ` title="${esc(n.statement)}"` : '';
  return `<button type="button" class="chip k-${kind}${status}" data-ref="${esc(id)}"${title}>${esc(id)}</button>`;
}

export function chips(ids, nodes, max = 8) {
  const list = (ids ?? []).filter(Boolean);
  const shown = list.slice(0, max).map((id) => chip(id, nodes)).join(' ');
  return list.length > max ? `${shown} <span class="more">+${list.length - max}</span>` : shown;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// 0:42, 4:05, 1:02:00
export function clock(ms) {
  if (!Number.isFinite(ms)) return '';
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// "now", "12s", "4m", "2h", "3d"
export function ago(ms) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function timeOfDay(at) {
  if (!Number.isFinite(at)) return '';
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// The verdict on one commit, as a short label and a tone for its badge.
export function verdictOf(row) {
  if (!row) return null;
  const checks = row.checks?.status;
  if (checks === 'running' && row.verdict !== 'scope-violation') {
    return { key: 'running', label: 'checks running', tone: 'run' };
  }
  if (checks === 'timeout' && row.verdict !== 'scope-violation') {
    return { key: 'timeout', label: 'timed out', tone: 'warn' };
  }
  if (checks === 'skipped' && row.verdict === 'unverified') {
    return { key: 'skipped', label: 'no checks', tone: 'muted' };
  }
  switch (row.verdict) {
    case 'checks-passed':
      return { key: 'passed', label: 'passed', tone: 'good' };
    case 'checks-failed':
      return { key: 'failed', label: 'failed', tone: 'bad' };
    case 'scope-violation':
      return { key: 'scope', label: 'out of scope', tone: 'bad' };
    case 'verifier-failed':
      return { key: 'verifier', label: 'verifier failed', tone: 'warn' };
    case 'budget-exhausted':
      return { key: 'budget', label: 'budget spent', tone: 'muted' };
    case 'unverified':
      return { key: 'unverified', label: 'unverified', tone: 'muted' };
    default:
      return { key: 'unknown', label: String(row.verdict ?? 'unknown'), tone: 'muted' };
  }
}

export const STATUS_LABEL = {
  open: 'Open',
  claimed: 'Claimed',
  stale: 'Stale',
  done: 'Done',
  landed: 'Landed',
  superseded: 'Superseded',
};

const REASON = {
  stale: 'refused: the claim is stale',
  'not-head': 'not the branch tip',
  'other-branch': 'pushed to another branch',
  'not-claimed': 'no live lease on the claim',
};

export const reasonText = (r) => REASON[r] ?? r ?? '';

const quote = (s) => (s ? `“${esc(s)}”` : '');

const agentOf = (nodes, claimId) => {
  const c = nodes?.get(claimId);
  return c?.lease?.holder ?? null;
};

// One sentence per server event. `ctx.nodes` is the current node map;
// `ctx.stale` lists the claims a verified finding made stale (grouped by the
// caller so "f1 verified" and its stale claims read as one line).
export function describeEvent(ev, ctx = {}) {
  const nodes = ctx.nodes;
  const d = ev.data ?? {};
  const claimsOf = Array.isArray(ev.claims) ? ev.claims : [];
  const f = typeof d.finding === 'string' ? d.finding : null;
  const fNode = f ? nodes?.get(f) : null;
  switch (ev.type) {
    case 'finding.filed': {
      const finder = fNode?.finder ?? claimsOf[0];
      const who = agentOf(nodes, finder);
      const targets = fNode?.targets ?? [];
      const verb = fNode?.effect === 'helps' ? 'helps' : 'contradicts';
      return {
        tone: 'hedge',
        icon: 'finding',
        html: `${chip(f, nodes)} filed by ${chip(finder, nodes)}${who ? ` <span class="who">${esc(who)}</span>` : ''}${
          targets.length ? ` — ${verb} ${chips(targets, nodes)}` : ''
        }${fNode?.statement ? `<span class="q">${quote(fNode.statement)}</span>` : ''}<span class="sub">${
          verb === 'helps' ? 'Unverified until a checker decides; nothing changes meanwhile.' : 'Unverified: it runs beside the others as a hedge. Nobody stops.'
        }</span>`,
      };
    }
    case 'finding.verified': {
      const stale = ctx.stale ?? [];
      const targets = fNode?.targets ?? d.assumptions ?? [];
      if (fNode?.effect === 'helps') {
        return { tone: 'good', icon: 'check', html: `${chip(f, nodes)} verified — it helps ${chips(targets, nodes)}` };
      }
      const html = stale.length
        ? `${chip(f, nodes)} verified: <b>${plural(stale.length, 'claim')} stale</b> ${chips(stale, nodes, 10)}${
            targets.length ? `<span class="sub">${chips(targets, nodes)} contradicted. Only the claims resting on it stop; everyone else keeps working.</span>` : ''
          }`
        : `${chip(f, nodes)} verified${targets.length ? ` — ${chips(targets, nodes)} contradicted` : ''}<span class="sub">No live claim rested on it.</span>`;
      return { tone: 'stale', icon: 'bolt', html };
    }
    case 'claim.stale':
      return {
        tone: 'stale',
        icon: 'bolt',
        html: `${chips(claimsOf, nodes)} ${claimsOf.length === 1 ? 'is' : 'are'} stale${f ? ` (${chip(f, nodes)})` : ''}`,
      };
    case 'finding.refuted': {
      const finder = fNode?.finder ?? claimsOf[0];
      return {
        tone: 'muted',
        icon: 'x',
        html: `${chip(f, nodes)} refuted${finder ? ` — ${chip(finder, nodes)}'s work on it is kept aside and it re-plans` : ''}`,
      };
    }
    case 'finding.hedge_expired':
      return { tone: 'warn', icon: 'clock', html: `${chip(f, nodes)}'s hedge window ended — a decision is due` };
    case 'assumption.contradicted': {
      const a = typeof d.assumption === 'string' ? d.assumption : null;
      return { tone: 'stale', icon: 'bolt', html: `${a ? chip(a, nodes) : 'An assumption'} contradicted${f ? ` by ${chip(f, nodes)}` : ''}` };
    }
    case 'claim.helped':
      return { tone: 'good', icon: 'spark', html: `${f ? chip(f, nodes) : 'A finding'} helps ${chips(claimsOf, nodes)}${d.statement ? `<span class="q">${quote(d.statement)}</span>` : ''}` };
    case 'claim.replanned':
      return {
        tone: 'good',
        icon: 'redo',
        html: `${chips(claimsOf, nodes)} re-planned${d.version ? ` (v${esc(d.version)})` : ''} — back to work`,
      };
    case 'scope.touched': {
      const by = typeof d.by === 'string' ? d.by : null;
      const paths = Array.isArray(d.paths) ? d.paths : [];
      return {
        tone: 'warn',
        icon: 'warn',
        html: `${by ? chip(by, nodes) : 'A push'}${d.sha ? ` <code>${esc(shortSha(d.sha))}</code>` : ''} touched ${chips(claimsOf, nodes)}'s scope${
          paths.length ? `<span class="sub mono">${paths.slice(0, 3).map(esc).join(', ')}${paths.length > 3 ? ` +${paths.length - 3}` : ''}</span>` : ''
        }`,
      };
    }
    case 'claim.checked': {
      const v = verdictOf({ verdict: d.verdict });
      const good = d.verdict === 'checks-passed';
      return {
        tone: good ? 'good' : d.verdict === 'checks-failed' || d.verdict === 'scope-violation' ? 'bad' : 'muted',
        icon: good ? 'check' : 'x',
        html: `${chips(claimsOf, nodes)} ${good ? 'checks passed' : esc(v?.label ?? 'checked')}${d.sha ? ` on <code>${esc(shortSha(d.sha))}</code>` : ''}`,
      };
    }
    case 'claim.ordered': {
      const c = typeof d.claim === 'string' ? d.claim : null;
      const after = typeof d.after === 'string' ? d.after : null;
      return {
        tone: 'warn',
        icon: 'branch',
        html: `${c ? chip(c, nodes) : 'A claim'} waits for ${after ? chip(after, nodes) : 'another'}: their scopes overlap${overlapText(d)}<span class="sub">A conflict predicted before work starts: they will not change the same files at once.</span>`,
      };
    }
    case 'claim.landed': {
      const line = typeof d.line === 'string' ? d.line : 'its line';
      const merge = typeof d.merge === 'string' ? d.merge : null;
      return {
        tone: 'land',
        icon: 'flag',
        html: `${chips(claimsOf, nodes)} landed on <b>${esc(line)}</b>${merge ? ` <code>${esc(shortSha(merge))}</code>` : ''}`,
      };
    }
    case 'claim.landing_failed': {
      const files = Array.isArray(d.files) ? d.files : [];
      const why =
        d.status === 'conflict'
          ? `<b>conflict</b> in ${plural(files.length, 'file')}`
          : d.status === 'failed'
            ? '<b>checks failed</b> on the merged result'
            : 'the landing could not run';
      return {
        tone: 'bad',
        icon: 'warn',
        html: `${chips(claimsOf, nodes)} could not land: ${why}${
          files.length ? `<span class="sub mono">${files.slice(0, 3).map(esc).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}</span>` : ''
        }<span class="sub">It waits for a decision: bring it up to date and finish again, or re-plan.</span>`,
      };
    }
    case 'reality.served': {
      const line = typeof d.line === 'string' ? d.line : '?';
      const prev = typeof d.previous === 'string' ? d.previous : null;
      return {
        tone: 'land',
        icon: 'reality',
        html: `Reality switch: now serving <b>${esc(line)}</b>${prev ? ` <span class="who">(was ${esc(prev)})</span>` : ''}<span class="sub">A pointer change: the previous reality stays, retraceable.</span>`,
      };
    }
    case 'reality.at_risk':
      return {
        tone: 'bad',
        icon: 'warn',
        html: `Served reality at risk: ${chips(claimsOf, nodes)} landed on a contradicted assumption${f ? ` (${chip(f, nodes)})` : ''}`,
      };
    default:
      return { tone: 'muted', icon: 'dot', html: `${esc(ev.type)} ${chips(claimsOf, nodes)}` };
  }
}

// Where two declared scopes meet, e.g. "src/shared/format.ts": the pattern
// both name, or the more specific of the first pair that overlap.
const globRe = (g) =>
  new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*')}$`);
const wild = (g) => /[*?]/.test(g);

export function overlapText(d) {
  const a = Array.isArray(d?.scope) ? d.scope.filter((x) => typeof x === 'string') : [];
  const b = Array.isArray(d?.overlaps) ? d.overlaps.filter((x) => typeof x === 'string') : [];
  for (const x of a) {
    for (const y of b) {
      let meets = x === y;
      try {
        meets ||= globRe(x).test(y) || globRe(y).test(x);
      } catch {
        // an odd pattern: compare as written
      }
      if (meets) return ` (<code>${esc(x === y || !wild(x) ? x : !wild(y) ? y : `${x} ↔ ${y}`)}</code>)`;
    }
  }
  const shown = [a[0], b[0]].filter(Boolean).join(' ↔ ');
  return shown ? ` (<code>${esc(shown)}</code>)` : '';
}

// One sentence for a ledger row (a push the platform checked).
export function describePush(row, nodes) {
  const n = row.paths?.length ?? 0;
  const out = row.outside?.length ?? 0;
  const who = agentOf(nodes, row.claim);
  const sha = `<code>${esc(shortSha(row.sha))}</code>`;
  if (!row.accepted) {
    return {
      tone: row.reason === 'stale' ? 'stale' : 'muted',
      icon: 'x',
      html: `${chip(row.claim, nodes)} push ${sha} not taken — ${esc(reasonText(row.reason))}`,
    };
  }
  if (out) {
    return {
      tone: 'bad',
      icon: 'warn',
      html: `${chip(row.claim, nodes)}${who ? ` <span class="who">${esc(who)}</span>` : ''} pushed ${sha}: <b>${plural(out, 'file')} outside its scope</b><span class="sub mono">${row.outside
        .slice(0, 3)
        .map(esc)
        .join(', ')}</span>`,
    };
  }
  return {
    tone: 'push',
    icon: 'push',
    html: `${chip(row.claim, nodes)}${who ? ` <span class="who">${esc(who)}</span>` : ''} pushed ${sha} — ${plural(n, 'file')}, in scope`,
  };
}
