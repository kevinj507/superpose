declare namespace Cloudflare {
  interface Env {
    GRAPH: DurableObjectNamespace<import('./graph').Graph>;
    ARTIFACTS?: Artifacts;
    REPO_HOST?: string; // 'fake' for tests and local development
    PUSHES?: Workflow;
    LANDINGS?: Workflow<import('./land-flow').LandParams>;
    CHECKER: DurableObjectNamespace<import('./checker').Checker>;
    ADMIN_TOKEN: string;
    AGENT_KEY: string;
    LEASE_MS?: string;
    HEDGE_MS?: string;
  }
}
interface Env extends Cloudflare.Env {}
