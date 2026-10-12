import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { ArtifactsHost } from './artifacts-host';
import { readCheckConfig, type ExecJob } from './core/checks';
import type { LandingOutcome } from './core/engine';
import { runLanding } from './core/landing';

export interface LandParams {
  graph: string;
  line: string;
  claim: string;
  sha: string;
}

// One landing: the graph's Durable Object (the single writer) picks the next
// claim and starts this; the merge and the checks on the merged result run in
// a container; the outcome goes back to the Durable Object, which then starts
// the next landing on the line.
export class LandFlow extends WorkflowEntrypoint<Env, LandParams> {
  async run(event: WorkflowEvent<LandParams>, step: WorkflowStep) {
    const { graph, line, claim, sha } = event.payload;
    const stub = this.env.GRAPH.get(this.env.GRAPH.idFromName(graph));
    const host = new ArtifactsHost(this.env.ARTIFACTS!);

    const ctx = await step.do('find the line and the claim', async () => {
      const r = await stub.landingContext(line, claim);
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      return { line: r.value.line, claim: r.value.claim, statement: r.value.statement };
    });
    const config = await step.do('read the checks from the claim\'s commit', () => readCheckConfig(host, ctx.claim.name, sha));
    const outcome = await step.do(
      'merge into the line and run the checks on the result',
      { retries: { limit: 1, delay: '20 seconds' }, timeout: '30 minutes' },
      async (): Promise<LandingOutcome> => {
        const exec = (job: ExecJob) =>
          this.env.CHECKER.get(this.env.CHECKER.idFromName(`land:${graph}:${line}:${claim}:${sha}`)).run(job);
        return runLanding(host, exec, { line: ctx.line, claim: ctx.claim, claimId: claim, sha, statement: ctx.statement, config });
      },
    );
    await step.do('record the landing', async () => {
      const r = await stub.completeLanding(graph, line, claim, outcome);
      return r.ok;
    });
    return outcome.status;
  }
}
