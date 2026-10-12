import { DurableObject } from 'cloudflare:workers';
import { tail, type ExecJob, type ExecOutcome } from './core/checks';
import { untilReady, within } from './core/container';

// One Cloudflare Container per job (a check on one commit, or one landing),
// started by this Durable Object. The image is plain Node with git; nothing is
// built locally. See `containers` in wrangler.jsonc.
export class Checker extends DurableObject<Env> {
  async run(job: ExecJob): Promise<ExecOutcome> {
    const started = Date.now();
    const container = this.ctx.container;
    if (!container) return { exitCode: null, stdout: '', stderr: '', ms: 0, error: 'no container attached to this Durable Object' };
    const text = new TextDecoder();
    let stdout = '';
    let stderr = '';
    try {
      // A container can take a while to be placed, especially just after a
      // deploy, and one can stop answering altogether; see untilReady.
      try {
        await untilReady({
          running: () => container.running,
          start: () => container.start({ enableInternet: true, entrypoint: ['sleep', 'infinity'] }),
          probe: async () => (await container.exec(['true'])).output(),
        });
      } catch (err) {
        return { exitCode: null, stdout: '', stderr: '', ms: Date.now() - started, error: `container not ready: ${String(err)}` };
      }
      let exitCode: number | null = 0;
      let index = -1;
      for (const step of job.steps) {
        index++;
        // Each step is its own process with its own environment, so a later
        // step never sees an earlier one's token.
        const proc = await container.exec(['sh', '-c', step.script], { env: step.env, cwd: '/' });
        // The scripts bound their commands with `timeout`; this is the last
        // resort if the container itself hangs.
        const out = await within((job.timeoutSeconds * 2 + 60) * 1000, 'the job', proc.output());
        stdout = tail(stdout + text.decode(out.stdout), 8000);
        stderr = tail(stderr + text.decode(out.stderr), 4000);
        exitCode = out.exitCode;
        if (exitCode !== 0) break;
      }
      return { exitCode, stdout, stderr, ms: Date.now() - started, step: index };
    } catch (err) {
      return { exitCode: null, stdout, stderr, ms: Date.now() - started, error: String(err) };
    } finally {
      // Free the instance slot for the next job, without waiting long on a
      // container that has stopped answering.
      await within(30_000, 'destroy', container.destroy()).catch(() => {});
    }
  }
}
