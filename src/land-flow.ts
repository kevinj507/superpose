import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { ArtifactsHost } from './artifacts-host';
import { readCheckConfig, type ExecJob } from './core/checks';
import type { LandingOutcome } from './core/engine';
import { checkMerged, landingChecks, landingFromCheck, mergeForLanding, outsideScope, outsideScopeOutcome, promoteLanding } from './core/landing';
import type { CheckRun } from './core/types';

export interface LandParams {
  graph: string;
  line: string;
  claim: string;
  sha: string;
  landing: string; // which landing this is; a late report from an older one is ignored
}

// One landing: the graph's Durable Object (the single writer) picks the next
// claim and starts this. A trusted container merges; an untrusted one runs
// the checks on the merged result with a read token only; a fresh trusted one
// moves the line. The outcome goes back to the Durable Object, which then
// starts the next landing on the line.
export class LandFlow extends WorkflowEntrypoint<Env, LandParams> {
  async run(event: WorkflowEvent<LandParams>, step: WorkflowStep) {
    const { graph, line, claim, sha, landing } = event.payload;
    const stub = this.env.GRAPH.get(this.env.GRAPH.idFromName(graph));
    const host = new ArtifactsHost(this.env.ARTIFACTS!);
    // A container of its own for each attempt of each phase: a timed-out
    // attempt may still be running in the last one.
    const container = (phase: string) => {
      const attempt = crypto.randomUUID();
      return (job: ExecJob) => this.env.CHECKER.get(this.env.CHECKER.idFromName(`land:${graph}:${landing}:${phase}:${attempt}`)).run(job);
    };
    // Room for placing a container (at most 5 minutes, see untilReady) and a
    // 2-minute job.
    const retry = { retries: { limit: 2, delay: '20 seconds' as const, backoff: 'linear' as const }, timeout: '12 minutes' as const };

    const outcome = await (async (): Promise<LandingOutcome> => {
      const ctx = await step.do('find the line and the claim', async () => {
        const r = await stub.landingContext(line, claim);
        if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
        return { line: r.value.line, claim: r.value.claim, statement: r.value.statement, scope: r.value.scope, articles: r.value.articles };
      });
      // Platform trouble (no container, a failed fetch) throws, so the step
      // is retried; a conflict is an answer, not an error.
      const merged = await step.do('merge the claim into the line (no repo code runs)', retry, async () => {
        const r = await mergeForLanding(host, container('merge'), { line: ctx.line, claim: ctx.claim, claimId: claim, sha, statement: ctx.statement });
        if (r.status === 'error') throw new Error(`the merge could not run: ${r.log ?? ''}`.slice(0, 500));
        return r;
      });
      if (merged.status !== 'merged') return merged;
      const outside = await step.do('check that the merge changes only what the claim may', async () => {
        // A landing started before this check existed has no scope in its
        // first step's saved result.
        let scope = ctx.scope;
        if (!scope) {
          const r = await stub.landingContext(line, claim);
          if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
          scope = r.value.scope;
        }
        return outsideScope(host, ctx.line.name, merged.base, merged.merge, scope);
      });
      if (outside.length) return outsideScopeOutcome(outside);

      const config = await step.do('read the checks from the merged result', async () => {
        const configured = await readCheckConfig(host, ctx.line.name, merged.merge);
        const current = await stub.landingContext(line, claim);
        if (!current.ok) throw new Error(current.message);
        return landingChecks(configured, current.value.articles);
      });
      if (config) {
        let run: CheckRun;
        // Room for the setup and the check, each bounded by the timebox.
        const budget = {
          retries: { limit: 1, delay: '20 seconds' as const, backoff: 'linear' as const },
          timeout: `${(config.timeoutSeconds * 2 + 60) * 2 + 420} seconds` as const,
        };
        try {
          run = await step.do('run the checks on the merged result', budget, async () => {
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
      const r = await stub.completeLanding(graph, line, claim, outcome, landing);
      return r.ok;
    });
    return outcome.status;
  }
}
