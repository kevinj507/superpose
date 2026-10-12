import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { parseRepoName } from './core/repos';
import type { PushRecord } from './core/types';

// An Artifacts event as the push trigger delivers it to the Workflow: the
// whole event, with the push itself under `payload` (checked on the account
// 2026-10-12). A push event carries no list of changed files.
export interface ArtifactsEvent {
  id?: string;
  type: string;
  source: { namespace?: string; repoName: string };
  payload: {
    ref: string;
    before: string;
    after: string;
    commits?: { id: string; message: string }[];
  };
}

export type HandledPush =
  | { ignored: string }
  | { graph: string; claim: string; record: PushRecord }
  | { graph: string; claim: string; error: string };

// Every push to a repo in the `superpose` namespace starts one of these (see
// `triggers.events` in wrangler.jsonc). Pushes by agents that never call the
// API are checked all the same: the platform reads the commit itself.
export class PushFlow extends WorkflowEntrypoint<Env, ArtifactsEvent> {
  async run(event: WorkflowEvent<ArtifactsEvent>, step: WorkflowStep): Promise<HandledPush> {
    return step.do('check the push against its claim', { retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' } }, () =>
      handlePush(this.env, event.payload),
    );
  }
}

export async function handlePush(env: Env, e: ArtifactsEvent): Promise<HandledPush> {
  if (e.type !== 'cf.artifacts.repo.pushed') return { ignored: `not a push: ${e.type}` };
  const name = parseRepoName(e.source.repoName);
  // The trigger sees every repo in the namespace; only Superpose's own repos
  // are routed to a graph.
  if (!name) return { ignored: `not a Superpose repo: ${e.source.repoName}` };
  if (name.kind !== 'claim') return { ignored: `line pushes are recorded at landing: ${e.source.repoName}` };
  const graph = env.GRAPH.get(env.GRAPH.idFromName(name.graph));
  const result = await graph.recordPush(name.graph, name.id, {
    sha: e.payload.after,
    ref: e.payload.ref,
    before: e.payload.before,
    commits: (e.payload.commits ?? []).map((c) => ({ id: c.id, message: c.message })),
  });
  if (result.ok) return { graph: name.graph, claim: name.id, record: result.value };
  // A host hiccup is worth a retry of the step; anything else is final.
  if (result.code === 'repo_unavailable') throw new Error(result.message);
  return { graph: name.graph, claim: name.id, error: `${result.code}: ${result.message}` };
}
