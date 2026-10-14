// The only network path available inside a task's network-less container.
// It reaches this run's API and explicitly granted Git repositories only.
import { createServer } from 'node:http';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
export async function groupGateway({ graphId, url, remotes = [], onRequest = () => {}, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_-]+$/.test(graphId)) throw new Error('Invalid group graph ID');
  const root = mkdtempSync('/tmp/superpose-gateway-');
  const repositories = new Map();
  let port;
  const register = (remote, token) => {
    if (!remote?.startsWith('https://') || !token) throw new Error('A granted HTTPS Git remote and its scoped token are required');
    const key = Buffer.from(remote).toString('base64url');
    const existing = repositories.get(key);
    if (existing) existing.token = token;
    else repositories.set(key, { remote: remote.replace(/\/$/, ''), token, revoked: false });
    return `http://127.0.0.1:${port}/git/${key}`;
  };
  const rewrite = (value, inheritedToken) => {
    if (Array.isArray(value)) return value.map(v => rewrite(v, inheritedToken));
    if (!value || typeof value !== 'object') return value;
    const token = value.git?.token ?? value.token ?? inheritedToken;
    const copy = Object.fromEntries(Object.entries(value).map(([k,v]) => [k,rewrite(v,token)]));
    if (typeof value.remote === 'string' && value.remote.startsWith('https://') && token) copy.remote = register(value.remote,token);
    return copy;
  };
  async function handle(req, res) {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const gitMatch = path.match(/^\/git\/([A-Za-z0-9_-]+)(\/.*)?$/);
      let target, token, repository;
      if (gitMatch) {
        repository = repositories.get(gitMatch[1]);
        if (!repository || !['/info/refs','/git-upload-pack','/git-receive-pack'].includes(gitMatch[2])) {res.writeHead(403);res.end('Repository or operation outside this group');return;}
        if (gitMatch[2] === '/git-receive-pack' && repository.revoked) {onRequest({at:Date.now(),kind:'git',method:req.method,status:403,reason:'revoked'});res.writeHead(403);res.end('Git grant revoked');return;}
        target = repository.remote + req.url.slice(`/git/${gitMatch[1]}`.length);
        token = `Bearer ${repository.token}`;
      } else if (path === `/api/graphs/${graphId}` || path.startsWith(`/api/graphs/${graphId}/`)) {
        target = url.replace(/\/$/,'') + req.url;
        token = req.headers.authorization;
      } else {res.writeHead(403);res.end('Outside this group');return;}
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      // Recheck after body admission: a receive-pack that was already waiting
      // for its body when revoke() ran must not reach the upstream.
      if (repository && gitMatch[2] === '/git-receive-pack' && repository.revoked) {onRequest({at:Date.now(),kind:'git',method:req.method,status:403,reason:'revoked'});res.writeHead(403);res.end('Git grant revoked');return;}
      const headers = {};
      for (const key of ['content-type','accept','git-protocol']) if (req.headers[key]) headers[key] = req.headers[key];
      if (token) headers.authorization = token;
      const upstream = await fetchImpl(target,{method:req.method,headers,
        ...(!['GET','HEAD'].includes(req.method) ? {body:Buffer.concat(chunks)} : {}),signal:AbortSignal.timeout(120000),redirect:'error'});
      onRequest({at:Date.now(),kind:gitMatch?'git':'api',method:req.method,status:upstream.status});
      const outputHeaders = {};
      for (const key of ['content-type','cache-control']) if (upstream.headers.has(key)) outputHeaders[key] = upstream.headers.get(key);
      let body = Buffer.from(await upstream.arrayBuffer());
      if (!gitMatch && (outputHeaders['content-type'] ?? '').includes('json')) {
        body = Buffer.from(JSON.stringify(rewrite(JSON.parse(body.toString()))));
        delete outputHeaders['content-encoding'];
      }
      res.writeHead(upstream.status,outputHeaders);res.end(body);
    } catch {res.writeHead(502);res.end('Group transport failed');}
  }
  const tcp = createServer(handle), unix = createServer(handle);
  await new Promise(done => tcp.listen(0,'127.0.0.1',done));port=tcp.address().port;
  const socket = join(root,'relay.sock');
  await new Promise(done=>unix.listen(socket,done));chmodSync(socket,0o600);
  for (const r of remotes) register(r.remote,r.token);
  const revoke = (remote) => {
    const normalized = String(remote ?? '').replace(/\/$/, '');
    let found = false;
    for (const repo of repositories.values()) if (repo.remote === normalized) { repo.revoked = true; found = true; }
    return found;
  };
  const authorize = (remote, token) => {
    const key = Buffer.from(remote).toString('base64url');
    if (!repositories.has(key)) throw new Error('Only an existing grant can be authorized');
    // Replace, rather than mutate, the revoked object: a request already
    // waiting on the retired grant must remain revoked after this handoff.
    repositories.set(key, { remote: remote.replace(/\/$/, ''), token, revoked: false });
    return `http://127.0.0.1:${port}/git/${key}`;
  };
  return { root,port,socket,url:`http://127.0.0.1:${port}`,register,rewrite,revoke,authorize,
    async close(){tcp.closeAllConnections();unix.closeAllConnections();await Promise.all([new Promise(r=>tcp.close(r)),new Promise(r=>unix.close(r))]);rmSync(root,{recursive:true,force:true});} };
}
