// The Superpose canvas: one live graph at /g/<id>, and the landing page at /.
//
// The canvas polls the graph's public snapshot every 1.5 s and updates in
// place. Cards keep their positions unless the structure changes; then they
// glide to the new layout. When a verified finding makes claims stale, the
// canvas plays the propagation: the finding glows, the assumption it
// contradicts is hit, and the claims resting on it turn stale one ring at a
// time, nearest first. Every other claim keeps looking exactly as it did.

import { cmpId, computeLayout, downstream, relations, routePath } from './layout.js';
import {
  STATUS_LABEL,
  ago,
  chip,
  chips,
  clock,
  describeEvent,
  describePush,
  esc,
  plural,
  reasonText,
  shortSha,
  timeOfDay,
  verdictOf,
} from './describe.js';

const POLL_MS = 1500;
const THEME_KEY = 'superpose-theme';
const SIDE_KEY = 'superpose-side';
const SVGNS = 'http://www.w3.org/2000/svg';
const STATUSES = ['open', 'claimed', 'stale', 'done', 'landed', 'superseded'];
const MIN_K = 0.12;
const MAX_K = 3;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrowQuery = matchMedia('(max-width: 760px)');

const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const later = (ms, fn) => setTimeout(fn, ms);
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      // private window or blocked storage: the setting just isn't remembered
    }
  },
};

// ---------------------------------------------------------------- theme --

function setupTheme() {
  const root = document.documentElement;
  const btn = $('btn-theme');
  const current = () => root.dataset.theme || 'system';
  const paint = () => {
    if (!btn) return;
    const t = current();
    btn.innerHTML = icon(t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'system');
    btn.title = `Theme: ${t} (T)`;
  };
  btn?.addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(current()) + 1) % order.length];
    if (next === 'system') delete root.dataset.theme;
    else root.dataset.theme = next;
    store.set(THEME_KEY, next === 'system' ? null : next);
    paint();
  });
  paint();
}

// -------------------------------------------------------------- landing --

function startLanding() {
  const form = $('open-form');
  const input = $('gid-input');
  if (!form || !input) return;
  input.addEventListener('input', () => input.setCustomValidity(''));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) {
      input.setCustomValidity('A graph id is 1–64 letters, digits, - or _.');
      input.reportValidity();
      return;
    }
    location.href = `/g/${v}`;
  });
}

// ---------------------------------------------------------------- state --

const S = {
  gid: '',
  fixture: null,
  fixtureShift: 0,
  nodes: new Map(),
  edges: [],
  events: [],
  pushes: [],
  lines: null,
  rel: relations([], []),
  pushRows: new Map(), // claim -> ledger rows, newest first
  pushKeys: new Set(),
  staleSeq: new Map(), // claim -> seq of the event that made it stale
  lastSeq: 0,
  loaded: false,
  structKey: null,
  layout: null,
  pack: null,
  routeByReal: new Map(),
  content: { x: 0, y: 0, w: 1, h: 1 },
  els: new Map(), // node id -> {el, html, base, status, verdict}
  pseudoEls: new Map(),
  edgeEls: new Map(),
  pos: new Map(), // id -> displayed box {x, y, w, h}
  raf: 0,
  view: { x: 0, y: 0, k: 1 },
  viewRaf: 0,
  follow: true,
  selected: null,
  impact: null,
  hiEdges: new Set(),
  riskEdges: new Set(),
  skew: 0,
  skewEst: null,
  leaseMs: 0, // from the snapshot, when it says
  leaseEst: 0, // otherwise: the longest remaining lease seen just after a renewal
  expSeen: new Map(),
  renewed: new Set(),
  hold: new Map(), // id -> {status, until}: what to show while a scene plays out
  feed: [],
  feedKeys: new Set(),
  feedDirty: false,
  diffSeq: 0,
  served: undefined,
  failures: 0,
  timer: 0,
  ticks: 0,
};

const serverNow = () => Date.now() + S.skew;
const leaseFull = () => S.leaseMs || S.leaseEst || 10 * 60_000;

// --------------------------------------------------------------- canvas --

function startCanvas(gid) {
  S.gid = gid;
  document.title = `${gid} · Superpose`;
  $('gid').textContent = gid;
  $('gid').title = `Graph ${gid}`;
  const fx = new URLSearchParams(location.search).get('fixture');
  if (fx && /^\/[A-Za-z0-9_\-./]+\.json$/.test(fx) && !fx.includes('..')) S.fixture = fx;
  // A fixture is read once, unless &poll asks for it to be watched like a graph.
  S.fixturePoll = new URLSearchParams(location.search).has('poll');

  const app = $('app');
  const side = store.get(SIDE_KEY);
  if (side === 'closed' || (side !== 'open' && window.innerWidth < 1100)) app.classList.add('side-closed');
  syncSideButton();

  wireCanvas();
  wireSide();
  setFollow(true);
  renderHeader(true);
  setInterval(tick, 250);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!S.fixture || S.fixturePoll)) {
      clearTimeout(S.timer);
      poll();
    }
  });
  poll();
}

async function poll() {
  clearTimeout(S.timer);
  try {
    const snap = await load();
    apply(snap);
    S.failures = 0;
    setConn(S.fixture ? 'fixture' : 'live');
  } catch (err) {
    S.failures++;
    if (S.failures >= 2 || !S.loaded) setConn('offline', err);
    console.warn('[superpose] snapshot failed:', err);
  }
  if ((S.fixture && !S.fixturePoll) || document.hidden) return;
  const wait = S.failures ? Math.min(POLL_MS * 2 ** S.failures, 15_000) : POLL_MS;
  S.timer = setTimeout(poll, wait);
}

async function load() {
  const url = S.fixture ?? `/api/graphs/${encodeURIComponent(S.gid)}/snapshot`;
  const sent = Date.now();
  // A request that never comes back must not freeze the canvas: give up and retry.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  let res;
  let snap;
  try {
    res = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    snap = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const got = Date.now();
  if (S.fixture) {
    // A fixture is frozen at `now`; move it to the present so leases tick.
    if (!S.fixtureShift && Number.isFinite(snap?.now)) S.fixtureShift = got - snap.now;
    shiftTimes(snap, S.fixtureShift);
  } else if (Number.isFinite(snap?.now)) {
    S.skew = snap.now - (sent + got) / 2;
  } else {
    // The Date header has whole seconds: use it only for skews it can see.
    const date = Date.parse(res.headers.get('date') ?? '');
    if (Number.isFinite(date)) {
      const est = date + 500 - (sent + got) / 2;
      S.skewEst = S.skewEst === null ? est : S.skewEst * 0.8 + est * 0.2;
      S.skew = Math.abs(S.skewEst) > 1500 ? S.skewEst : 0;
    }
  }
  if (Number.isFinite(snap?.leaseMs) && snap.leaseMs > 0) S.leaseMs = snap.leaseMs;
  return snap;
}

function shiftTimes(snap, d) {
  if (!d || !snap) return;
  const bump = (o, k) => {
    if (o && Number.isFinite(o[k])) o[k] += d;
  };
  for (const n of snap.nodes ?? []) {
    bump(n.lease, 'expiresAt');
    bump(n.lease?.git, 'expiresAt');
    bump(n, 'hedgeUntil');
    for (const k of n.kept ?? []) bump(k, 'at');
  }
  for (const e of snap.events ?? []) bump(e, 'at');
  for (const p of snap.pushes ?? []) {
    bump(p, 'at');
    bump(p.checks, 'startedAt');
    bump(p.checks, 'finishedAt');
  }
}

function setConn(state, err) {
  const el = $('conn');
  if (el.dataset.state === state) return;
  el.dataset.state = state;
  const text = { live: 'live', offline: 'offline', fixture: 'fixture', connecting: 'connecting' }[state] ?? state;
  $('conn-text').textContent = text;
  el.title =
    state === 'live'
      ? 'Polling the graph every 1.5 s'
      : state === 'fixture'
        ? `Showing a saved snapshot: ${S.fixture}`
        : `Cannot reach the graph${err ? ` (${err.message})` : ''}; retrying`;
}

// ---------------------------------------------------------------- apply --

function apply(snap) {
  const next = new Map();
  for (const n of Array.isArray(snap?.nodes) ? snap.nodes : []) {
    if (n && typeof n.id === 'string' && (n.kind === 'claim' || n.kind === 'assumption' || n.kind === 'finding')) {
      next.set(n.id, n);
    }
  }
  const edges = (Array.isArray(snap?.edges) ? snap.edges : []).filter(
    (e) => e && next.has(e.source) && next.has(e.target) && typeof e.purpose === 'string',
  );
  const events = (Array.isArray(snap?.events) ? snap.events : [])
    .filter((e) => e && Number.isFinite(e.seq) && typeof e.type === 'string')
    .sort((a, b) => a.seq - b.seq);
  const pushes = (Array.isArray(snap?.pushes) ? snap.pushes : []).filter(
    (p) => p && typeof p.claim === 'string' && typeof p.sha === 'string',
  );
  const lines = Array.isArray(snap?.lines) ? snap.lines.filter((l) => l && typeof l.name === 'string') : null;

  const first = !S.loaded;
  const prev = S.nodes;
  const prevPushKeys = S.pushKeys;

  S.nodes = next;
  S.edges = edges;
  S.events = events;
  S.pushes = pushes;
  S.lines = lines;
  S.rel = relations([...next.values()], edges);
  indexPushes();
  indexStale();
  trackLeases();

  // What happened since the last poll: feed lines, and scenes to play.
  const fresh = events.filter((e) => e.seq > S.lastSeq);
  const scenes = feedFromEvents(fresh, first, prev);
  if (events.length) S.lastSeq = Math.max(S.lastSeq, events[events.length - 1].seq);
  if (!first) feedFromDiff(prev, next);
  feedFromPushes(pushes, first ? null : prevPushKeys);
  if (first && next.size) feedSummary();

  const key = structureKey(next, edges);
  if (key !== S.structKey) {
    S.structKey = key;
    relayout(first);
  }
  if (S.selected && !next.has(S.selected)) S.selected = null;
  renderNodes(first);
  applySelection();
  renderHeader(first);
  renderRealities();
  applyLineFocus();
  renderInspector();
  renderFeed();
  renderEmpty();
  for (const sc of scenes) {
    if (sc.type !== 'at_risk') continue;
    const prop = scenes.find((x) => x.type === 'propagation' && x.f.id === sc.fid);
    if (prop) {
      prop.landedAtRisk = sc.claims;
      sc.quiet = true;
    }
  }
  for (const sc of scenes) playScene(sc);
  if (S.selected && next.get(S.selected)?.kind === 'finding' && (!S.impact || Date.now() - S.impact.at > 3000)) {
    loadImpact(S.selected);
  }
  S.loaded = true;
}

function indexPushes() {
  S.pushRows = new Map();
  S.pushKeys = new Set();
  for (const p of S.pushes) {
    S.pushKeys.add(`${p.claim}@${p.sha}`);
    let rows = S.pushRows.get(p.claim);
    if (!rows) S.pushRows.set(p.claim, (rows = []));
    rows.push(p);
  }
  for (const rows of S.pushRows.values()) rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

function indexStale() {
  S.staleSeq = new Map();
  for (const e of S.events) {
    if (e.type === 'claim.stale') for (const c of e.claims ?? []) S.staleSeq.set(c, e.seq);
  }
}

// Lease length is not in the snapshot (yet): a lease seen right after it was
// taken or renewed has about a full lease left, so the longest such remainder
// is a good estimate. Renewals also flash the countdown.
function trackLeases() {
  const now = serverNow();
  for (const n of S.nodes.values()) {
    if (n.kind !== 'claim' || !n.lease || !Number.isFinite(n.lease.expiresAt)) continue;
    const before = S.expSeen.get(n.id);
    if (before === undefined || n.lease.expiresAt > before) {
      const rem = n.lease.expiresAt - now;
      if (rem > S.leaseEst) S.leaseEst = rem;
      if (before !== undefined && S.loaded) S.renewed.add(n.id);
    }
    S.expSeen.set(n.id, n.lease.expiresAt);
  }
}

function structureKey(nodes, edges) {
  const ids = [...nodes.values()]
    .map((n) => (n.kind === 'claim' ? `${n.id}:${n.cluster ?? ''}` : n.kind === 'finding' ? `${n.id}:${n.finder ?? ''}` : n.id))
    .sort()
    .join(',');
  const es = edges
    .map((e) => `${e.source}>${e.target}:${e.purpose}`)
    .sort()
    .join(',');
  return `${ids}|${es}`;
}

function displayStatus(n) {
  if (!n) return undefined;
  const h = S.hold.get(n.id);
  if (h) {
    if (Date.now() < h.until) return h.status;
    S.hold.delete(n.id);
  }
  return n.status;
}

// --------------------------------------------------------------- layout --

function fitPadding() {
  const strip = $('canvas').classList.contains('has-strip') ? 46 : 0;
  return narrowQuery.matches ? { t: 14 + strip, r: 14, b: 70, l: 14 } : { t: 26 + strip, r: 68, b: 84, l: 30 };
}

function canvasAspect() {
  const c = $('canvas');
  const p = fitPadding();
  const w = Math.max(200, c.clientWidth - p.l - p.r);
  const h = Math.max(200, c.clientHeight - p.t - p.b);
  return w / h;
}

function relayout(first) {
  const L = computeLayout([...S.nodes.values()], S.edges, { aspect: canvasAspect(), prev: S.pack });
  S.pack = { k: L.k, assign: L.assign };
  S.layout = L;
  S.routeByReal = new Map();
  for (const r of L.routes) if (r.real) S.routeByReal.set(r.real, r);

  // Tight bounds of the cards, for fitting.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of L.boxes.values()) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  S.content = Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 1, h: 1 };
  const svg = $('edges');
  svg.setAttribute('width', String(Math.ceil(Math.max(1, x1 + 200))));
  svg.setAttribute('height', String(Math.ceil(Math.max(1, y1 + 200))));

  // Cards that left the graph fade out.
  for (const [id, rec] of S.els) {
    if (L.boxes.has(id)) continue;
    rec.el.classList.add('is-leaving');
    later(450, () => rec.el.remove());
    S.els.delete(id);
    S.pos.delete(id);
  }
  syncPseudo(L.pseudo);
  syncEdges(L.routes);

  // New ids start where they will be; the rest glide there.
  const targets = new Map();
  for (const [id, b] of L.boxes) {
    targets.set(id, { x: b.x, y: b.y, w: b.w, h: b.h });
    if (!S.pos.has(id)) S.pos.set(id, { x: b.x, y: b.y, w: b.w, h: b.h });
  }
  for (const id of [...S.pos.keys()]) if (!targets.has(id)) S.pos.delete(id);
  if (first || reduceMotion) {
    for (const [id, b] of targets) S.pos.set(id, b);
    cancelAnimationFrame(S.raf);
    placeAll();
    drawEdges();
  } else {
    tweenTo(targets, 760);
  }
  renderEdges();
  if (S.follow) fit(!first);
}

function syncPseudo(list) {
  const keep = new Set(list.map((p) => p.id));
  for (const [id, el] of S.pseudoEls) {
    if (!keep.has(id)) {
      el.remove();
      S.pseudoEls.delete(id);
    }
  }
  for (const p of list) {
    let el = S.pseudoEls.get(p.id);
    if (!el) {
      el = document.createElement('div');
      $('nodes').prepend(el);
      S.pseudoEls.set(p.id, el);
    }
    el.className = `pseudo${p.cont ? ' cont' : ''}`;
    el.innerHTML = p.cont
      ? `<b>${esc(p.label)}</b> continued`
      : p.label === 'findings'
        ? 'Findings'
        : `No declared assumption${p.label && p.label !== 'main' ? ` · <b>${esc(p.label)}</b>` : ''}`;
  }
}

function syncEdges(routes) {
  const layer = $('edge-layer');
  const keep = new Set(routes.map((r) => r.key));
  for (const [k, el] of S.edgeEls) {
    if (!keep.has(k)) {
      el.remove();
      S.edgeEls.delete(k);
    }
  }
  for (const r of routes) {
    if (S.edgeEls.has(r.key)) continue;
    const p = document.createElementNS(SVGNS, 'path');
    layer.appendChild(p);
    S.edgeEls.set(r.key, p);
  }
}

const ease = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const lerp = (a, b, t) => a + (b - a) * t;

function tweenTo(targets, ms) {
  cancelAnimationFrame(S.raf);
  const from = new Map();
  for (const [id, b] of targets) from.set(id, { ...(S.pos.get(id) ?? b) });
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / ms);
    const e = ease(t);
    for (const [id, to] of targets) {
      const f = from.get(id);
      S.pos.set(id, { x: lerp(f.x, to.x, e), y: lerp(f.y, to.y, e), w: lerp(f.w, to.w, e), h: lerp(f.h, to.h, e) });
    }
    placeAll();
    drawEdges();
    if (t < 1) S.raf = requestAnimationFrame(step);
  };
  S.raf = requestAnimationFrame(step);
}

function place(el, p) {
  const t = `translate(${Math.round(p.x * 10) / 10}px, ${Math.round(p.y * 10) / 10}px)`;
  if (el._t !== t) {
    el.style.transform = t;
    el._t = t;
  }
  const w = Math.round(p.w * 10) / 10;
  const h = Math.round(p.h * 10) / 10;
  if (el._w !== w) {
    el.style.width = `${w}px`;
    el._w = w;
  }
  if (el._h !== h) {
    el.style.height = `${h}px`;
    el._h = h;
  }
}

function placeAll() {
  for (const [id, p] of S.pos) {
    const el = S.els.get(id)?.el ?? S.pseudoEls.get(id);
    if (el) place(el, p);
  }
}

function drawEdges() {
  const L = S.layout;
  if (!L) return;
  for (const r of L.routes) {
    const el = S.edgeEls.get(r.key);
    if (!el) continue;
    const d = routePath(r, S.pos, L.dim);
    if (el._d !== d) {
      el.setAttribute('d', d);
      el._d = d;
    }
  }
}

function renderEdges() {
  const L = S.layout;
  if (!L) return;
  for (const r of L.routes) {
    const el = S.edgeEls.get(r.key);
    if (!el) continue;
    const s = S.nodes.get(r.src);
    const cls = ['e', r.route === 'tree' ? 'tree' : r.route === 'cross' ? 'cross' : 'fdrop'];
    let marker = r.route === 'tree' ? null : 'm-edge';
    if (r.purpose === 'required for') {
      cls.push(s?.kind === 'claim' ? 'p-builds' : 'p-rests');
      if (s?.kind === 'assumption' && displayStatus(s) === 'contradicted') cls.push('to-contradicted');
    } else if (r.purpose === 'contradicts') {
      cls.push('p-contradicts', s?.status ?? '');
      marker = s?.status === 'verified' ? 'm-red' : s?.status === 'refuted' ? 'm-edge' : 'm-ember';
    } else if (r.purpose === 'supports') {
      cls.push('p-supports', s?.status ?? '');
      marker = s?.status === 'refuted' ? 'm-edge' : 'm-green';
    } else if (r.purpose === 'supersedes') {
      cls.push('p-supersedes');
    } else {
      cls.push('p-related');
    }
    if (S.hiEdges.has(r.key)) {
      cls.push('hi');
      if (marker) marker = 'm-hi';
    }
    if (S.riskEdges.has(r.key)) cls.push('risk');
    const c = cls.filter(Boolean).join(' ');
    if (el._c !== c) {
      el.setAttribute('class', c);
      el._c = c;
    }
    const m = marker ? `url(#${marker})` : '';
    if (el._m !== m) {
      if (m) el.setAttribute('marker-end', m);
      else el.removeAttribute('marker-end');
      el._m = m;
    }
  }
}

// ----------------------------------------------------------------- view --

function applyView() {
  const v = S.view;
  $('world').style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
}

function setFollow(on) {
  S.follow = on;
  $('canvas').classList.toggle('following', on);
}

function fitTarget() {
  const c = $('canvas');
  const p = fitPadding();
  const b = S.content;
  const vw = Math.max(1, c.clientWidth - p.l - p.r);
  const vh = Math.max(1, c.clientHeight - p.t - p.b);
  const k = clamp(Math.min(vw / b.w, vh / b.h), MIN_K, 1.1);
  return { k, x: p.l + (vw - b.w * k) / 2 - b.x * k, y: p.t + (vh - b.h * k) / 2 - b.y * k };
}

function fit(animate) {
  if (!S.layout) return;
  animateView(fitTarget(), animate && !reduceMotion ? 650 : 0);
}

function animateView(to, ms) {
  cancelAnimationFrame(S.viewRaf);
  if (!ms) {
    S.view = { ...to };
    applyView();
    return;
  }
  const from = { ...S.view };
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / ms);
    const e = ease(t);
    S.view = { x: lerp(from.x, to.x, e), y: lerp(from.y, to.y, e), k: lerp(from.k, to.k, e) };
    applyView();
    if (t < 1) S.viewRaf = requestAnimationFrame(step);
  };
  S.viewRaf = requestAnimationFrame(step);
}

function zoomAt(cx, cy, k) {
  cancelAnimationFrame(S.viewRaf);
  const v = S.view;
  const wx = (cx - v.x) / v.k;
  const wy = (cy - v.y) / v.k;
  S.view = { k, x: cx - wx * k, y: cy - wy * k };
  applyView();
}

function zoomBy(f) {
  const c = $('canvas');
  setFollow(false);
  const v = S.view;
  const k = clamp(v.k * f, MIN_K, MAX_K);
  const cx = c.clientWidth / 2;
  const cy = c.clientHeight / 2;
  const wx = (cx - v.x) / v.k;
  const wy = (cy - v.y) / v.k;
  animateView({ k, x: cx - wx * k, y: cy - wy * k }, reduceMotion ? 0 : 220);
}

// Bring a card into view (used when a chip in the feed is clicked).
function reveal(id) {
  const b = S.pos.get(id);
  if (!b) return;
  const c = $('canvas');
  const v = S.view;
  const k = Math.max(v.k, narrowQuery.matches ? 0.7 : 0.85);
  const inside =
    k === v.k &&
    b.x * v.k + v.x > 10 &&
    b.y * v.k + v.y > 10 &&
    (b.x + b.w) * v.k + v.x < c.clientWidth - 10 &&
    (b.y + b.h) * v.k + v.y < c.clientHeight - 60;
  if (inside) return;
  setFollow(false);
  const x = c.clientWidth / 2 - (b.x + b.w / 2) * k;
  const y = c.clientHeight / 2.2 - (b.y + b.h / 2) * k;
  animateView({ k, x, y }, reduceMotion ? 0 : 600);
}

function wireCanvas() {
  const canvas = $('canvas');
  const P = { pts: new Map(), moved: false, down: null, start: null, pinch: null };
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pinchState = () => {
    const [a, b] = [...P.pts.values()];
    return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dy = e.deltaY * unit;
      const k = clamp(S.view.k * Math.exp(-dy * (e.ctrlKey ? 0.0095 : 0.0017)), MIN_K, MAX_K);
      const p = local(e);
      zoomAt(p.x, p.y, k);
      setFollow(false);
    },
    { passive: false },
  );
  canvas.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.zoom, .legend, .strip')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    P.pts.set(e.pointerId, local(e));
    if (P.pts.size === 1) {
      P.moved = false;
      P.down = e.target;
      P.start = local(e);
    } else if (P.pts.size === 2) {
      const st = pinchState();
      P.pinch = { ...st, k: S.view.k, vx: S.view.x, vy: S.view.y };
      P.moved = true;
    }
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // some synthetic pointers cannot be captured
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = P.pts.get(e.pointerId);
    if (!p) return;
    const now = local(e);
    const dx = now.x - p.x;
    const dy = now.y - p.y;
    P.pts.set(e.pointerId, now);
    if (P.pts.size === 1) {
      if (!P.moved && Math.hypot(now.x - P.start.x, now.y - P.start.y) > 4) {
        P.moved = true;
        canvas.classList.add('panning');
        setFollow(false);
        cancelAnimationFrame(S.viewRaf);
      }
      if (P.moved) {
        S.view.x += dx;
        S.view.y += dy;
        applyView();
      }
    } else if (P.pts.size === 2 && P.pinch) {
      const st = pinchState();
      const k = clamp((P.pinch.k * st.dist) / P.pinch.dist, MIN_K, MAX_K);
      const wx = (P.pinch.mx - P.pinch.vx) / P.pinch.k;
      const wy = (P.pinch.my - P.pinch.vy) / P.pinch.k;
      S.view = { k, x: st.mx - wx * k, y: st.my - wy * k };
      applyView();
      setFollow(false);
    }
  });
  const up = (e) => {
    const had = P.pts.delete(e.pointerId);
    if (P.pts.size < 2) P.pinch = null;
    if (P.pts.size === 1) {
      // Lifting one finger of a pinch continues as a pan from where it is.
      P.start = [...P.pts.values()][0];
    }
    if (P.pts.size) return;
    canvas.classList.remove('panning');
    if (!had || P.moved || e.type !== 'pointerup') return;
    const nodeEl = P.down?.closest?.('.node');
    if (nodeEl) select(nodeEl.dataset.id === S.selected ? null : nodeEl.dataset.id);
    else if (!P.down?.closest?.('.zoom, .legend, .banner')) select(null);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('keydown', (e) => {
    const nodeEl = e.target.closest?.('.node');
    if (nodeEl && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      select(nodeEl.dataset.id);
    }
  });

  $('btn-zoom-in').addEventListener('click', () => zoomBy(1.25));
  $('btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
  $('btn-fit').addEventListener('click', () => {
    setFollow(true);
    fit(true);
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      select(null);
      if (S.lineFocus) focusLine(S.lineFocus);
    }
    else if (e.key === 'f' || e.key === 'F') {
      setFollow(true);
      fit(true);
    } else if (e.key === '+' || e.key === '=') zoomBy(1.25);
    else if (e.key === '-' || e.key === '_') zoomBy(0.8);
    else if (e.key === 'e' || e.key === 'E') toggleSide();
    else if (e.key === 't' || e.key === 'T') $('btn-theme').click();
  });

  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!S.layout) return;
      // A very different shape may want another column count; positions
      // only move when the new arrangement is clearly better.
      const before = S.pack?.k;
      const L = computeLayout([...S.nodes.values()], S.edges, { aspect: canvasAspect(), prev: S.pack });
      if (L.k !== before) relayout(false);
      else if (S.follow) fit(true);
    }, 160);
  }).observe(canvas);
}

// ----------------------------------------------------------- side panel --

function isNarrow() {
  return narrowQuery.matches;
}

function syncSideButton() {
  const closed = $('app').classList.contains('side-closed');
  $('btn-feed').setAttribute('aria-pressed', String(!closed));
}

function toggleSide(force) {
  const app = $('app');
  if (isNarrow()) {
    app.classList.toggle('sheet-open', force);
    return;
  }
  const closed = force === undefined ? !app.classList.contains('side-closed') : !force;
  app.classList.toggle('side-closed', closed);
  store.set(SIDE_KEY, closed ? 'closed' : 'open');
  syncSideButton();
}

function wireSide() {
  for (const id of ['realities', 'strip']) {
    $(id).addEventListener('click', (e) => {
      const chipEl = e.target.closest('.line-chip');
      if (chipEl) focusLine(chipEl.dataset.line);
    });
  }
  $('btn-feed').addEventListener('click', () => toggleSide());
  $('sheet-handle').addEventListener('click', () => $('app').classList.toggle('sheet-open'));
  $('side').addEventListener('click', (e) => {
    const ref = e.target.closest('[data-ref]');
    if (ref) {
      e.preventDefault();
      select(ref.dataset.ref, { reveal: true });
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') select(null);
    else if (act === 'reveal' && S.selected) reveal(S.selected);
  });
}

// ------------------------------------------------------------ selection --

function select(id, opts = {}) {
  if (id && !S.nodes.has(id)) return;
  const changed = S.selected !== (id || null);
  S.selected = id || null;
  if (changed) S.impact = null;
  applySelection();
  applyRisk();
  renderInspector();
  if (id) {
    if (isNarrow()) $('app').classList.add('sheet-open');
    else if ($('app').classList.contains('side-closed')) toggleSide(true);
    if (opts.reveal) reveal(id);
    if (S.nodes.get(id)?.kind === 'finding') loadImpact(id);
  }
}

// The selected card, what it rests on and what rests on it.
function relatedTo(id) {
  const out = new Set([id]);
  const n = S.nodes.get(id);
  if (!n) return out;
  const rel = S.rel;
  const up = (x) => {
    for (const p of [...(rel.assumptionParents.get(x) ?? []), ...(rel.claimParents.get(x) ?? [])]) {
      if (out.has(p)) continue;
      out.add(p);
      up(p);
    }
  };
  if (n.kind === 'claim') {
    up(id);
    for (const c of rel.dependents.get(id) ?? []) out.add(c);
    for (const c of rel.supersedes.get(id) ?? []) out.add(c);
    for (const c of rel.supersededBy.get(id) ?? []) out.add(c);
  } else if (n.kind === 'assumption') {
    for (const c of downstream(rel, [id]).keys()) out.add(c);
    for (const f of S.nodes.values()) if (f.kind === 'finding' && f.targets?.includes(id)) out.add(f.id);
  } else {
    for (const t of n.targets ?? []) out.add(t);
    if (n.finder) out.add(n.finder);
    if (n.effect !== 'helps') for (const c of downstream(rel, n.targets ?? []).keys()) out.add(c);
  }
  return out;
}

function applySelection() {
  const id = S.selected;
  $('canvas').classList.toggle('has-selection', !!id);
  const related = id ? relatedTo(id) : new Set();
  for (const [nid, rec] of S.els) {
    rec.el.classList.toggle('is-selected', nid === id);
    rec.el.classList.toggle('is-related', nid !== id && related.has(nid));
  }
  const hi = new Set();
  if (id && S.layout) {
    for (const r of S.layout.routes) if (r.src && related.has(r.src) && related.has(r.dst)) hi.add(r.key);
  }
  S.hiEdges = hi;
  // Highlighted edges draw last, above the rest.
  const layer = $('edge-layer');
  for (const k of hi) {
    const el = S.edgeEls.get(k);
    if (el) layer.appendChild(el);
  }
  renderEdges();
}

async function loadImpact(fid) {
  const f = S.nodes.get(fid);
  if (!f || S.impactLoading === fid) return;
  S.impactLoading = fid;
  try {
    await loadImpactNow(f, fid);
  } finally {
    S.impactLoading = null;
  }
}

async function loadImpactNow(f, fid) {
  let imp = null;
  if (!S.fixture) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(`/api/graphs/${encodeURIComponent(S.gid)}/findings/${encodeURIComponent(fid)}/impact`, {
        cache: 'no-store',
        signal: ctl.signal,
      });
      if (res.ok) imp = await res.json();
    } catch {
      // fall back to working it out here
    } finally {
      clearTimeout(timer);
    }
  }
  if (!imp || !Array.isArray(imp.affected)) imp = localImpact(f);
  if (S.selected !== fid) return;
  S.impact = {
    finding: fid,
    affected: imp.affected ?? [],
    landedAtRisk: imp.landedAtRisk ?? [],
    cost: Number(imp.cost) || 0,
    realities: Array.isArray(imp.realities) ? imp.realities : localRealities(imp.affected ?? [], imp.landedAtRisk ?? []),
    at: Date.now(),
  };
  applyRisk();
  renderInspector();
}

// The same reach the engine computes: everything downstream of the targets,
// except the finder and superseded claims; landed claims are counted apart.
function localImpact(f) {
  if (f.effect === 'helps') return { affected: [], landedAtRisk: [], cost: 0 };
  const affected = [];
  const landedAtRisk = [];
  let cost = 0;
  for (const id of downstream(S.rel, f.targets ?? []).keys()) {
    const c = S.nodes.get(id);
    if (!c || c.id === f.finder || c.status === 'superseded') continue;
    if (c.status === 'landed') landedAtRisk.push(id);
    else {
      affected.push(id);
      cost += c.pushes ?? 0;
    }
  }
  return { affected, landedAtRisk, cost, realities: localRealities(affected, landedAtRisk) };
}

function localRealities(affected, landedAtRisk) {
  const lineOf = new Map();
  for (const n of S.nodes.values()) if (n.kind === 'claim') lineOf.set(n.id, n.line || 'main');
  return realityLines().map((l) => {
    const mine = affected.filter((id) => lineOf.get(id) === l.name);
    const landed = landedAtRisk.filter((id) => lineOf.get(id) === l.name || (l.inherits ?? []).includes(id));
    return { line: l.name, served: !!l.served, affected: mine, landedAtRisk: landed, safe: !mine.length && !landed.length };
  });
}

// While an unverified finding is selected, outline what verifying it would stop.
function applyRisk() {
  const imp = S.impact;
  const f = imp ? S.nodes.get(imp.finding) : null;
  const on = !!(f && f.status === 'unverified' && S.selected === f.id);
  const risk = new Set(on ? [...imp.affected, ...imp.landedAtRisk] : []);
  for (const [id, rec] of S.els) rec.el.classList.toggle('is-risk', risk.has(id));
  S.riskEdges = new Set();
  if (on && S.layout) {
    const from = new Set([...risk, ...(f.targets ?? [])]);
    for (const r of S.layout.routes) if (r.src && from.has(r.src) && risk.has(r.dst)) S.riskEdges.add(r.key);
  }
  renderEdges();
}

// ---------------------------------------------------------------- cards --

function renderCtx() {
  const lineNames = new Set();
  for (const n of S.nodes.values()) if (n.kind === 'claim') lineNames.add(n.line || 'main');
  for (const l of S.lines ?? []) lineNames.add(l.name);
  const reach = new Map();
  for (const n of S.nodes.values()) {
    if (n.kind !== 'assumption') continue;
    let count = 0;
    for (const id of downstream(S.rel, [n.id]).keys()) if (S.nodes.get(id)?.status !== 'superseded') count++;
    reach.set(n.id, count);
  }
  const servedLine = S.lines?.find((l) => l.served)?.name ?? 'main';
  return { multiLine: lineNames.size > 1, servedLine, reach };
}

function renderNodes(first) {
  const ctx = renderCtx();
  for (const n of S.nodes.values()) renderNode(n, ctx, { quiet: first });
  S.renewed.clear();
}

function renderNodeById(id, quiet = true) {
  const n = S.nodes.get(id);
  if (n) renderNode(n, renderCtx(), { quiet });
}

function renderNode(n, ctx, { quiet = false } = {}) {
  const box = S.layout?.boxes.get(n.id);
  if (!box) return;
  let rec = S.els.get(n.id);
  if (!rec) {
    const el = document.createElement('div');
    el.dataset.id = n.id;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    $('nodes').appendChild(el);
    rec = { el, html: '', base: [], status: null, verdict: undefined };
    S.els.set(n.id, rec);
    place(el, S.pos.get(n.id) ?? box);
    if (S.loaded) addTemp(el, ['is-new'], 800);
  }
  const status = displayStatus(n);
  const html = n.kind === 'claim' ? claimHTML(n, status, ctx) : n.kind === 'assumption' ? assumptionHTML(n, status, ctx) : findingHTML(n, status, box);
  if (html !== rec.html) {
    rec.el.innerHTML = html;
    rec.html = html;
    tickWithin(rec.el);
  }
  const base = ['node', `k-${n.kind}`, `s-${status}`];
  if (n.kind === 'claim' && status === 'open' && openState(n).ready) base.push('is-ready');
  if (n.kind === 'claim' && status === 'landed' && contradictedUpstream(n.id).length) base.push('is-reality-risk');
  if (n.kind === 'claim' && status === 'done' && ['conflict', 'failed', 'error'].includes(n.landing?.status)) base.push('is-stuck');
  if (n.kind === 'finding') base.push(`fx-${n.effect === 'helps' ? 'helps' : 'contradicts'}`);
  for (const c of rec.base) if (!base.includes(c)) rec.el.classList.remove(c);
  for (const c of base) if (!rec.base.includes(c)) rec.el.classList.add(c);
  rec.base = base;
  rec.el.setAttribute('aria-label', `${n.kind} ${n.id}, ${status}: ${n.statement ?? ''}`);
  if (rec.status && rec.status !== status && !quiet) addTemp(rec.el, ['flash'], 1400);
  rec.status = status;
  if (n.kind === 'claim') {
    const v = verdictOf(headRow(n))?.key ?? null;
    if (rec.verdict !== undefined && v && v !== rec.verdict && !quiet) addTemp(rec.el.querySelector('.badge'), ['pop'], 700);
    rec.verdict = v;
    if (S.renewed.has(n.id)) addTemp(rec.el.querySelector('.cd'), ['renewed'], 1000);
  }
}

function headRow(c) {
  return c.headSha ? S.pushRows.get(c.id)?.find((r) => r.sha === c.headSha) : undefined;
}

const VERDICT_ICON = {
  passed: 'check',
  failed: 'x',
  scope: 'warn',
  verifier: 'warn',
  budget: 'clock',
  timeout: 'clock',
  skipped: 'dot',
  unverified: 'dot',
  running: 'spin',
  unknown: 'dot',
};

function badgeHTML(v, title = '') {
  return `<span class="badge ${v.tone}"${title ? ` title="${esc(title)}"` : ''}>${icon(VERDICT_ICON[v.key] ?? 'dot')}${esc(v.label)}</span>`;
}

function hue(s) {
  let h = 7;
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

function agentHTML(name, gone = false) {
  const initial = (String(name).match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase();
  return `<span class="agent${gone ? ' gone' : ''}" title="Agent ${esc(name)}"><span class="av" style="--h:${hue(name)}">${esc(initial)}</span><span class="name">${esc(name)}</span></span>`;
}

// A claim that builds on another waits for it to land: its fork then
// contains the work it builds on.
function openState(c) {
  const waits = [];
  const blocked = [];
  for (const a of S.rel.assumptionParents.get(c.id) ?? []) if (S.nodes.get(a)?.status !== 'holding') blocked.push(a);
  for (const p of S.rel.claimParents.get(c.id) ?? []) if (S.nodes.get(p)?.status !== 'landed') waits.push(p);
  return { ready: !waits.length && !blocked.length, waits, blocked };
}

function waitsText(waits) {
  const done = waits.filter((p) => S.nodes.get(p)?.status === 'done');
  const list = waits.slice(0, 3).join(', ') + (waits.length > 3 ? '…' : '');
  return done.length === waits.length ? `waits for ${list} to land` : `waits on ${list}`;
}

const LANDING_WORDS = {
  queued: 'queued to land',
  landing: 'landing…',
  conflict: 'conflict',
  failed: 'checks failed after merge',
  error: 'landing error',
};

// Contradicted assumptions under a claim, directly or through what it builds on.
function contradictedUpstream(id, seen = new Set()) {
  const out = [];
  for (const a of S.rel.assumptionParents.get(id) ?? []) if (S.nodes.get(a)?.status === 'contradicted' && !out.includes(a)) out.push(a);
  for (const p of S.rel.claimParents.get(id) ?? []) {
    if (seen.has(p)) continue;
    seen.add(p);
    for (const a of contradictedUpstream(p, seen)) if (!out.includes(a)) out.push(a);
  }
  return out;
}

function told(c) {
  const seq = S.staleSeq.get(c.id);
  return !!(c.lease && seq !== undefined && c.lease.cursor >= seq);
}

function claimHTML(c, status, ctx) {
  const tags = [];
  if (c.version > 1) tags.push(`<span class="c-tag" title="Re-planned: version ${esc(c.version)}">v${esc(c.version)}</span>`);
  if (ctx.multiLine && (c.line || 'main') !== ctx.servedLine) {
    tags.push(`<span class="c-tag line" title="On line ${esc(c.line || 'main')}, not the served one">${icon('branch')}${esc(c.line || 'main')}</span>`);
  }
  // Assumptions it also rests on, besides the one it hangs under.
  const primary = S.layout?.primary.get(c.id);
  for (const a of S.rel.assumptionParents.get(c.id) ?? []) {
    if (a === primary) continue;
    const bad = S.nodes.get(a)?.status === 'contradicted';
    tags.push(`<span class="c-tag also${bad ? ' bad' : ''}" title="Also rests on ${esc(a)}: ${esc(S.nodes.get(a)?.statement ?? '')}">+${esc(a)}</span>`);
  }
  let right = '';
  const kept = c.kept?.length ? c.kept[c.kept.length - 1] : null;
  if (status === 'stale' && kept) {
    right = `<span class="kept" title="Work kept at ${esc(kept.sha)}: ${esc(kept.reason)}">${icon('branch')}${esc(shortSha(kept.sha))}</span>`;
  } else if (status === 'done' && (c.landing?.status === 'conflict' || c.landing?.status === 'failed' || c.landing?.status === 'error')) {
    right = `<span class="badge bad">${icon('warn')}${esc(c.landing.status === 'conflict' ? 'conflict' : 'not landed')}</span>`;
  } else {
    const head = headRow(c);
    const v = verdictOf(head);
    if (v) right = badgeHTML(v, `Verdict on ${shortSha(head.sha)}`);
  }
  const now = serverNow();
  const lease = c.lease;
  const live = !!(lease && lease.expiresAt > now);
  let foot = '';
  let bar = '';
  switch (status) {
    case 'claimed':
      if (lease && live) {
        foot = `${agentHTML(lease.holder)}<span class="grow"></span><span class="cd" data-exp="${lease.expiresAt}" data-mode="lease" title="Lease ends in">${icon('clock')}<span class="t"></span></span>`;
        bar = `<div class="lease" data-bar="${lease.expiresAt}"><i></i></div>`;
      } else if (lease) {
        foot = `${agentHTML(lease.holder, true)}<span class="grow"></span><span class="told" title="Its agent stopped renewing; the next agent can take it over">lapsed · up for grabs</span>`;
      } else foot = '<span class="grow">no live lease</span>';
      break;
    case 'stale': {
      if (!lease) {
        foot = `<span class="grow">${kept ? 'work kept · ' : ''}waiting to be re-planned</span>`;
      } else if (!live) {
        foot = `${agentHTML(lease.holder, true)}<span class="grow"></span><span class="told yes">lease ended</span>`;
      } else if (told(c)) {
        foot = `${agentHTML(lease.holder)}<span class="grow"></span><span class="told yes" title="Its last lease renewal carried the news">${icon('check')}agent told</span>`;
      } else {
        foot = `${agentHTML(lease.holder)}<span class="grow"></span><span class="told" title="The agent learns at its next lease renewal">${icon('told')}learns at renewal</span>`;
      }
      break;
    }
    case 'open': {
      const st = openState(c);
      if (st.ready) foot = `<span class="grow ready">ready to claim</span>`;
      else if (st.blocked.length) foot = `<span class="grow blocked">blocked: ${esc(st.blocked.join(', '))} contradicted</span>`;
      else foot = `<span class="grow">${esc(waitsText(st.waits))}</span>`;
      break;
    }
    case 'done': {
      const l = c.landing;
      if (l?.status === 'landing') foot = `<span class="grow landing-run">${icon('spin')}landing on ${esc(c.line || 'main')}…</span>`;
      else if (l?.status === 'conflict') foot = `<span class="grow landing-bad">${icon('warn')}conflict in ${plural(l.files?.length ?? 0, 'file')}</span>`;
      else if (l?.status === 'failed' || l?.status === 'error') foot = `<span class="grow landing-bad">${icon('warn')}${esc(LANDING_WORDS[l.status])}</span>`;
      else if (l?.status === 'queued') foot = '<span class="grow">done · queued to land</span>';
      else {
        const waits = (S.rel.claimParents.get(c.id) ?? []).filter((p) => S.nodes.get(p)?.status !== 'landed');
        foot = `<span class="grow">done · ${waits.length ? esc(`lands after ${waits.slice(0, 2).join(', ')}`) : 'awaiting landing'}</span>`;
      }
      break;
    }
    case 'landed': {
      const bad = contradictedUpstream(c.id);
      foot = bad.length
        ? `<span class="grow blocked" title="It rests on ${esc(bad.join(', '))}, now contradicted">landed · at risk: ${esc(bad.join(', '))} contradicted</span>`
        : `<span class="grow">landed on <b>${esc(c.line || 'main')}</b></span>${c.landedSha ? `<span class="kept" title="Merge commit ${esc(c.landedSha)}">${esc(shortSha(c.landedSha))}</span>` : ''}`;
      break;
    }
    case 'superseded': {
      const by = S.rel.supersededBy.get(c.id) ?? [];
      foot = `<span class="grow">superseded${by.length ? ` by ${esc(by.join(', '))}` : ''}</span>`;
      break;
    }
    default:
      foot = '';
  }
  return `<div class="card"><div class="c-top"><span class="c-id">${esc(c.id)}</span><span class="c-status">${esc(STATUS_LABEL[status] ?? status)}</span>${tags.join('')}<span class="c-sp"></span>${right}</div><div class="c-text">${esc(c.statement)}</div><div class="c-foot">${foot}</div>${bar}</div>`;
}

function assumptionHTML(a, status, ctx) {
  const n = ctx.reach.get(a.id) ?? 0;
  const bad = status === 'contradicted';
  return `<div class="card"><div class="a-top"><span class="a-id">${esc(a.id)}</span>${
    bad ? `<span class="a-status">${icon('bolt')} Contradicted</span>` : '<span class="a-kind">Assumption</span>'
  }<span class="a-count" title="${n} ${n === 1 ? 'claim rests' : 'claims rest'} on it, directly or through claims built on them">${n ? `${n} rest on it` : 'nothing rests on it'}</span></div><div class="a-text">${esc(a.statement)}</div></div>`;
}

function findingHTML(f, status, box) {
  const w = Math.round(box.w);
  const h = Math.round(box.h);
  const tip = 18;
  const pts = `${tip},1 ${w - tip},1 ${w - 1},${h / 2} ${w - tip},${h - 1} ${tip},${h - 1} 1,${h / 2}`;
  const label = status === 'unverified' ? 'Unverified' : status === 'verified' ? 'Verified' : status === 'refuted' ? 'Refuted' : status;
  const meta =
    status === 'unverified' && Number.isFinite(f.hedgeUntil)
      ? `<span class="f-meta cd" data-exp="${f.hedgeUntil}" data-mode="hedge" title="Hedge: it runs beside the others; a decision is due when this ends">${icon('hedge')}<span class="t"></span></span>`
      : f.finder
        ? `<span class="f-meta" title="Filed by ${esc(f.finder)}">by ${esc(f.finder)}</span>`
        : '';
  const kind = f.effect === 'helps' ? 'helps' : '';
  return `<div class="card"><svg class="f-shape" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polygon points="${pts}"/></svg><div class="f-body"><div class="f-top"><span class="f-id">${esc(f.id)}</span><span class="f-status">${esc(label)}${kind ? ' · helps' : ''}</span>${meta}</div><div class="f-text">${esc(f.statement)}</div></div></div>`;
}

function addTemp(el, classes, ms) {
  if (!el) return;
  el.classList.remove(...classes);
  void el.offsetWidth; // restart the animation
  el.classList.add(...classes);
  el._tmp ??= {};
  for (const c of classes) {
    clearTimeout(el._tmp[c]);
    el._tmp[c] = setTimeout(() => el.classList.remove(c), ms);
  }
}

// ---------------------------------------------------------------- ticks --

function tick() {
  S.ticks++;
  const now = serverNow();
  for (const el of document.querySelectorAll('[data-exp]')) tickCountdown(el, now);
  const full = leaseFull();
  for (const el of document.querySelectorAll('[data-bar]')) {
    const rem = Number(el.dataset.bar) - now;
    const frac = clamp(rem / full, 0, 1);
    const i = el.firstElementChild;
    const t = `scaleX(${frac.toFixed(4)})`;
    if (i && i._t !== t) {
      i.style.transform = t;
      i._t = t;
    }
    el.classList.toggle('low', rem < 20_000);
  }
  if (S.ticks % 4 === 0) renderHeader(false, true);
  if (S.ticks % 12 === 0) {
    for (const t of document.querySelectorAll('time[data-at]')) {
      const s = ago(now - Number(t.dataset.at));
      if (t.textContent !== s) t.textContent = s;
    }
  }
}

function tickCountdown(el, now) {
  const rem = Number(el.dataset.exp) - now;
  const mode = el.dataset.mode;
  const t = el.querySelector('.t') ?? el;
  let text;
  let low = false;
  let lapsed = false;
  if (mode === 'lease') {
    if (rem <= 0) {
      text = 'lapsed';
      lapsed = true;
    } else {
      text = clock(rem);
      low = rem < 20_000;
    }
  } else if (mode === 'hedge') {
    text = rem <= 0 ? 'decision due' : clock(rem);
  } else text = clock(rem);
  if (t.textContent !== text) t.textContent = text;
  el.classList.toggle('low', low);
  el.classList.toggle('lapsed', lapsed);
}

function tickWithin(root) {
  const now = serverNow();
  for (const el of root.querySelectorAll('[data-exp]')) tickCountdown(el, now);
  const full = leaseFull();
  for (const el of root.querySelectorAll('[data-bar]')) {
    const i = el.firstElementChild;
    if (!i) continue;
    i.style.transition = 'none';
    const t = `scaleX(${clamp((Number(el.dataset.bar) - now) / full, 0, 1).toFixed(4)})`;
    i.style.transform = t;
    i._t = t;
    void i.offsetWidth;
    i.style.transition = '';
  }
}

// --------------------------------------------------------------- header --

function renderHeader(first, quiet = false) {
  const el = $('stats');
  if (!el._built) {
    el.innerHTML = `<div class="statgroup"><span class="big" title="Claims in this graph"><b data-k="claims">0</b><span>claims</span></span><div class="dist" aria-hidden="true">${STATUSES.map(
      (s) => `<i class="st-${s}" data-d="${s}" hidden></i>`,
    ).join('')}</div><div class="chips-status">${STATUSES.map(
      (s) => `<span class="stat st-${s}" data-s="${s}" title="${STATUS_LABEL[s]}"><i></i><b>0</b><span class="lbl">${s}</span></span>`,
    ).join('')}</div></div><span class="sep"></span><span class="big agents" title="Agents holding a live lease right now">${icon('agent')}<b data-k="agents">0</b><span>agents live</span></span><span class="sep"></span><span class="big findings" title="Findings filed in this graph">${icon('finding')}<b data-k="findings">0</b><span data-k="findings-word">findings</span><span class="hedging" data-k="hedging"></span></span>`;
    el._built = true;
  }
  const claims = [];
  const findings = [];
  for (const n of S.nodes.values()) {
    if (n.kind === 'claim') claims.push(n);
    else if (n.kind === 'finding') findings.push(n);
  }
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const c of claims) {
    const s = displayStatus(c);
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const now = serverNow();
  const holders = new Set();
  for (const c of claims) if (c.lease && c.lease.expiresAt > now && (c.status === 'claimed' || c.status === 'stale')) holders.add(c.lease.holder);
  const hedging = findings.filter((f) => f.status === 'unverified').length;

  const setNum = (k, v) => {
    const b = el.querySelector(`[data-k="${k}"]`);
    if (b && b.textContent !== String(v)) b.textContent = String(v);
  };
  setNum('claims', claims.length);
  setNum('agents', holders.size);
  setNum('findings', findings.length);
  el.querySelector('[data-k="findings-word"]').textContent = findings.length === 1 ? 'finding' : 'findings';
  el.querySelector('[data-k="hedging"]').textContent = hedging ? `· ${hedging} hedging` : '';
  if (quiet) return;
  for (const s of STATUSES) {
    const c = el.querySelector(`[data-s="${s}"]`);
    const b = c.querySelector('b');
    const v = String(counts[s]);
    if (b.textContent !== v) {
      b.textContent = v;
      if (!first && S.loaded) addTemp(c, ['bump'], 1200);
    }
    c.classList.toggle('zero', !counts[s]);
    c.hidden = s === 'superseded' && !counts[s];
    const seg = el.querySelector(`[data-d="${s}"]`);
    seg.hidden = !counts[s];
    seg.style.flexGrow = String(counts[s]);
  }
}

// The realities: every line, which one is served, how many claims build on
// each, and the decision a line is an option of. Click one to pick out its claims.
function realityLines() {
  const lines = (S.lines ?? []).map((l) => ({ ...l }));
  for (const n of S.nodes.values()) {
    if (n.kind !== 'claim') continue;
    const name = n.line || 'main';
    if (!lines.some((l) => l.name === name)) lines.push({ name, served: false, implicit: true });
  }
  if (lines.length && !lines.some((l) => l.served)) (lines.find((l) => l.name === 'main') ?? lines[0]).served = true;
  return lines;
}

function renderRealities() {
  const head = $('realities');
  const strip = $('strip');
  const lines = realityLines();
  const canvas = $('canvas');
  if (!lines.length) {
    head.hidden = true;
    strip.hidden = true;
    canvas.classList.remove('has-strip');
    S.served = undefined;
    return;
  }
  const count = new Map();
  for (const c of S.nodes.values()) {
    if (c.kind === 'claim' && c.status !== 'superseded') count.set(c.line || 'main', (count.get(c.line || 'main') ?? 0) + 1);
  }
  const served = lines.find((l) => l.served);
  const titleOf = (l) => {
    const n = count.get(l.name) ?? 0;
    return [
      `${l.served ? 'Served reality' : 'Not served'}: line ${l.name}`,
      l.decision ? `Decision: ${l.decision}` : '',
      l.option ? `Option: ${l.option}` : '',
      l.from ? `Forked from ${l.from}${l.inherits?.length ? `, carrying ${l.inherits.join(', ')}` : ''}` : '',
      l.head ? `Head ${shortSha(l.head)}` : 'No commits landed yet',
      l.landing ? `Landing ${l.landing.claim} now` : '',
      `${plural(n, 'claim')} build on it`,
      'Click to pick out its claims',
    ]
      .filter(Boolean)
      .join('\n');
  };
  const chipOf = (l, withOption) => {
    const opt = withOption && l.option ? `<span class="opt">${esc(l.option.length > 34 ? `${l.option.slice(0, 33)}…` : l.option)}</span>` : '';
    const spin = l.landing ? `<span class="spin" title="Landing ${esc(l.landing.claim)}">${icon('spin')}</span>` : '';
    return `<button type="button" class="line-chip${l.served ? ' served' : ''}${S.lineFocus === l.name ? ' focused' : ''}" data-line="${esc(l.name)}" title="${esc(titleOf(l))}">${
      l.served ? icon('reality') : '<i class="ring"></i>'
    }<b>${esc(l.name)}</b>${opt}<span class="n">${count.get(l.name) ?? 0}</span>${spin}</button>`;
  };

  // The header: which reality is served, and the app it serves.
  const link = `<a class="icon-btn served-link" href="/served/${encodeURIComponent(S.gid)}/" target="_blank" rel="noopener" title="Open the served app (${esc(served.name)})" aria-label="Open the served app">${icon('external')}</a>`;
  const headHtml = `<span class="eyebrow">Serving</span>${chipOf(served, false)}${link}`;
  if (head._html !== headHtml) {
    head.innerHTML = headHtml;
    head._html = headHtml;
  }
  head.hidden = false;

  // The strip: every reality, options of one decision side by side.
  const many = lines.length > 1;
  if (many) {
    const groups = new Map();
    const loose = [];
    for (const l of lines) {
      if (!l.decision) loose.push(l);
      else {
        if (!groups.has(l.decision)) groups.set(l.decision, []);
        groups.get(l.decision).push(l);
      }
    }
    // A fork made as "the other option" leaves its source as the first one.
    for (const ls of groups.values()) {
      if (ls.length !== 1 || !ls[0].from) continue;
      const i = loose.findIndex((l) => l.name === ls[0].from);
      if (i >= 0) ls.unshift(...loose.splice(i, 1));
    }
    const parts = [];
    for (const [decision, ls] of groups) {
      parts.push(
        `<span class="decision" title="${esc(decision)}">${esc(decision.length > 56 ? `${decision.slice(0, 55)}…` : decision)}</span>${ls
          .map((l) => chipOf(l, true))
          .join('<span class="or">or</span>')}`,
      );
    }
    if (loose.length) parts.push(loose.map((l) => chipOf(l, true)).join(''));
    const stripHtml = `<span class="eyebrow">Realities</span>${parts.join('<span class="sep"></span>')}`;
    if (strip._html !== stripHtml) {
      strip.innerHTML = stripHtml;
      strip._html = stripHtml;
    }
  }
  if (strip.hidden === many || canvas.classList.contains('has-strip') !== many) {
    strip.hidden = !many;
    canvas.classList.toggle('has-strip', many);
    if (S.follow && S.layout) fit(S.loaded);
  }

  const prev = S.served;
  S.served = served.name;
  // A switch seen without its event (after a reconnect, say) still shows.
  if (prev !== undefined && prev !== served.name && !S.servedEventSeen) flashServed();
  S.servedEventSeen = false;
}

function flashServed() {
  for (const el of document.querySelectorAll('#realities .line-chip.served, #strip .line-chip.served')) addTemp(el, ['switched'], 2500);
}

function applyLineFocus() {
  const on = !!S.lineFocus;
  $('canvas').classList.toggle('has-line-focus', on);
  for (const [id, rec] of S.els) {
    const n = S.nodes.get(id);
    rec.el.classList.toggle('on-line', on && n?.kind === 'claim' && (n.line || 'main') === S.lineFocus);
  }
}

function focusLine(name) {
  S.lineFocus = S.lineFocus === name ? null : name;
  applyLineFocus();
  renderRealities();
}

function renderEmpty() {
  const el = $('empty');
  const empty = S.nodes.size === 0;
  el.hidden = !empty;
  if (!empty || el._done) return;
  el._done = true;
  el.innerHTML = `<div class="empty-card"><p class="eyebrow">Graph ${esc(S.gid)}</p><h2>Nothing planned here yet</h2><p>A planner adds assumptions and claims to a graph; agents then claim the work, push, and file findings. This page fills in live as they do.</p>${
    S.gid !== 'demo' ? '<p><a class="pill primary" href="/g/demo">Open the demo graph</a></p>' : '<p>Seed it with <code>node scripts/seed-demo.mjs</code>.</p>'
  }</div>`;
}

// ----------------------------------------------------------------- feed --

function addFeed(item) {
  if (S.feedKeys.has(item.key)) return;
  S.feedKeys.add(item.key);
  S.feed.push(item);
  S.feedDirty = true;
}

function feedFromEvents(list, first, prev) {
  const scenes = [];
  const used = new Set();
  for (const ev of list) {
    if (used.has(ev.seq)) continue;
    const stale = [];
    if (ev.type === 'finding.verified') {
      const fid = ev.data?.finding;
      for (const e of list) {
        if (e.seq > ev.seq && e.type === 'claim.stale' && e.data?.finding === fid && !used.has(e.seq)) {
          used.add(e.seq);
          stale.push(...(e.claims ?? []));
        }
      }
    }
    const d = describeEvent(ev, { nodes: S.nodes, stale });
    addFeed({ key: `e${ev.seq}`, at: ev.at, seq: ev.seq, tone: d.tone, icon: d.icon, html: d.html, fresh: !first });
    if (!first) {
      const sc = sceneFor(ev, stale, prev);
      if (sc) scenes.push(sc);
    }
  }
  return scenes;
}

function feedFromDiff(prev, next) {
  const now = serverNow();
  for (const [id, n] of next) {
    if (n.kind !== 'claim') continue;
    const p = prev.get(id);
    const push = (it) => addFeed({ key: `d${++S.diffSeq}`, at: now, fresh: true, ...it });
    if (!p) {
      push({ tone: 'muted', icon: 'plus-c', html: `${chip(id, next)} planned<span class="q">“${esc(n.statement)}”</span>` });
      continue;
    }
    if (p.status !== n.status) {
      if (n.status === 'claimed' && p.status === 'open') {
        push({ tone: 'claim', icon: 'agent', html: `${agentHTML(n.lease?.holder ?? 'an agent')} claimed ${chip(id, next)}` });
      } else if (n.status === 'done') {
        push({ tone: 'good', icon: 'check', html: `${chip(id, next)} done${p.lease ? ` by ${agentHTML(p.lease.holder)}` : ''} — awaiting landing` });
      } else if (n.status === 'open' && p.status === 'claimed') {
        push({ tone: 'muted', icon: 'back', html: `${p.lease ? agentHTML(p.lease.holder) : 'Its agent'} released ${chip(id, next)}` });
      } else if (n.status === 'superseded') {
        push({ tone: 'muted', icon: 'redo', html: `${chip(id, next)} superseded` });
      }
    } else if (n.lease && p.lease && n.lease.holder !== p.lease.holder) {
      push({ tone: 'claim', icon: 'agent', html: `${agentHTML(n.lease.holder)} took over ${chip(id, next)} from ${esc(p.lease.holder)}` });
    } else if (n.lease && !p.lease && n.status === 'stale') {
      push({ tone: 'claim', icon: 'agent', html: `${agentHTML(n.lease.holder)} took ${chip(id, next)} to re-plan it` });
    }
    // The agent of a stale claim learns at its next renewal.
    if (n.status === 'stale' && n.lease && p.lease && n.lease.holder === p.lease.holder) {
      const seq = S.staleSeq.get(id);
      if (seq !== undefined && n.lease.cursor >= seq && p.lease.cursor < seq) {
        addFeed({
          key: `told:${id}:${seq}`,
          at: now,
          fresh: true,
          tone: 'stale',
          icon: 'told',
          html: `${agentHTML(n.lease.holder)} learned ${chip(id, next)} is stale <span class="sub">At its lease renewal: the reply carried the finding.</span>`,
        });
      }
    }
  }
}

// One line on arrival: what the graph looks like right now.
function feedSummary() {
  const now = serverNow();
  let claims = 0;
  let landed = 0;
  let stale = 0;
  const holders = new Set();
  for (const n of S.nodes.values()) {
    if (n.kind !== 'claim') continue;
    claims++;
    if (n.status === 'landed') landed++;
    if (n.status === 'stale') stale++;
    if (n.lease && n.lease.expiresAt > now && n.status === 'claimed') holders.add(n.lease.holder);
  }
  // It sits below everything that already happened: it marks the arrival.
  addFeed({
    key: 'summary',
    at: now,
    sort: -1,
    label: 'arrived',
    tone: 'muted',
    icon: 'reality',
    html: `Watching <b>${plural(claims, 'claim')}</b>: ${plural(holders.size, 'agent')} at work, ${landed} landed${stale ? `, <b>${stale} stale</b>` : ''}.<span class="sub">New findings, pushes and verdicts appear here as they land.</span>`,
  });
}

function feedFromPushes(pushes, prevKeys) {
  for (const r of pushes) {
    const key = `${r.claim}@${r.sha}`;
    if (prevKeys && prevKeys.has(key)) continue;
    const d = describePush(r, S.nodes);
    addFeed({ key: `p:${key}`, at: r.at, tone: d.tone, icon: d.icon, html: d.html, fresh: !!prevKeys });
  }
}

function renderFeed() {
  if (!S.feedDirty) return;
  S.feedDirty = false;
  const key = (it) => it.sort ?? it.at ?? 0;
  S.feed.sort((a, b) => key(b) - key(a) || (b.seq ?? 0) - (a.seq ?? 0));
  if (S.feed.length > 400) for (const it of S.feed.splice(400)) S.feedKeys.delete(it.key);
  const now = serverNow();
  $('feed-list').innerHTML = S.feed
    .map(
      (it) =>
        `<li class="ev t-${esc(it.tone)}${it.fresh ? ' fresh' : ''}"><span class="ev-i">${icon(it.icon)}</span><div class="ev-text">${it.html}</div>${
          it.label
            ? `<time title="${esc(timeOfDay(it.at))}">${esc(it.label)}</time>`
            : `<time data-at="${it.at}" title="${esc(timeOfDay(it.at))}">${ago(now - it.at)}</time>`
        }</li>`,
    )
    .join('');
  for (const it of S.feed) it.fresh = false;
  $('feed-empty').hidden = S.feed.length > 0;
  $('feed-meta').textContent = S.feed.length ? plural(S.feed.length, 'event') : '';
  $('sheet-title').textContent = S.feed.length ? `Events · ${S.feed.length}` : 'Events';
}

// --------------------------------------------------------------- scenes --

function sceneFor(ev, stale, prev) {
  const fid = typeof ev.data?.finding === 'string' ? ev.data.finding : null;
  switch (ev.type) {
    case 'finding.verified': {
      const f = S.nodes.get(fid);
      if (!f) return null;
      if (f.effect === 'helps') return { type: 'helped', f, claims: f.targets ?? [] };
      return planPropagation(f, stale, prev);
    }
    case 'finding.filed':
      return fid ? { type: 'filed', fid } : null;
    case 'finding.refuted':
      return fid ? { type: 'refuted', fid } : null;
    case 'claim.replanned':
      return { type: 'replanned', claims: ev.claims ?? [] };
    case 'reality.at_risk':
      return { type: 'at_risk', claims: ev.claims ?? [], fid };
    case 'reality.served':
      S.servedEventSeen = true;
      return { type: 'served', line: ev.data?.line, previous: ev.data?.previous ?? null };
    case 'claim.landing_failed':
      return { type: 'landing_failed', claims: ev.claims ?? [], status: ev.data?.status, files: ev.data?.files ?? [] };
    case 'scope.touched':
      return { type: 'touched', claims: ev.claims ?? [] };
    default:
      return null;
  }
}

// The ripple: the assumption is hit first, then each ring of claims resting
// on it, nearest first. Until the ripple reaches a card it keeps showing its
// old status, so the change reads as cause and effect.
function planPropagation(f, stale, prev) {
  const targets = (f.targets ?? []).filter((t) => S.nodes.get(t)?.kind === 'assumption');
  const depth = downstream(S.rel, targets);
  const T_HIT = reduceMotion ? 0 : 350;
  const T_FIRST = reduceMotion ? 0 : 1050;
  const STEP = reduceMotion ? 0 : 800;
  const now = Date.now();
  const hits = [];
  let last = T_FIRST;
  for (const id of stale) {
    const d = depth.get(id) ?? 1;
    const at = T_FIRST + (d - 1) * STEP;
    last = Math.max(last, at);
    hits.push({ id, d, at });
    S.hold.set(id, { status: prev.get(id)?.status ?? 'claimed', until: now + at });
  }
  for (const a of targets) S.hold.set(a, { status: prev.get(a)?.status ?? 'holding', until: now + T_HIT });
  return { type: 'propagation', f, targets, hits, depth, T_HIT, last };
}

function playScene(sc) {
  const elOf = (id) => S.els.get(id)?.el;
  switch (sc.type) {
    case 'propagation': {
      const { f, targets, hits, T_HIT, last } = sc;
      const linger = last + 6500;
      addTemp(elOf(f.id), ['scene-src', 'scene-glow'], linger);
      later(T_HIT, () => {
        for (const a of targets) {
          renderNodeById(a);
          addTemp(elOf(a), ['scene-hit', 'scene-glow'], linger - T_HIT);
        }
        renderEdges();
        renderHeader(false);
      });
      const affected = new Set(hits.map((h) => h.id));
      for (const h of hits) {
        const parents = [...(S.rel.assumptionParents.get(h.id) ?? []), ...(S.rel.claimParents.get(h.id) ?? [])];
        for (const p of parents) {
          if (!targets.includes(p) && !affected.has(p)) continue;
          const r = S.routeByReal.get(`${p}>${h.id}:required for`);
          if (r) later(Math.max(0, h.at - 700), () => flowAlong(r));
        }
        later(h.at, () => {
          renderNodeById(h.id);
          addTemp(elOf(h.id), ['scene-stale'], 1600);
          addTemp(elOf(h.id), ['scene-glow'], Math.max(1600, linger - h.at));
          renderHeader(false);
          if (S.selected) renderInspector();
        });
      }
      const now = serverNow();
      const working = [...S.nodes.values()].filter(
        (n) => n.kind === 'claim' && n.status === 'claimed' && !affected.has(n.id) && n.lease && n.lease.expiresAt > now,
      ).length;
      const as = targets.map((a) => `<b>${esc(a)}</b>`).join(', ');
      const risk = sc.landedAtRisk?.length
        ? ` · <b class="stale">${plural(sc.landedAtRisk.length, 'landed claim')} at risk</b>`
        : '';
      later(T_HIT, () =>
        showBanner({
          tone: 'stale',
          icon: 'bolt',
          eyebrow: 'Finding verified',
          html: `<b>${esc(f.id)}</b> contradicts ${as || 'an assumption'} → <b class="stale">${plural(hits.length, 'claim')} stale</b>${risk} <span class="ok">· ${working} keep working</span>`,
          ms: last + 7000,
        }),
      );
      for (const id of sc.landedAtRisk ?? []) later(T_FIRST, () => addTemp(elOf(id), ['scene-stale'], 1600));
      break;
    }
    case 'filed': {
      const f = S.nodes.get(sc.fid);
      addTemp(elOf(sc.fid), ['flash'], 1400);
      if (!f) break;
      const targets = (f.targets ?? []).map((t) => `<b>${esc(t)}</b>`).join(', ');
      showBanner({
        tone: 'hedge',
        icon: 'finding',
        eyebrow: 'New finding · unverified',
        html: `<b>${esc(f.id)}</b> ${f.effect === 'helps' ? 'helps' : 'contradicts'} ${targets} — it runs beside the others as a hedge. <span class="ok">Nobody stops.</span>`,
        ms: 6500,
      });
      break;
    }
    case 'refuted': {
      addTemp(elOf(sc.fid), ['flash'], 1400);
      showBanner({ tone: 'good', icon: 'check', eyebrow: 'Finding refuted', html: `<b>${esc(sc.fid)}</b> refuted — <span class="ok">nobody else was stopped.</span>`, ms: 5000 });
      break;
    }
    case 'helped':
    case 'replanned':
      for (const id of sc.claims) addTemp(elOf(id), ['scene-good'], 1700);
      break;
    case 'touched':
      for (const id of sc.claims) addTemp(elOf(id), ['flash'], 1400);
      break;
    case 'served': {
      later(50, flashServed);
      showBanner({
        tone: 'reality',
        icon: 'reality',
        eyebrow: 'Reality switch',
        html: `Now serving <b>${esc(sc.line ?? '?')}</b>${sc.previous ? ` <span class="ok">— was ${esc(sc.previous)}, kept as it was</span>` : ''}`,
        ms: 6500,
      });
      break;
    }
    case 'landing_failed':
      for (const id of sc.claims) addTemp(elOf(id), ['scene-stale'], 1600);
      break;
    case 'at_risk':
      if (sc.quiet) {
        for (const id of sc.claims) addTemp(elOf(id), ['flash'], 1400);
        break;
      }
      showBanner({
        tone: 'stale',
        icon: 'warn',
        eyebrow: 'Served reality at risk',
        html: `${sc.claims.map((c) => `<b>${esc(c)}</b>`).join(', ')} landed on a contradicted assumption`,
        ms: 7000,
      });
      for (const id of sc.claims) addTemp(elOf(id), ['flash'], 1400);
      break;
    default:
  }
}

function flowAlong(r) {
  if (!S.layout) return;
  const d = routePath(r, S.pos, S.layout.dim);
  if (!d) return;
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('class', 'flow');
  $('flow-layer').appendChild(p);
  const len = Math.max(1, p.getTotalLength());
  p.style.strokeDasharray = `${len} ${len}`;
  p.style.setProperty('--len', String(len));
  later(1300, () => p.remove());
}

let bannerTimer = 0;
function showBanner({ tone, icon: ic, eyebrow, html, ms = 6000 }) {
  const b = $('banner');
  clearTimeout(bannerTimer);
  b.className = `banner tone-${tone}`;
  b.innerHTML = `<span class="b-icon">${icon(ic)}</span><span class="b-body"><span class="eyebrow">${esc(eyebrow)}</span><span class="b-text">${html}</span></span>`;
  b.hidden = false;
  $('canvas').classList.add('bannering');
  bannerTimer = setTimeout(() => {
    b.classList.add('out');
    bannerTimer = setTimeout(() => {
      b.hidden = true;
      $('canvas').classList.remove('bannering');
    }, 500);
  }, ms);
}

// ------------------------------------------------------------ inspector --

function renderInspector() {
  const box = $('inspector');
  const n = S.selected ? S.nodes.get(S.selected) : null;
  if (!n) {
    box.hidden = true;
    box._html = '';
    $('feed').hidden = false;
    $('sheet-title').textContent = S.feed.length ? `Events · ${S.feed.length}` : 'Events';
    return;
  }
  const body = n.kind === 'claim' ? inspectClaim(n) : n.kind === 'assumption' ? inspectAssumption(n) : inspectFinding(n);
  const html = `<div class="ins-head"><button class="back" data-act="close" type="button">${icon('back')}Events</button><span class="spacer"></span><button class="icon-btn" data-act="reveal" type="button" title="Show it on the canvas" aria-label="Show it on the canvas">${icon(
    'fit',
  )}</button></div><div class="ins-body">${body}</div>`;
  box.hidden = false;
  $('feed').hidden = true;
  if (box._html !== html) {
    const top = box.scrollTop;
    const same = box._id === n.id;
    box.innerHTML = html;
    box._html = html;
    box._id = n.id;
    box.scrollTop = same ? top : 0;
    tickWithin(box);
    // Logs open at their tail, where the failure is.
    for (const pre of box.querySelectorAll('pre.log')) pre.scrollTop = pre.scrollHeight;
  }
  $('sheet-title').textContent = `${n.kind} ${n.id}`;
}

const sec = (title, inner, n) =>
  `<section class="ins-sec"><h3>${esc(title)}${Number.isFinite(n) ? ` <span class="n">${n}</span>` : ''}</h3>${inner}</section>`;

function relRow(id) {
  const n = S.nodes.get(id);
  if (!n) return '';
  const st = displayStatus(n);
  const pill =
    n.kind === 'claim'
      ? `<span class="spill s-${esc(st)}">${esc(STATUS_LABEL[st] ?? st)}</span>`
      : n.kind === 'assumption' && st === 'contradicted'
        ? '<span class="spill s-contradicted">contradicted</span>'
        : n.kind === 'finding'
          ? `<span class="spill s-${esc(st)}">${esc(st)}</span>`
          : '';
  return `<div class="relrow">${chip(id, S.nodes)}<span class="t">${esc(n.statement)}</span>${pill}</div>`;
}

function evRows(list) {
  return `<ol class="mini-feed">${list
    .map((ev) => {
      const d = describeEvent(ev, { nodes: S.nodes, stale: ev.type === 'finding.verified' ? staleBy(ev.data?.finding) : [] });
      return `<li class="ev t-${esc(d.tone)}"><span class="ev-i">${icon(d.icon)}</span><div class="ev-text">${d.html}</div><time title="${esc(timeOfDay(ev.at))}">${esc(
        timeOfDay(ev.at),
      )}</time></li>`;
    })
    .join('')}</ol>`;
}

function staleBy(fid) {
  const out = [];
  for (const e of S.events) if (e.type === 'claim.stale' && e.data?.finding === fid) out.push(...(e.claims ?? []));
  return out;
}

function inspectClaim(c) {
  const status = displayStatus(c);
  const now = serverNow();
  const lease = c.lease;
  const rows = S.pushRows.get(c.id) ?? [];
  const head = headRow(c);
  const v = verdictOf(head);
  let out = `<p class="eyebrow">Claim · ${esc(c.id)}</p><h2 class="ins-title">${esc(c.statement)}</h2>`;
  out += `<div class="ins-pills"><span class="spill s-${esc(status)}">${esc(STATUS_LABEL[status] ?? status)}</span>`;
  if (c.version > 1) out += `<span class="spill plain">version ${esc(c.version)}</span>`;
  out += `<span class="spill plain">${icon('branch')}${esc(c.line || 'main')}</span>`;
  if (c.cluster && c.cluster !== 'main') out += `<span class="spill plain">${esc(c.cluster)}</span>`;
  out += '</div>';

  if (status === 'stale') {
    const seq = S.staleSeq.get(c.id);
    const ev = S.events.find((e) => e.seq === seq);
    const fid = ev?.data?.finding;
    const as = Array.isArray(ev?.data?.assumptions) ? ev.data.assumptions : [];
    const direct = (S.rel.assumptionParents.get(c.id) ?? []).some((a) => as.includes(a));
    const kept = c.kept?.length ? c.kept[c.kept.length - 1] : null;
    out += `<p class="note warn">${fid ? chip(fid, S.nodes) : 'A finding'} contradicted ${as.length ? chips(as, S.nodes) : 'an assumption'}, which this claim rests on${
      direct ? '' : ' through the claims it builds on'
    }. ${kept ? `Its work so far is kept at <code>${esc(shortSha(kept.sha))}</code>. ` : ''}${
      told(c) ? 'Its agent has been told.' : lease && lease.expiresAt > now ? 'Its agent learns at its next lease renewal.' : 'It needs re-planning before work resumes.'
    }</p>`;
  }

  out += '<dl class="kv">';
  if (lease) {
    out += `<dt>Agent</dt><dd>${agentHTML(lease.holder, lease.expiresAt <= now)}</dd>`;
    out += `<dt>Lease</dt><dd>${
      lease.expiresAt > now
        ? `ends in <span class="cd" data-exp="${lease.expiresAt}" data-mode="lease"><span class="t"></span></span>${lease.git ? ' <span class="muted">· git token with it</span>' : ''}`
        : `<span class="muted">ended at ${esc(timeOfDay(lease.expiresAt))}</span>`
    }</dd>`;
  }
  out += `<dt>Repo</dt><dd>${c.repo ? `<code>${esc(c.repo.name)}</code>` : '<span class="muted">made when first claimed</span>'}</dd>`;
  out += `<dt>Base</dt><dd>${c.baseSha ? `<code title="${esc(c.baseSha)}">${esc(shortSha(c.baseSha))}</code>` : '<span class="muted">—</span>'}</dd>`;
  out += `<dt>Head</dt><dd>${
    c.headSha ? `<code title="${esc(c.headSha)}">${esc(shortSha(c.headSha))}</code> ${v ? badgeHTML(v) : ''}` : '<span class="muted">no accepted push yet</span>'
  }</dd>`;
  out += `<dt>Pushes</dt><dd>${esc(c.pushes ?? 0)}</dd>`;
  if (Number.isFinite(c.finishedAt)) out += `<dt>Finished</dt><dd>${esc(timeOfDay(c.finishedAt))}</dd>`;
  if (c.landedSha) out += `<dt>Merged as</dt><dd><code title="${esc(c.landedSha)}">${esc(shortSha(c.landedSha))}</code> <span class="muted">on ${esc(c.line || 'main')}</span></dd>`;
  out += '</dl>';
  if (c.landing) out += sec('Landing', landingHTML(c));

  out += sec(
    'Scope',
    c.scope?.length ? `<div class="scope-list">${c.scope.map((p) => `<code>${esc(p)}</code>`).join('')}</div>` : '<p class="note">No paths declared.</p>',
  );
  const ap = S.rel.assumptionParents.get(c.id) ?? [];
  out += sec('Rests on', ap.length ? ap.map(relRow).join('') : '<p class="note">No assumptions declared.</p>', ap.length);
  const cp = S.rel.claimParents.get(c.id) ?? [];
  if (cp.length) out += sec('Builds on', cp.map(relRow).join(''), cp.length);
  const kids = S.rel.dependents.get(c.id) ?? [];
  if (kids.length) out += sec('Built upon by', kids.map(relRow).join(''), kids.length);
  const sup = [...(S.rel.supersedes.get(c.id) ?? []), ...(S.rel.supersededBy.get(c.id) ?? [])];
  if (sup.length) out += sec('Versions', sup.map(relRow).join(''), sup.length);

  out += sec(
    'Ledger',
    rows.length
      ? `<div class="ledger">${rows.map((r) => ledgerRow(r, c)).join('')}</div>`
      : '<p class="note">No pushes yet. Every push to this claim’s repo is checked against its scope and recorded here, keyed to the exact commit.</p>',
    rows.length,
  );
  if (c.kept?.length) {
    out += sec(
      'Kept branches',
      c.kept
        .slice()
        .reverse()
        .map((k) => `<div class="keptrow">${icon('branch')}<code title="${esc(k.sha)}">${esc(shortSha(k.sha))}</code><span class="t">${esc(k.reason)}</span><span class="when">${esc(timeOfDay(k.at))}</span></div>`)
        .join(''),
      c.kept.length,
    );
  }
  const evs = S.events.filter((e) => e.claims?.includes(c.id)).slice(-8).reverse();
  if (evs.length) out += sec('Recent events', evRows(evs));
  return out;
}

function ledgerRow(r, c) {
  const v = verdictOf(r);
  const isHead = r.sha === c.headSha;
  const outside = new Set(r.outside ?? []);
  const paths = [...(r.outside ?? []), ...(r.paths ?? []).filter((p) => !outside.has(p))];
  const shown = paths.slice(0, 14);
  let h = `<div class="lrow${isHead ? ' head' : ''}"><div class="lrow-top"><code title="${esc(r.sha)}">${esc(shortSha(r.sha))}</code>${isHead ? '<span class="tag">head</span>' : ''}${
    r.accepted ? '' : '<span class="tag no">not taken</span>'
  }${v ? badgeHTML(v) : ''}<span class="when">${esc(timeOfDay(r.at))}</span></div>`;
  if (paths.length) {
    h += `<ul class="paths">${shown.map((p) => `<li class="${outside.has(p) ? 'out' : ''}">${esc(p)}</li>`).join('')}${
      paths.length > shown.length ? `<li class="more">+${paths.length - shown.length} more</li>` : ''
    }</ul>`;
  } else h += '<p class="note">No file changes against the base.</p>';
  if (r.checks) {
    const ch = r.checks;
    const word = { running: 'running', passed: 'passed', failed: 'failed', error: 'could not run' }[ch.status] ?? ch.status;
    const dur = Number.isFinite(ch.finishedAt) && Number.isFinite(ch.startedAt) ? ` · ${Math.max(0, Math.round((ch.finishedAt - ch.startedAt) / 1000))}s` : '';
    h += `<div class="checks">Checks <b>${esc(word)}</b>${ch.command ? ` · <code class="cmd">${esc(ch.command)}</code>` : ''}${
      Number.isFinite(ch.exitCode) ? ` · exit ${esc(ch.exitCode)}` : ''
    }${dur}</div>`;
    if (ch.log) h += `<pre class="log">${esc(tailOf(ch.log))}</pre>`;
  }
  if (!r.accepted && r.reason) h += `<div class="reason">Not taken: ${esc(reasonText(r.reason))}.</div>`;
  if (r.unattributed?.length) {
    h += `<div class="unattributed">${plural(r.unattributed.length, 'commit')} without a <code>Superpose-Claim: ${esc(c.id)}</code> trailer</div>`;
  }
  return `${h}</div>`;
}

function landingHTML(c) {
  const l = c.landing;
  const bad = l.status === 'conflict' || l.status === 'failed' || l.status === 'error';
  const tone = bad ? 'bad' : l.status === 'landing' ? 'run' : 'muted';
  const ic = bad ? 'warn' : l.status === 'landing' ? 'spin' : 'clock';
  const line = esc(c.line || 'main');
  let h = `<div class="lrow${bad ? ' bad' : ''}"><div class="lrow-top"><span class="badge ${tone}">${icon(ic)}${esc(LANDING_WORDS[l.status] ?? l.status)}</span><span class="muted">into ${line}</span><span class="when">${esc(timeOfDay(l.at))}</span></div>`;
  if (l.files?.length) h += `<ul class="paths">${l.files.map((f) => `<li class="conf">${esc(f)}</li>`).join('')}</ul>`;
  if (l.log) h += `<pre class="log">${esc(tailOf(l.log))}</pre>`;
  if (l.status === 'landing') h += `<p class="note">Merging into ${line} and running the checks on the merged result. One landing at a time per line, in dependency order.</p>`;
  else if (l.status === 'queued') h += '<p class="note">Waits its turn: one landing at a time per line.</p>';
  else if (bad) h += `<p class="note warn">It waits for a decision: an agent brings it up to date with ${line} and finishes it again, or it is re-planned.</p>`;
  return `${h}</div>`;
}

function tailOf(log) {
  const lines = String(log).split('\n');
  const tail = lines.slice(-30).join('\n');
  return tail.length > 3000 ? tail.slice(-3000) : tail;
}

function inspectAssumption(a) {
  const status = displayStatus(a);
  const direct = S.rel.dependents.get(a.id) ?? [];
  const reach = downstream(S.rel, [a.id]);
  const through = [...reach.keys()].filter((id) => !direct.includes(id)).sort(cmpId);
  const findings = [...S.nodes.values()].filter((n) => n.kind === 'finding' && n.targets?.includes(a.id)).sort((x, y) => cmpId(x.id, y.id));
  let out = `<p class="eyebrow">Assumption · ${esc(a.id)}</p><h2 class="ins-title${status === 'contradicted' ? ' s-contradicted-title' : ''}">${esc(a.statement)}</h2>`;
  out += `<div class="ins-pills"><span class="spill s-${esc(status)}">${status === 'contradicted' ? `${icon('bolt')}contradicted` : 'holding'}</span><span class="spill plain">${plural(
    reach.size,
    'claim',
  )} depend on it</span></div>`;
  const by = findings.filter((f) => f.status === 'verified');
  out +=
    status === 'contradicted'
      ? `<p class="note warn">Contradicted${by.length ? ` by ${chips(by.map((f) => f.id), S.nodes)}` : ''}. The claims resting on it are stale; their work is kept, and each agent hears at its next lease renewal.</p>`
      : '<p class="note">If a verified finding contradicts it, every claim below goes stale, and only those.</p>';
  out += sec('Rests on it', direct.length ? direct.map(relRow).join('') : '<p class="note">Nothing yet.</p>', direct.length);
  if (through.length) out += sec('Through them', through.map(relRow).join(''), through.length);
  if (findings.length) out += sec('Findings', findings.map((f) => relRow(f.id)).join(''), findings.length);
  return out;
}

// Each reality's exposure to a finding: which one is safe to switch to.
function realitiesHTML(f) {
  const imp = S.impact?.finding === f.id ? S.impact : null;
  const list = imp?.realities ?? [];
  if (list.length < 2 && !list.some((r) => !r.safe)) return '';
  const rows = list
    .map((r) => {
      const parts = [];
      if (r.affected.length) parts.push(`${plural(r.affected.length, 'claim')} ${f.status === 'verified' ? 'stopped' : 'would stop'}`);
      if (r.landedAtRisk.length) parts.push(`${plural(r.landedAtRisk.length, 'landed claim')} at risk`);
      const what = parts.length ? parts.join(' · ') : 'rests on nothing it contradicts';
      const pill = r.safe
        ? `<span class="spill s-safe">${r.served ? 'safe' : 'safe to switch to'}</span>`
        : '<span class="spill s-contradicted">at risk</span>';
      return `<div class="reality-row"><span class="line-chip mini${r.served ? ' served' : ''}">${r.served ? icon('reality') : '<i class="ring"></i>'}<b>${esc(r.line)}</b></span><span class="t">${esc(what)}${
        r.served ? ' <span class="muted">· served</span>' : ''
      }</span>${pill}</div>`;
    })
    .join('');
  const safeAlt = list.filter((r) => r.safe && !r.served).map((r) => r.line);
  const servedAtRisk = list.some((r) => r.served && !r.safe);
  const note =
    servedAtRisk && safeAlt.length
      ? `<p class="note">The served reality rests on what this finding contradicts; ${esc(safeAlt.join(', '))} does not. Switching is a pointer change, and the current reality stays as it is.</p>`
      : '';
  return sec('Realities', rows + note, list.length);
}

function inspectFinding(f) {
  const now = serverNow();
  let out = `<p class="eyebrow">Finding · ${esc(f.id)}</p><h2 class="ins-title">${esc(f.statement)}</h2>`;
  out += `<div class="ins-pills"><span class="spill s-${esc(f.status)}">${esc(f.status === 'unverified' ? 'unverified · hedge' : f.status)}</span><span class="spill ${
    f.effect === 'helps' ? 's-helps' : 'plain'
  }">${f.effect === 'helps' ? 'helps' : 'contradicts'}</span></div>`;
  const finder = S.nodes.get(f.finder);
  out += '<dl class="kv">';
  out += `<dt>Filed by</dt><dd>${f.finder ? chip(f.finder, S.nodes) : '—'}${finder?.lease ? ` ${agentHTML(finder.lease.holder)}` : ''}</dd>`;
  out += `<dt>${f.effect === 'helps' ? 'Helps' : 'Contradicts'}</dt><dd><span class="chiprow">${chips(f.targets ?? [], S.nodes, 12)}</span></dd>`;
  if (f.status === 'unverified' && Number.isFinite(f.hedgeUntil)) {
    out += `<dt>Hedge</dt><dd>${
      f.hedgeUntil > now ? `decision due in <span class="cd" data-exp="${f.hedgeUntil}" data-mode="hedge"><span class="t"></span></span>` : '<span class="muted">window ended — a decision is due</span>'
    }</dd>`;
  }
  out += '</dl>';

  if (f.effect !== 'helps') {
    if (f.status === 'unverified') {
      const imp = S.impact?.finding === f.id ? S.impact : null;
      out += sec(
        'If it is verified',
        imp
          ? `<div class="impact"><div><div class="v hot">${imp.affected.length}</div><div class="k">would go stale</div></div><div><div class="v">${imp.landedAtRisk.length}</div><div class="k">landed, at risk</div></div><div><div class="v">${imp.cost}</div><div class="k">pushes at stake</div></div></div>${
              imp.affected.length ? `<div class="chiprow">${chips(imp.affected, S.nodes, 24)}</div>` : ''
            }<p class="note">Until then it runs beside the others as a hedge, and nobody stops. Verifying it stops only these claims; their work is kept on a branch and each agent hears at its next renewal.</p>`
          : '<p class="note">Working out the reach…</p>',
      );
      out += realitiesHTML(f);
    } else if (f.status === 'verified') {
      const made = staleBy(f.id);
      out += sec(
        'Made stale',
        made.length
          ? `<div class="chiprow">${chips(made, S.nodes, 24)}</div><p class="note">Only the claims resting on ${chips(f.targets ?? [], S.nodes)} stopped. Everyone else kept working.</p>`
          : '<p class="note">No live claim rested on it.</p>',
        made.length,
      );
      out += realitiesHTML(f);
    } else {
      out += sec('Refuted', '<p class="note">Kept in the graph, so the next agent to suspect the same thing is pointed here. Nobody else was stopped.</p>');
    }
  }
  const evs = S.events.filter((e) => e.data?.finding === f.id && e.type !== 'claim.stale').slice(-8).reverse();
  if (evs.length) out += sec('Events', evRows(evs));
  return out;
}

// ----------------------------------------------------------------- boot --

setupTheme();
const route = /^\/g\/([A-Za-z0-9_-]{1,64})\/?$/.exec(location.pathname);
if (route) startCanvas(route[1]);
else startLanding();
