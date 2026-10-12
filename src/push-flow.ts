import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { ArtifactsHost } from './artifacts-host';
import { readCheckConfig, runCheck, type ExecJob } from './core/checks';
import { parseRepoName } from './core/repos';
import type { CheckRun, PushRecord, RepoRef } from './core/types';

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
  | { graph: string; claim: string; record: PushRecord; repo: RepoRef }
  | { graph: string; claim: string; error: string };

// Every push to a repo in the `superpose` namespace starts one of these (see
// `triggers.events` in wrangler.jsonc). Pushes by agents that never call the
// API are checked all the same: the platform reads the commit itself, then
// runs the claim's checks on that exact commit in a Container.
export class PushFlow extends WorkflowEntrypoint<Env, ArtifactsEvent> {
  async run(event: WorkflowEvent<ArtifactsEvent>, step: WorkflowStep) {
    const handled = await step.do(
      'check the push against its claim',
      { retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' } },
      () => handlePush(this.env, event.payload),
    );
    if (!('record' in handled) || !needsChecks(handled.record)) return handled;
    const { graph, claim, record, repo } = handled;
    const stub = this.env.GRAPH.get(this.env.GRAPH.idFromName(graph));
    const host = new ArtifactsHost(this.env.ARTIFACTS!);
    // Step results must be plain data, so only the verdict comes back.
    const recordCheck = async (check: CheckRun): Promise<string | null> => {
      const r = await stub.recordCheck(claim, record.sha, check);
      return r.ok ? r.value.verdict : null;
    };

    const config = await step.do('read the checks from the commit', () => readCheckConfig(host, repo.name, record.sha));
    if (!config) {
      const now = Date.now();
      await step.do('record that no checks are declared', () =>
        recordCheck({ status: 'skipped', startedAt: now, finishedAt: now, log: 'no superpose.json and no npm test script' }),
      );
      return handled;
    }
    await step.do('mark the checks running', () => recordCheck({ status: 'running', command: config.check, startedAt: Date.now() }));
    const run = await step.do(
      'run the checks on the exact commit',
      { retries: { limit: 1, delay: '15 seconds' }, timeout: '25 minutes' },
      async (): Promise<CheckRun> => {
        const exec = (job: ExecJob) =>
          this.env.CHECKER.get(this.env.CHECKER.idFromName(`check:${graph}:${claim}:${record.sha}`)).run(job);
        return runCheck(host, exec, repo, record.sha, config);
      },
    );
    const verdict = await step.do('record the verdict', () => recordCheck(run));
    return { ...handled, verdict };
  }
}

// Only a commit that became the claim's head, inside its scope and not yet
// checked, is worth a container.
function needsChecks(r: PushRecord): boolean {
  return r.accepted && r.verdict === 'unverified' && !r.checks;
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
  if (result.ok) return { graph: name.graph, claim: name.id, record: result.value.record, repo: result.value.repo };
  // A host hiccup is worth a retry of the step; anything else is final.
  if (result.code === 'repo_unavailable') throw new Error(result.message);
  return { graph: name.graph, claim: name.id, error: `${result.code}: ${result.message}` };
}
