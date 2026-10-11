declare namespace Cloudflare {
  interface Env {
    GRAPH: DurableObjectNamespace<import('./graph').Graph>;
    ADMIN_TOKEN: string;
    AGENT_KEY: string;
    LEASE_MS?: string;
    HEDGE_MS?: string;
  }
}
interface Env extends Cloudflare.Env {}
