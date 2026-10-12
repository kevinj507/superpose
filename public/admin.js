// Acting as admin from the canvas: the token, the requests, and which
// decisions each card offers.
//
// The token lives in this tab's sessionStorage only (never localStorage, never
// the URL) and is sent only to this site's own /api routes. Signing out
// forgets it.

const KEY = 'superpose-admin';

export function getToken() {
  try {
    return sessionStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    // Storage blocked: the token lasts as long as the page (see app.js).
  }
}

export function clearToken() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
}

const api = (gid, rest) => `/api/graphs/${encodeURIComponent(gid)}${rest}`;

// One admin request. Resolves to {ok: true, data} or {ok: false, error,
// message}, the API's own words when it sent any.
export async function adminRequest(gid, rest, token, { method = 'POST', body, timeoutMs = 20_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(api(gid, rest), {
      method,
      cache: 'no-store',
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      // no JSON body
    }
    if (res.ok) return { ok: true, status: res.status, data };
    return {
      ok: false,
      status: res.status,
      error: typeof data?.error === 'string' ? data.error : `http_${res.status}`,
      message: typeof data?.message === 'string' ? data.message : res.statusText || 'the request failed',
    };
  } catch (err) {
    const timeout = err?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      error: timeout ? 'timeout' : 'network',
      message: timeout ? `no answer after ${Math.round(timeoutMs / 1000)} seconds` : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Is the token accepted? Asks to re-check a claim that cannot exist: an
// accepted token gets "not found" and nothing changes; a wrong one gets 401.
export async function checkToken(gid, token) {
  const r = await adminRequest(gid, '/claims/--probe--/recheck', token);
  if (r.status === 401) return { ok: false, message: 'That token was not accepted.' };
  if (r.ok || r.status === 404 || r.status === 409) return { ok: true };
  return { ok: false, message: `${r.error}: ${r.message}` };
}

// A landing that has been in flight this long may have lost its runner.
export const LANDING_STUCK_MS = 5 * 60_000;

// The decisions a card offers, in the order shown.
export function findingOps(f) {
  return f?.status === 'unverified' ? ['verify', 'refute'] : [];
}

export function claimOps(c, head) {
  if (!c) return [];
  const ops = [];
  const landing = c.landing?.status;
  if (c.status === 'done' && (landing === 'conflict' || landing === 'failed' || landing === 'error')) ops.push('reopen');
  const checks = head?.checks?.status;
  const unchecked = !head || !head.checks || checks === 'error' || head.verdict === 'verifier-failed';
  if (c.headSha && (c.status === 'claimed' || c.status === 'done') && unchecked) ops.push('recheck');
  if (c.status === 'done' && landing !== 'landing') ops.push('land');
  return ops;
}

export function lineOps(line, now) {
  if (!line || line.implicit) return [];
  const ops = [];
  if (!line.served) ops.push('serve');
  if (line.landing && now - line.landing.startedAt > LANDING_STUCK_MS) ops.push('abandon');
  return ops;
}

// What each decision is called, whether it asks first, and its request.
export const OPS = {
  verify: { label: 'Verify', tone: 'bad', confirm: true, path: (id) => `/findings/${encodeURIComponent(id)}/verify` },
  refute: { label: 'Refute', tone: 'plain', confirm: true, path: (id) => `/findings/${encodeURIComponent(id)}/refute` },
  reopen: { label: 'Reopen', tone: 'plain', confirm: true, path: (id) => `/claims/${encodeURIComponent(id)}/reopen` },
  recheck: { label: 'Run checks again', tone: 'plain', confirm: false, path: (id) => `/claims/${encodeURIComponent(id)}/recheck` },
  land: { label: 'Mark landed without merging', tone: 'plain', confirm: true, path: (id) => `/claims/${encodeURIComponent(id)}/land` },
  serve: { label: 'Serve this reality', tone: 'good', confirm: true, path: (name) => `/lines/${encodeURIComponent(name)}/serve` },
  abandon: { label: 'Give up on this landing', tone: 'bad', confirm: true, path: (name) => `/lines/${encodeURIComponent(name)}/abandon-landing` },
};
