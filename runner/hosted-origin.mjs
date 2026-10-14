// Prepare a Superpose Artifacts-backed Git origin for an ordinary Git run.
// Admin credentials travel only in HTTPS headers; the minted Git credential is
// returned separately so callers can pass it to gitAuthEnv.
import { git, gitAuthEnv } from './lib.mjs';

const ownerIdentity = ['-c', 'user.name=Kevin Joo', '-c', 'user.email=kevinj507@gmail.com'];

export async function prepareHostedOrigin({ seedCheckout, url, graphId, adminToken, fetchImpl = fetch }) {
  if (!seedCheckout || !url || !graphId || !adminToken) throw new TypeError('seedCheckout, url, graphId, and adminToken are required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(graphId)) throw new TypeError('invalid graphId');
  const base = url.replace(/\/+$/, '');
  const endpoint = (path) => `${base}/api/graphs/${encodeURIComponent(graphId)}${path}`;
  const request = async (path, body) => {
    const response = await fetchImpl(endpoint(path), {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Superpose request failed (${response.status}): ${data?.message ?? 'request rejected'}`);
    return data;
  };

  // POSTing the existing main line initializes its Artifacts repo through the
  // owner line route; lineAccess then mints the write token for that repo.
  await request('/lines/main', {});
  const access = await request('/lines/main/access', { scope: 'write', ttl: 3600 });
  if (!access?.remote || !access?.token) throw new Error('Superpose returned incomplete Git access');

  // Preserve the owner's identity if the seed checkout needs an owner commit.
  const status = git(seedCheckout, ['status', '--porcelain']).stdout.trim();
  if (status) {
    git(seedCheckout, ['add', '-A']);
    git(seedCheckout, [...ownerIdentity, 'commit', '-m', 'Seed hosted Git comparison']);
  }
  git(seedCheckout, ['push', '--quiet', access.remote, 'HEAD:refs/heads/main'], {
    env: gitAuthEnv(access.token),
  });

  return {
    remoteUrl: access.remote,
    graphId,
    auth: { token: access.token },
  };
}
