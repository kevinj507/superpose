import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { ArtifactsHost } from './artifacts-host';
import { readCheckConfig, runCheck, type CheckConfig, type ExecJob } from './core/checks';
import { checkPair } from './core/pair';
import { checkFinding, type FindingCheckContext } from './core/finding-check';
import { parseRepoName } from './core/repos';
import type { CheckRun, PairCheck, PushRecord, RepoRef } from './core/types';

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
    finding?: string;
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
    const host = new ArtifactsHost(this.env.ARTIFACTS!);
    if (event.payload.type === 'superpose.inputs.check') {
      const name = parseRepoName(event.payload.source.repoName);
      if (!name) return { ignored: 'unknown input-check repository' };
      const line = event.payload.payload.ref;
      const stub = this.env.GRAPH.get(this.env.GRAPH.idFromName(name.graph));
      const context = await step.do('capture code and declared runtime inputs', async () => {
        const r = await stub.inputCheckContext(line);
        return r ? { repo: r.repo, sha: r.sha, inputs: r.inputs, articles: r.articles } : null;
      });
      if (!context) return { ignored: 'no declared runtime check context' };
      const configured = await step.do('read the owner check configuration', () => readCheckConfig(host, context.repo.name, context.sha));
      const runs: { article: string; check: CheckRun }[] = [];
      for (const article of context.articles) {
        const check = await step.do('check runtime article '+article.id, { timeout: '12 minutes' }, async () => {
          const attempt = crypto.randomUUID();
          return runCheck(host, (job: ExecJob) => this.env.CHECKER.get(this.env.CHECKER.idFromName(`input:${name.graph}:${context.inputs.version}:${article.id}:${attempt}`)).run(job), context.repo, context.sha, { ...configured, check: article.check, timeoutSeconds: configured?.timeoutSeconds ?? 60, inputs: context.inputs });
        });
        runs.push({ article: article.id, check });
      }
      const applied = await step.do('apply only to the captured runtime and code', async () => {
        const r = await stub.recordInputCheck(line, context.sha, context.inputs.version, runs);
        return r.ok && r.value;
      });
      return { inputVersion: context.inputs.version, applied, runs };
    }
    if (event.payload.type === FINDING_CHECK) {
      const name = parseRepoName(event.payload.source.repoName);
      const finding = event.payload.payload.finding;
      if (!name || name.kind !== 'claim' || !finding) return { ignored: 'not a finding check' };
      const stub = this.env.GRAPH.get(this.env.GRAPH.idFromName(name.graph));
      const context = await step.do('capture the finding and its code versions', async (): Promise<FindingCheckContext | null> => {
        const r = await stub.findingCheckContext(name.graph, finding);
        return r.ok ? { finding: r.value.finding, evidence: r.value.evidence, line: r.value.line, heads: r.value.heads, articles: r.value.articles } : null;
      });
      if (!context) return { ignored: 'this finding cannot currently be checked' };
      const config = await step.do('read setup from the recorded line', () => readCheckConfig(host, context.line.name, context.evidence.lineHead));
      const settings = config ?? { check: '', timeoutSeconds: 300 };
      const evidence = await step.do('check the owner articles on the named combination', {
        timeout: `${settings.timeoutSeconds * (context.articles.length + 1) * 2 + 480} seconds`,
      }, () => checkFinding(host,
        (job: ExecJob) => this.env.CHECKER.get(this.env.CHECKER.idFromName(`finding:${name.graph}:${finding}:${event.instanceId}`)).run(job), context, settings));
      const status = await step.do('settle only if the recorded inputs still apply', async () => {
        const r = await stub.recordFindingCheck(finding, evidence);
        return r.ok ? r.value.status : 'unverified';
      });
      return { graph: name.graph, finding, status };
    }
    // A landing moved the line: a head already checked on its own is paired
    // with the line again, and only that.
    if (event.payload.type === PAIR_RECHECK) {
      const name = parseRepoName(event.payload.source.repoName);
      if (!name || name.kind !== 'claim') return { ignored: `not a claim repo: ${event.payload.source.repoName}` };
      const stub = this.env.GRAPH.get(this.env.GRAPH.idFromName(name.graph));
      const sha = event.payload.payload.after;
      const row = await step.do('find the commit', async () => {
        const r = await stub.pushRow(name.id, sha);
        return r.ok ? r.value : null;
      });
      if (!row?.accepted || (row.verdict !== 'checks-passed' && row.checks?.status !== 'skipped')) return { ignored: `${sha} is not a checked head of ${name.id}` };
      const repo = await step.do('find the repo', async () => {
        const r = await stub.pairContext(name.id);
        return r.ok && !('skip' in r.value) ? r.value.claim : null;
      });
      if (!repo) return { ignored: `nothing to pair for ${name.id}` };
      const config = await step.do('read the checks from the commit', () => readCheckConfig(host, repo.name, sha));
      const pair = await this.pairStep(step, host, { graph: name.graph, claim: name.id, sha, config: config ?? { check: '', timeoutSeconds: 300 }, runId: event.instanceId });
      return { graph: name.graph, claim: name.id, pair };
    }

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
    // Step results must be plain data, so only the verdict comes back.
    const recordCheck = async (check: CheckRun): Promise<string | null> => {
      const r = await stub.recordCheck(graph, claim, record.sha, check);
      return r.ok ? r.value.verdict : null;
    };

    const config = await step.do('read the checks from the commit', async () => {
      const configured = await readCheckConfig(host, repo.name, record.sha);
      const context = await stub.pairContext(claim);
      const inputs = context.ok && !('skip' in context.value) ? context.value.inputs : undefined;
      return configured ? { ...configured, ...(inputs ? { inputs } : {}) } : configured;
    });
    if (!config) {
      const now = Date.now();
      await step.do('record that no checks are declared', () =>
        recordCheck({ status: 'skipped', startedAt: now, finishedAt: now, log: 'no superpose.json and no npm test script' }),
      );
      const pair = await this.pairStep(step, host, { graph, claim, sha: record.sha, config: { check: '', timeoutSeconds: 300 }, runId: event.instanceId });
      return { ...handled, pair };
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
    if (verdict !== 'checks-passed') return { ...handled, verdict };
    const pair = await this.pairStep(step, host, { graph, claim, sha: record.sha, config, runId: event.instanceId });
    return { ...handled, verdict, pair };
  }

  // The gate on combinations: the commit merged with the line as it stands,
  // with the constitution run on the pair. A break files the gate's own
  // finding and stales the claim; the claim's own verdict is unchanged.
  private async pairStep(
    step: WorkflowStep,
    host: ArtifactsHost,
    { graph, claim, sha, config, runId }: { graph: string; claim: string; sha: string; config: CheckConfig; runId: string },
  ): Promise<string> {
    const stub = this.env.GRAPH.get(this.env.GRAPH.idFromName(graph));
    const ctx = await step.do('what the pair check needs', async () => {
      const r = await stub.pairContext(claim);
      return r.ok ? r.value : null;
    });
    if (!ctx) return 'no context';
    if ('skip' in ctx) return ctx.skip;
    config = { ...config, ...(ctx.inputs ? { inputs: ctx.inputs } : {}) };
    const mine = await step.do('start the pair check, unless already running or already judged', async () => {
      const r = await stub.beginPair(claim, sha, runId, ctx.inputs?.version);
      return r.ok && r.value;
    });
    if (!mine) return 'already running or judged for this commit and this line';
    const runs = 1 + Math.min(8, ctx.candidates.length);
    let pair: PairCheck;
    try {
      pair = await step.do(
        'run the constitution on the commit merged with the line',
        { retries: { limit: 2, delay: '30 seconds', backoff: 'linear' }, timeout: `${(config.timeoutSeconds * runs * 2 + 60) * 2 + 420} seconds` },
        async (): Promise<PairCheck> => {
          const attempt = crypto.randomUUID();
          const exec = (job: ExecJob) => this.env.CHECKER.get(this.env.CHECKER.idFromName(`pair:${graph}:${claim}:${sha}:${attempt}`)).run(job);
          const result = await checkPair(host, exec, { ...ctx, sha, config });
          if (result.status === 'error') throw new Error(`the pair check could not run: ${result.log ?? ''}`.slice(0, 500));
          return { ...result, articles: ctx.articles.map((a) => a.id) };
        },
      );
    } catch (err) {
      const now = Date.now();
      pair = { status: 'error', log: String(err).slice(0, 2000), startedAt: now, finishedAt: now, ...(ctx.inputs ? { inputVersion: ctx.inputs.version } : {}) };
    }
    await step.do('record the pair check', async () => {
      const r = await stub.recordPair(claim, sha, pair);
      return r.ok;
    });
    return pair.status;
  }
}

// A pair re-check the platform asks for after a landing, in the shape the
// push Workflow takes: the claim's repo and the head to judge again.
export const PAIR_RECHECK = 'superpose.pair.recheck';
export const FINDING_CHECK = 'superpose.finding.check';

export function findingCheckEvent(repoName: string, finding: string): ArtifactsEvent {
  return { type: FINDING_CHECK, source: { repoName }, payload: { ref: 'refs/heads/main', before: '', after: '', finding } };
}

export function pairRecheck(repoName: string, sha: string): ArtifactsEvent {
  return {
    type: PAIR_RECHECK,
    source: { namespace: 'superpose', repoName },
    payload: { ref: 'refs/heads/main', before: '0'.repeat(40), after: sha, commits: [] },
  };
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
