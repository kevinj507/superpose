import { DurableObject } from 'cloudflare:workers';
import { tail, type ExecOutcome } from './core/checks';

// One Cloudflare Container per job (a check on one commit, or one landing),
// started by this Durable Object. The image is plain Node with git; nothing is
// built locally. See `containers` in wrangler.jsonc.
export class Checker extends DurableObject<Env> {
  async run(job: { script: string; env: Record<string, string>; timeoutSeconds: number }): Promise<ExecOutcome> {
    const started = Date.now();
    const container = this.ctx.container;
    if (!container) return { exitCode: null, stdout: '', stderr: '', ms: 0, error: 'no container attached to this Durable Object' };
    try {
      await this.ready(container);
    } catch (err) {
      return { exitCode: null, stdout: '', stderr: '', ms: Date.now() - started, error: `container not ready: ${String(err)}` };
    }
    try {
      const proc = await container.exec(['sh', '-c', job.script], { env: job.env, cwd: '/' });
      // The script bounds its own commands with `timeout`; this is the last
      // resort if the container itself hangs.
      const limit = (job.timeoutSeconds * 2 + 60) * 1000;
      const out = await Promise.race([
        proc.output(),
        sleep(limit).then(() => {
          throw new Error(`no result after ${limit / 1000}s`);
        }),
      ]);
      const text = new TextDecoder();
      return {
        exitCode: out.exitCode,
        stdout: tail(text.decode(out.stdout), 8000),
        stderr: tail(text.decode(out.stderr), 4000),
        ms: Date.now() - started,
      };
    } catch (err) {
      return { exitCode: null, stdout: '', stderr: '', ms: Date.now() - started, error: String(err) };
    } finally {
      // Free the instance slot for the next job.
      await container.destroy().catch(() => {});
    }
  }

  // A container can take a while to be placed, especially just after a
  // deploy; retry starting it until a trivial command runs.
  private async ready(container: Container) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 60; attempt++) {
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
