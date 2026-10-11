import type { Result } from './graph';

export { Graph } from './graph';

// HTTP API in front of the per-graph Durable Objects.
//   Planner and human routes: Authorization: Bearer <ADMIN_TOKEN>
//   Claiming work:            Authorization: Bearer <AGENT_KEY>
//   Working a claim:          Authorization: Bearer <lease token from claiming>
//   Reads are public, so the demo graph can be watched by anyone.

const STATUS: Record<string, number> = {
  not_found: 404,
  bad_token: 401,
  expired: 401,
  not_ready: 409,
  stale: 409,
  settled: 409,
  contradicted: 409,
  not_done: 409,
};

type Handler = (ctx: {
  graph: DurableObjectStub<import('./graph').Graph>;
  params: Record<string, string>;
  body: Record<string, unknown>;
  bearer: string;
}) => Promise<Result<unknown>>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  auth: 'public' | 'admin' | 'agent' | 'lease';
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, auth: Route['auth'], handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), '([A-Za-z0-9_-]{1,64})')) + '$',
  );
  routes.push({ method, pattern, keys, auth, handler });
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

route('GET', '/api/graphs/:gid/snapshot', 'public', ({ graph }) => graph.snapshot());
route('GET', '/api/graphs/:gid/ready', 'public', ({ graph }) => graph.ready());
route('GET', '/api/graphs/:gid/findings/:fid/impact', 'public', ({ graph, params }) => graph.impactOf(params.fid!));

route('POST', '/api/graphs/:gid/assumptions', 'admin', ({ graph, body }) => graph.addAssumption(str(body.statement)));
route('POST', '/api/graphs/:gid/claims', 'admin', ({ graph, body }) =>
  graph.addClaim({
    statement: str(body.statement),
    scope: strs(body.scope),
    cluster: str(body.cluster) || undefined,
    restsOn: strs(body.restsOn),
    requires: strs(body.requires),
    baseSha: str(body.baseSha) || undefined,
  }),
);
route('POST', '/api/graphs/:gid/claims/:id/land', 'admin', ({ graph, params }) => graph.land(params.id!));
route('POST', '/api/graphs/:gid/findings/:fid/verify', 'admin', ({ graph, params }) => graph.verifyFinding(params.fid!));
route('POST', '/api/graphs/:gid/findings/:fid/refute', 'admin', ({ graph, params }) => graph.refuteFinding(params.fid!));

route('POST', '/api/graphs/:gid/claims/:id/claim', 'agent', ({ graph, params, body }) =>
  graph.claim(params.id!, str(body.agent) || 'anonymous'),
);

route('POST', '/api/graphs/:gid/claims/:id/renew', 'lease', ({ graph, params, bearer }) => graph.renew(params.id!, bearer));
route('POST', '/api/graphs/:gid/claims/:id/push', 'lease', ({ graph, params, body, bearer }) =>
  graph.push(params.id!, bearer, { sha: str(body.sha), changedPaths: strs(body.changedPaths) }),
);
route('POST', '/api/graphs/:gid/claims/:id/finish', 'lease', ({ graph, params, bearer }) => graph.finish(params.id!, bearer));
route('POST', '/api/graphs/:gid/claims/:id/replan', 'lease', ({ graph, params, body, bearer }) =>
  graph.replan(params.id!, bearer, {
    statement: str(body.statement) || undefined,
    scope: Array.isArray(body.scope) ? strs(body.scope) : undefined,
    restsOn: strs(body.restsOn),
  }),
);
route('POST', '/api/graphs/:gid/findings', 'lease', ({ graph, body, bearer }) =>
  graph.fileFinding(str(body.finder), bearer, {
    statement: str(body.statement),
    effect: body.effect === 'helps' ? 'helps' : 'contradicts',
    targets: strs(body.targets),
  }),
);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function sameSecret(given: string, expected: string | undefined): Promise<boolean> {
  if (!expected || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const match = routes
      .filter((r) => r.method === request.method)
      .map((r) => ({ r, m: r.pattern.exec(url.pathname) }))
      .find((x) => x.m);
    if (!match) return json(404, { error: 'not_found', message: `no route ${request.method} ${url.pathname}` });

    const { r, m } = match;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = m![i + 1]!));

    const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (r.auth === 'admin' && !(await sameSecret(bearer, env.ADMIN_TOKEN))) {
      return json(401, { error: 'unauthorized', message: 'admin token required' });
    }
    if (r.auth === 'agent' && !(await sameSecret(bearer, env.AGENT_KEY)) && !(await sameSecret(bearer, env.ADMIN_TOKEN))) {
      return json(401, { error: 'unauthorized', message: 'agent key required' });
    }
    if (r.auth === 'lease' && !bearer) {
      return json(401, { error: 'unauthorized', message: 'lease token required' });
    }

    let body: Record<string, unknown> = {};
    if (request.method === 'POST') {
      try {
        const parsed: unknown = await request.json();
        if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
      } catch {
        body = {};
      }
    }

    const graph = env.GRAPH.get(env.GRAPH.idFromName(params.gid!));
    const result = await r.handler({ graph, params, body, bearer });
    if (result.ok) return json(200, result.value ?? null);
    return json(STATUS[result.code] ?? 400, { error: result.code, message: result.message });
  },
} satisfies ExportedHandler<Env>;
