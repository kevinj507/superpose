import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { ArtifactsHost } from './artifacts-host';
import { readCheckConfig, type ExecJob } from './core/checks';
import type { LandingOutcome } from './core/engine';
import { checkMerged, landingFromCheck, mergeForLanding, promoteLanding } from './core/landing';
import type { CheckRun } from './core/types';

export interface LandParams {
  graph: string;
  line: string;
  claim: string;
  sha: string;
}

// One landing: the graph's Durable Object (the single writer) picks the next
// claim and starts this. A trusted container merges; an untrusted one runs
// the checks on the merged result with a read token only; a fresh trusted one
// moves the line. The outcome goes back to the Durable Object, which then
// starts the next landing on the line.
export class LandFlow extends WorkflowEntrypoint<Env, LandParams> {
  async run(event: WorkflowEvent<LandParams>, step: WorkflowStep) {
    const { graph, line, claim, sha } = event.payload;
    const stub = this.env.GRAPH.get(this.env.GRAPH.idFromName(graph));
    const host = new ArtifactsHost(this.env.ARTIFACTS!);
    const container = (phase: string) => (job: ExecJob) =>
      this.env.CHECKER.get(this.env.CHECKER.idFromName(`land:${graph}:${line}:${claim}:${sha}:${phase}`)).run(job);
    const retry = { retries: { limit: 2, delay: '20 seconds' as const, backoff: 'linear' as const }, timeout: '20 minutes' as const };

    const outcome = await (async (): Promise<LandingOutcome> => {
      const ctx = await step.do('find the line and the claim', async () => {
        const r = await stub.landingContext(line, claim);
        if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
        return { line: r.value.line, claim: r.value.claim, statement: r.value.statement };
      });
      // Platform trouble (no container, a failed fetch) throws, so the step
      // is retried; a conflict is an answer, not an error.
      const merged = await step.do('merge the claim into the line (no repo code runs)', retry, async () => {
        const r = await mergeForLanding(host, container('merge'), { line: ctx.line, claim: ctx.claim, claimId: claim, sha, statement: ctx.statement });
        if (r.status === 'error') throw new Error(`the merge could not run: ${r.log ?? ''}`.slice(0, 500));
        return r;
      });
      if (merged.status !== 'merged') return merged;

      const config = await step.do('read the checks from the merged result', () => readCheckConfig(host, ctx.line.name, merged.merge));
      if (config) {
        let run: CheckRun;
        try {
          run = await step.do('run the checks on the merged result', retry, async () => {
            const result = await checkMerged(host, container('check'), ctx.line, merged.merge, config);
            if (result.status === 'error') throw new Error(`the check could not run: ${result.log ?? ''}`.slice(0, 500));
            return result;
          });
        } catch (err) {
          return { status: 'error', log: String(err).slice(0, 2000) };
        }
        const failed = landingFromCheck(run);
        if (failed) return failed;
      }
      return step.do('move the line to the tested merge', retry, async () => {
        const r = await promoteLanding(host, container('promote'), ctx.line, claim, merged.merge);
        if (r.status === 'error') throw new Error(r.log ?? 'could not move the line');
        return r;
      });
    })().catch((err): LandingOutcome => ({ status: 'error', log: String(err).slice(0, 2000) }));

    await step.do('record the landing', async () => {
      const r = await stub.completeLanding(graph, line, claim, outcome);
      return r.ok;
    });
    return outcome.status;
  }
}
