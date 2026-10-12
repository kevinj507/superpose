// Where everything sits on the canvas.
//
// The graph is drawn as a forest. Every assumption heads a group; the claims
// resting on it hang beneath it as a tree, and a claim built on another claim
// hangs beneath that claim, indented. Findings sit just above the assumption
// they contradict. Groups are packed into columns (masonry), with the column
// count chosen to fill the canvas, so forty claims stay legible on one screen.
//
// The tree shows one parent per claim. Every other edge (a claim resting on a
// second assumption, building on a claim in another group, a finding aimed at
// a second assumption) is drawn as a curve between the two cards.
//
// Pure functions only: no DOM. `computeLayout` decides positions;
// `routePath` turns one edge into an SVG path for any set of positions, so
// edges can follow cards while they animate.

export const DIM = {
  colW: 256, // column width; the assumption card spans it
  colGap: 48,
  groupGap: 40, // between groups stacked in one column
  rowGap: 10,
  claimH: 80,
  assumptionH: 62,
  findingH: 62,
  findingGap: 22,
  findingInset: 18,
  pseudoH: 30,
  indent: 20, // per level of "builds on"
  maxDepth: 4,
  chunkRows: 10, // a group longer than this splits into continued blocks
  margin: 60, // room for curves outside the columns
};

const RANK = { assumption: 0, claim: 1, finding: 2 };

// Ids are a letter and a number (a3, c12, f1): order by letter, then number.
export function cmpId(a, b) {
  const pa = /^([^\d]*)(\d*)(.*)$/.exec(a) ?? ['', a, '', ''];
  const pb = /^([^\d]*)(\d*)(.*)$/.exec(b) ?? ['', b, '', ''];
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  const na = pa[2] === '' ? -1 : Number(pa[2]);
  const nb = pb[2] === '' ? -1 : Number(pb[2]);
  if (na !== nb) return na - nb;
  return pa[3] < pb[3] ? -1 : pa[3] > pb[3] ? 1 : 0;
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// The parents the canvas draws as a tree, and everything else it knows about
// how claims hang together. Shared with the inspector and the propagation scene.
export function relations(nodes, edges) {
  const index = new Map();
  for (const n of nodes) if (n && RANK[n.kind] !== undefined) index.set(n.id, n);
  const claimParents = new Map(); // claim -> claims it builds on
  const assumptionParents = new Map(); // claim -> assumptions it rests on
  const supersedes = new Map(); // new claim -> claims it replaces
  const supersededBy = new Map(); // old claim -> claims replacing it
  const dependents = new Map(); // assumption or claim -> claims resting / building on it
  const firstAssumption = new Map(); // claim -> the first assumption it declared (edge order)
  for (const e of edges) {
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (!s || !t) continue;
    if (e.purpose === 'required for' && t.kind === 'claim') {
      if (s.kind === 'claim') push(claimParents, t.id, s.id);
      else if (s.kind === 'assumption') {
        push(assumptionParents, t.id, s.id);
        if (!firstAssumption.has(t.id)) firstAssumption.set(t.id, s.id);
      } else continue;
      push(dependents, s.id, t.id);
    } else if (e.purpose === 'supersedes' && s.kind === 'claim' && t.kind === 'claim') {
      push(supersedes, s.id, t.id);
      push(supersededBy, t.id, s.id);
    }
  }
  for (const m of [claimParents, assumptionParents, supersedes, supersededBy, dependents]) {
    for (const list of m.values()) list.sort(cmpId);
  }
  return { index, claimParents, assumptionParents, supersedes, supersededBy, dependents, firstAssumption };
}

// Every claim downstream of the given nodes through "required for" edges,
// with its distance: 1 = rests on it directly, 2 = builds on such a claim, ...
export function downstream(rel, from) {
  const depth = new Map();
  let frontier = [...from];
  let d = 0;
  while (frontier.length) {
    d++;
    const next = [];
    for (const id of frontier) {
      for (const c of rel.dependents.get(id) ?? []) {
        if (depth.has(c)) continue;
        depth.set(c, d);
        next.push(c);
      }
    }
    frontier = next;
  }
  return depth;
}

export function computeLayout(nodes, edges, opts = {}) {
  const D = { ...DIM, ...(opts.dim ?? {}) };
  const rel = relations(nodes, edges);
  const { index } = rel;
  const claims = [];
  const assumptions = [];
  const findings = [];
  for (const n of index.values()) {
    if (n.kind === 'claim') claims.push(n);
    else if (n.kind === 'assumption') assumptions.push(n);
    else findings.push(n);
  }
  const byNodeId = (a, b) => cmpId(a.id, b.id);
  claims.sort(byNodeId);
  assumptions.sort(byNodeId);
  findings.sort(byNodeId);

  // One parent per claim for the tree: a claim it builds on keeps a chain
  // together; otherwise the first assumption it declared (a re-plan declares
  // its new one first, so the claim moves there); otherwise the claim it
  // replaces, so a new version sits under its old one.
  // A claim ordered after another only because their scopes overlap does not
  // build on it: it stays under its own assumption.
  const ordered = opts.ordered ?? new Set();
  const primary = new Map();
  for (const c of claims) {
    const p =
      rel.claimParents.get(c.id)?.find((x) => !ordered.has(`${x}>${c.id}`)) ??
      rel.firstAssumption.get(c.id) ??
      rel.supersedes.get(c.id)?.[0] ??
      null;
    primary.set(c.id, p);
  }
  // A cycle (never made by the API, but never trusted either) is cut where found.
  for (const c of claims) {
    const seen = new Set([c.id]);
    let p = primary.get(c.id);
    while (p && index.get(p)?.kind === 'claim') {
      if (seen.has(p)) {
        primary.set(c.id, null);
        break;
      }
      seen.add(p);
      p = primary.get(p);
    }
  }
  const children = new Map();
  for (const c of claims) {
    const p = primary.get(c.id);
    if (p) push(children, p, c.id);
  }

  // Groups: one per assumption, then one per cluster for claims that rest on
  // nothing declared yet.
  const groups = [];
  const groupByKey = new Map();
  for (const a of assumptions) {
    const g = { key: a.id, header: a.id, pseudo: false, label: '', roots: children.get(a.id) ?? [], findings: [] };
    groups.push(g);
    groupByKey.set(g.key, g);
  }
  const free = new Map();
  for (const c of claims) if (primary.get(c.id) === null) push(free, c.cluster || 'main', c.id);
  for (const cluster of [...free.keys()].sort()) {
    const key = `~free:${cluster}`;
    const g = { key, header: key, pseudo: true, label: cluster, roots: free.get(cluster), findings: [] };
    groups.push(g);
    groupByKey.set(key, g);
  }

  // Which group each claim ended up in (via its tree root).
  const groupOf = new Map();
  const rows = new Map(); // group key -> subtrees: [{id, depth}][]
  const walk = (id, depth, out, seen) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, depth });
    for (const ch of children.get(id) ?? []) walk(ch, depth + 1, out, seen);
  };
  const placed = new Set();
  for (const g of groups) {
    const subtrees = [];
    for (const r of g.roots) {
      const sub = [];
      walk(r, 1, sub, placed);
      if (sub.length) subtrees.push(sub);
      for (const row of sub) groupOf.set(row.id, g.key);
    }
    rows.set(g.key, subtrees);
  }

  // Findings sit above the assumption they contradict (or the group of the
  // claim they help).
  for (const f of findings) {
    const targets = Array.isArray(f.targets) ? f.targets : [];
    let key = null;
    for (const t of targets) {
      const n = index.get(t);
      if (n?.kind === 'assumption') key = t;
      else if (n?.kind === 'claim') key = groupOf.get(t) ?? null;
      if (key) break;
    }
    key ??= groupOf.get(f.finder) ?? null;
    if (!key) {
      key = '~free:findings';
      if (!groupByKey.has(key)) {
        const g = { key, header: key, pseudo: true, label: 'findings', roots: [], findings: [] };
        groups.push(g);
        groupByKey.set(key, g);
        rows.set(key, []);
      }
    }
    groupByKey.get(key).findings.push(f.id);
  }

  // Blocks: a group, split between whole subtrees when it runs long.
  const blocks = [];
  for (const g of groups) {
    let cur = { key: g.key, group: g, part: 0, rows: [] };
    for (const sub of rows.get(g.key) ?? []) {
      if (cur.rows.length && cur.rows.length + sub.length > D.chunkRows) {
        blocks.push(cur);
        cur = { key: `${g.key}#${cur.part + 1}`, group: g, part: cur.part + 1, rows: [] };
      }
      cur.rows.push(...sub);
    }
    blocks.push(cur);
  }
  for (const b of blocks) {
    let h = 0;
    if (b.part === 0) {
      h += b.group.findings.length * (D.findingH + D.findingGap);
      h += b.group.pseudo ? D.pseudoH : D.assumptionH;
    } else h += D.pseudoH;
    h += b.rows.length * (D.rowGap + D.claimH);
    b.h = h;
  }

  // Masonry: each block goes to the shortest column, unless it already had a
  // column last time and the column count is unchanged (stable positions).
  const pack = (K, assign) => {
    const colH = new Array(K).fill(-1);
    for (const b of blocks) {
      let c = assign?.get(b.key);
      if (c === undefined || c >= K) {
        c = 0;
        for (let i = 1; i < K; i++) if (colH[i] < colH[c]) c = i;
      }
      b.col = c;
      b.y = colH[c] < 0 ? 0 : colH[c] + D.groupGap;
      colH[c] = b.y + b.h;
    }
    const width = K * D.colW + (K - 1) * D.colGap;
    const height = Math.max(0, ...colH);
    return { width, height };
  };
  const aspect = opts.aspect > 0 ? opts.aspect : 1.6;
  const scaleFor = (r) => Math.min(aspect / (r.width + 2 * D.margin), 1 / (r.height + 2 * D.margin));
  let K = 1;
  let bestScale = -1;
  const maxK = Math.max(1, blocks.length);
  for (let k = 1; k <= maxK; k++) {
    const s = scaleFor(pack(k, null));
    if (s > bestScale * 1.02) {
      bestScale = s;
      K = k;
    }
  }
  let assign = null;
  const prev = opts.prev;
  if (prev && prev.k >= 1 && prev.k <= maxK && prev.assign) {
    const s = scaleFor(pack(prev.k, prev.assign));
    // Keep the old arrangement unless a new one is clearly better.
    if (s >= bestScale * 0.85) {
      K = prev.k;
      assign = prev.assign;
    }
  }
  const dims = pack(K, assign);
  const nextAssign = new Map(blocks.map((b) => [b.key, b.col]));

  // Boxes.
  const boxes = new Map();
  const pseudo = [];
  const treeParent = new Map(); // claim id -> box id its connector starts from
  for (const b of blocks) {
    const x0 = b.col * (D.colW + D.colGap);
    let y = b.y;
    let headerId;
    if (b.part === 0) {
      for (const fid of b.group.findings) {
        boxes.set(fid, { id: fid, kind: 'finding', x: x0 + D.findingInset, y, w: D.colW - D.findingInset, h: D.findingH, group: b.group.key });
        y += D.findingH + D.findingGap;
      }
      headerId = b.group.header;
      if (b.group.pseudo) {
        const box = { id: headerId, kind: 'pseudo', x: x0, y, w: D.colW, h: D.pseudoH, group: b.group.key, label: b.group.label, cont: false };
        boxes.set(headerId, box);
        pseudo.push(box);
        y += D.pseudoH;
      } else {
        boxes.set(headerId, { id: headerId, kind: 'assumption', x: x0, y, w: D.colW, h: D.assumptionH, group: b.group.key });
        y += D.assumptionH;
      }
    } else {
      headerId = `~cont:${b.key}`;
      const box = {
        id: headerId, kind: 'pseudo', x: x0, y, w: D.colW, h: D.pseudoH, group: b.group.key,
        label: b.group.pseudo ? b.group.label : b.group.header, cont: true, of: b.group.pseudo ? null : b.group.header,
      };
      boxes.set(headerId, box);
      pseudo.push(box);
      y += D.pseudoH;
    }
    for (const r of b.rows) {
      y += D.rowGap;
      const ind = Math.min(r.depth, D.maxDepth) * D.indent;
      boxes.set(r.id, { id: r.id, kind: 'claim', x: x0 + ind, y, w: D.colW - ind, h: D.claimH, depth: r.depth, group: b.group.key });
      treeParent.set(r.id, r.depth === 1 ? headerId : primary.get(r.id));
      y += D.claimH;
    }
  }

  // Routes: how each edge is drawn. `from`/`to` are the boxes the line joins;
  // `src`/`dst` are the graph nodes the edge is about (a tree connector may
  // start at a group label rather than at the assumption itself).
  const routes = [];
  const seen = new Set(); // edge keys already drawn (the tree draws some)
  for (const [child, from] of treeParent) {
    const p = primary.get(child);
    let key = null;
    let purpose = 'required for';
    if (p && index.get(p)) {
      if (rel.claimParents.get(child)?.includes(p) || rel.assumptionParents.get(child)?.includes(p)) {
        key = `${p}>${child}:required for`;
      } else {
        key = `${child}>${p}:supersedes`;
        purpose = 'supersedes';
      }
      seen.add(key);
    }
    routes.push({ key: key ?? `~tree:${from}>${child}`, route: 'tree', from, to: child, src: key ? p : null, dst: child, purpose, real: key });
  }
  // Findings stacked above one header: only the lowest drops straight in.
  const lowestFinding = new Map();
  for (const g of groups) if (g.findings.length) lowestFinding.set(g.key, g.findings[g.findings.length - 1]);
  for (const e of edges) {
    const key = `${e.source}>${e.target}:${e.purpose}`;
    if (seen.has(key)) continue;
    const s = boxes.get(e.source);
    const t = boxes.get(e.target);
    if (!s || !t || s === t) continue;
    seen.add(key);
    let route = 'cross';
    if (s.kind === 'finding' && t.kind === 'assumption' && s.group === t.group) {
      route = lowestFinding.get(s.group) === s.id ? 'drop' : 'swoosh';
    }
    routes.push({ key, route, from: e.source, to: e.target, src: e.source, dst: e.target, purpose: e.purpose, real: key });
  }

  return {
    boxes,
    pseudo,
    routes,
    k: K,
    assign: nextAssign,
    primary,
    groupOf,
    rel,
    bounds: { x: -D.margin, y: -D.margin, w: dims.width + 2 * D.margin, h: dims.height + 2 * D.margin },
    dim: D,
  };
}

// The SVG path for one route, given current box positions.
export function routePath(r, boxes, D = DIM) {
  const s = boxes.get(r.from);
  const t = boxes.get(r.to);
  if (!s || !t) return '';
  const f = (n) => Math.round(n * 10) / 10;
  if (r.route === 'tree') {
    // Spine down the parent's left side, then a rounded turn into the child.
    // It starts at the parent's middle: the card hides the part behind it.
    const sx = s.x + D.indent / 2;
    const sy = s.y + s.h / 2;
    const ty = t.y + t.h / 2;
    const tx = t.x;
    if (tx - sx < 12 || ty - sy < 12) return `M${f(sx)},${f(sy)} V${f(t.y)}`;
    const rad = 9;
    return `M${f(sx)},${f(sy)} V${f(ty - rad)} Q${f(sx)},${f(ty)} ${f(sx + rad)},${f(ty)} H${f(tx)}`;
  }
  if (r.route === 'drop') {
    const x = s.x + s.w / 2;
    return `M${f(x)},${f(s.y + s.h / 2)} V${f(t.y - 1)}`;
  }
  if (r.route === 'swoosh') {
    const sx = s.x + s.w;
    const sy = s.y + s.h / 2;
    const tx = t.x + t.w - 34;
    const ty = t.y - 1;
    const bulge = 30;
    return `M${f(sx)},${f(sy)} C${f(sx + bulge)},${f(sy)} ${f(sx + bulge)},${f(ty - 26)} ${f(tx)},${f(ty)}`;
  }
  // A curve between two cards anywhere on the canvas.
  const scx = s.x + s.w / 2;
  const tcx = t.x + t.w / 2;
  const dy = t.y + t.h / 2 - (s.y + s.h / 2);
  if (Math.abs(tcx - scx) < D.colW * 0.6) {
    // Same column: bow out to the right.
    const sx = s.x + s.w;
    const sy = s.y + s.h / 2;
    const tx = t.x + t.w;
    const ty = t.y + t.h / 2;
    const bulge = Math.min(26 + Math.abs(dy) * 0.12, D.colGap * 0.9 + 10);
    const x = Math.max(sx, tx) + bulge;
    return `M${f(sx)},${f(sy)} C${f(x)},${f(sy)} ${f(x)},${f(ty)} ${f(tx)},${f(ty)}`;
  }
  const right = tcx > scx;
  const sx = right ? s.x + s.w : s.x;
  const tx = right ? t.x : t.x + t.w;
  const sy = s.y + s.h / 2;
  const ty = t.y + t.h / 2;
  const dx = Math.max(40, Math.abs(tx - sx) * 0.45);
  const c1 = right ? sx + dx : sx - dx;
  const c2 = right ? tx - dx : tx + dx;
  return `M${f(sx)},${f(sy)} C${f(c1)},${f(sy)} ${f(c2)},${f(ty)} ${f(tx)},${f(ty)}`;
}
