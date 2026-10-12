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
    // A commit already replaced by a newer one is not worth a container; the
    // newer push gets its own run.
    const current = await step.do('is it still the claim\'s latest commit?', async () => {
      const r = await stub.headOf(claim);
      return r.ok ? r.value : null;
    });
    if (current !== record.sha) return { ...handled, skipped: 'superseded by a newer commit' };
    const host = new ArtifactsHost(this.env.ARTIFACTS!);
    // Step results must be plain data, so only the verdict comes back.
    const recordCheck = async (check: CheckRun): Promise<string | null> => {
      const r = await stub.recordCheck(graph, claim, record.sha, check);
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
    // Only one run per commit: another flow for the same commit (a re-check,
    // or the platform's own check at finish) leaves it to this one.
    const mine = await step.do('start the checks, unless already running', async () => {
      const r = await stub.beginCheck(claim, record.sha, config.check, event.instanceId);
      return r.ok && r.value;
    });
    if (!mine) return { ...handled, skipped: 'checks already running for this commit' };
    let run: CheckRun;
    try {
      run = await step.do(
        'run the checks on the exact commit',
        // Room for placing a container (at most 5 minutes, see untilReady)
        // and both steps.
        { retries: { limit: 2, delay: '30 seconds', backoff: 'linear' }, timeout: `${(config.timeoutSeconds * 2 + 60) * 2 + 420} seconds` },
        async (): Promise<CheckRun> => {
          // A container of its own for each attempt: a timed-out attempt may
          // still be running in the last one.
          const attempt = crypto.randomUUID();
          const exec = (job: ExecJob) =>
            this.env.CHECKER.get(this.env.CHECKER.idFromName(`check:${graph}:${claim}:${record.sha}:${attempt}`)).run(job);
          const result = await runCheck(host, exec, repo, record.sha, config);
          // The platform failing (no container, no fetch) is retried; the
          // code failing is a verdict.
          if (result.status === 'error') throw new Error(`the check could not run: ${result.log ?? ''}`.slice(0, 500));
          return result;
        },
      );
    } catch (err) {
      const now = Date.now();
      run = { status: 'error', command: config.check, startedAt: now, finishedAt: now, log: String(err).slice(0, 2000) };
    }
    const verdict = await step.do('record the verdict', () => recordCheck(run));
    return { ...handled, verdict };
  }
}

// Only a commit that became the claim's head, inside its scope and not yet
// checked, is worth a container.
function needsChecks(r: PushRecord): boolean {
  return r.accepted && r.verdict === 'unverified' && !r.checks;
}

// A push event made up by the platform, to check a commit whose own event
// never led to a check (it arrived late, or the check is being re-run).
export function syntheticPush(repoName: string, sha: string): ArtifactsEvent {
  return {
    type: 'cf.artifacts.repo.pushed',
    source: { namespace: 'superpose', repoName },
    payload: { ref: 'refs/heads/main', before: '0'.repeat(40), after: sha, commits: [] },
  };
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
