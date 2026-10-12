import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { tail, type ExecJob } from './core/checks';
import { PLAY_FILES } from './play-bundle';

// The playground: anyone can watch the whole story without tokens or a
// machine of their own. A fresh container gets the runner and the world
// scenario, plans a new graph, starts scripted agents (one of them is set to
// report that a shared random stream couples the modules), and a director
// plays the human: it verifies that finding after it has run as a hedge, and
// switches the served reality once the other line has landed. The graph is
// deleted two hours later.

export interface PlayParams {
  graph: string;
  url: string; // this deployment, which the container talks to
}

// What the scripted agent on the links claim reports, the way the real agent
// in the rehearsal did.
const FINDINGS = JSON.stringify([
  {
    when: 'Stable world links',
    contradicts: 'one shared random stream',
    statement:
      'A shared random stream couples the modules: when forests draws more random numbers, every town moves, so a link to a world shows a different world after any change to an earlier module.',
  },
]);

const PLAY_SCRIPT = `
set -u
cd /play || exit 1
node runner/plan.mjs scenarios/world --graph "$GRAPH" || exit 1
node runner/play-director.mjs --graph "$GRAPH" --hedge 20 --timeout 1500 > /tmp/director.log 2>&1 &
director=$!
node runner/run.mjs --graph "$GRAPH" --agents 4 --agent scripted --hold 6 --quiet --patience 600 --work /tmp/work --runs /tmp/runs
# The agents can be done while the last landings are still on their way, and
# the director switches only after those land, so it is bounded by its own
# --timeout rather than stopped here.
wait $director
echo "--- director"
tail -n 20 /tmp/director.log
`;

// One step per file, written from base64 so nothing in it is ever read by
// the shell.
function fileSteps(): ExecJob['steps'] {
  return Object.entries(PLAY_FILES).map(([path, text]) => {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return {
      script: `mkdir -p "$(dirname "/play/$FILE")" && printf '%s' "$DATA" | base64 -d > "/play/$FILE"`,
      env: { FILE: path, DATA: btoa(binary) },
    };
  });
}

export class PlayFlow extends WorkflowEntrypoint<Env, PlayParams> {
  async run(event: WorkflowEvent<PlayParams>, step: WorkflowStep) {
    const { graph, url } = event.payload;
    // Whatever happens to the run, the graph is deleted afterwards.
    const result = await step.do(
      'plan a world and run agents on it in a container',
      { retries: { limit: 0, delay: '1 second' }, timeout: '60 minutes' },
      async () => {
        const stub = this.env.CHECKER.get(this.env.CHECKER.idFromName(`play:${graph}`));
        const out = await stub.run({
          steps: [
            ...fileSteps(),
            {
              script: PLAY_SCRIPT,
              env: {
                GRAPH: graph,
                SUPERPOSE_URL: url,
                SUPERPOSE_ADMIN_TOKEN: this.env.ADMIN_TOKEN,
                SUPERPOSE_AGENT_KEY: this.env.AGENT_KEY,
                SUPERPOSE_SCRIPTED_FINDINGS: FINDINGS,
              },
            },
          ],
          timeoutSeconds: 1200,
        });
        return { exitCode: out.exitCode, log: tail(`${out.stdout}\n${out.stderr}${out.error ? `\n${out.error}` : ''}`, 3000) };
      },
    ).catch((err) => ({ exitCode: null, log: `the run failed: ${String(err)}`.slice(0, 3000) }));
    await step.sleep('keep the graph for people to look at', '2 hours');
    await step.do('delete the graph', { retries: { limit: 5, delay: '1 minute', backoff: 'exponential' } }, async () => {
      const r = await this.env.GRAPH.get(this.env.GRAPH.idFromName(graph)).destroy(graph);
      // Thrown, so the deletion is tried again until every repo is gone.
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      return true;
    });
    return result;
  }
}
