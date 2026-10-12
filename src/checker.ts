import { DurableObject } from 'cloudflare:workers';
import { tail, type ExecJob, type ExecOutcome } from './core/checks';

// One Cloudflare Container per job (a check on one commit, or one landing),
// started by this Durable Object. The image is plain Node with git; nothing is
// built locally. See `containers` in wrangler.jsonc.
export class Checker extends DurableObject<Env> {
  async run(job: ExecJob): Promise<ExecOutcome> {
    const started = Date.now();
    const container = this.ctx.container;
    if (!container) return { exitCode: null, stdout: '', stderr: '', ms: 0, error: 'no container attached to this Durable Object' };
    try {
      await this.ready(container);
    } catch (err) {
      return { exitCode: null, stdout: '', stderr: '', ms: Date.now() - started, error: `container not ready: ${String(err)}` };
    }
    const text = new TextDecoder();
    let stdout = '';
    let stderr = '';
    try {
      let exitCode: number | null = 0;
      for (const step of job.steps) {
        // Each step is its own process with its own environment, so a later
        // step never sees an earlier one's token.
        const proc = await container.exec(['sh', '-c', step.script], { env: step.env, cwd: '/' });
        // The scripts bound their commands with `timeout`; this is the last
        // resort if the container itself hangs.
        const limit = (job.timeoutSeconds * 2 + 60) * 1000;
        const out = await Promise.race([
          proc.output(),
          sleep(limit).then(() => {
            throw new Error(`no result after ${limit / 1000}s`);
          }),
        ]);
        stdout = tail(stdout + text.decode(out.stdout), 8000);
        stderr = tail(stderr + text.decode(out.stderr), 4000);
        exitCode = out.exitCode;
        if (exitCode !== 0) break;
      }
      return { exitCode, stdout, stderr, ms: Date.now() - started };
    } catch (err) {
      return { exitCode: null, stdout, stderr, ms: Date.now() - started, error: String(err) };
    } finally {
      // Free the instance slot for the next job.
      await container.destroy().catch(() => {});
    }
  }

  // A container can take a while to be placed, especially just after a
  // deploy; retry starting it until a trivial command runs.
  private async ready(container: Container) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if (!container.running) container.start({ enableInternet: true, entrypoint: ['sleep', 'infinity'] });
        const probe = await container.exec(['true']);
        await probe.output();
        return;
      } catch (err) {
        lastError = err;
        await sleep(3000);
      }
    }
    throw lastError;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
