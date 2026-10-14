#!/usr/bin/env bun
// No model requests. This proves the filesystem boundary, not live network
// routing, model access or spend limits. Live execution still needs those gates.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { image: { type: 'string' }, out: { type: 'string' } } });
if (!values.image || !values.out) throw new Error('--image <already-local-image> and --out <operator-report.json> are required');
const run = (args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 });
const inspected = run(['image', 'inspect', '--format', '{{.Id}}', values.image]);
const image = inspected.stdout?.trim();
if (inspected.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new Error('The probe needs an existing local image; it never pulls one');
const root = mkdtempSync('/tmp/superpose-isolation-');
const own = join(root, 'own'), other = join(root, 'other-group');
mkdirSync(own); mkdirSync(other);
writeFileSync(join(own, 'public.txt'), 'PUBLIC\n');
writeFileSync(join(other, 'answer.txt'), 'PRIVATE-SYNTHETIC-CANARY\n');
symlinkSync(join(other, 'answer.txt'), join(own, 'escape'));
const script = `set -eu
test "$(cat /workspace/public.txt)" = PUBLIC
printf 'EDITED\\n' > /workspace/progress.txt
for path in "$1" "$2" /root/workspace/superpose /root/.bb /var/run/docker.sock; do
  if test -e "$path"; then echo 'unexpected host path visible' >&2; exit 1; fi
done
if cat /workspace/escape >/dev/null 2>&1; then echo 'symlink escaped the checkout' >&2; exit 1; fi
test -z "\${GRAPHTASK_AGENT_TOKEN-}\${CLOUDFLARE_API_TOKEN-}\${SUPERPOSE_ADMIN_TOKEN-}\${SUPERPOSE_AGENT_KEY-}\${BB_THREAD_ID-}\${CODEX_THREAD_ID-}"
printf 'isolated\\n' > /tmp/own-temp.txt
cat /tmp/own-temp.txt
`;
try {
  const args = ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64',
    '--memory', '256m', '--cpus', '1', '--user', `${process.getuid()}:${process.getgid()}`,
    '--mount', `type=bind,src=${own},dst=/workspace`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m', '--workdir', '/workspace', '--entrypoint', '/bin/sh',
    image, '-c', script, 'probe', other, root];
  const result = run(args);
  const passed = result.status === 0 && result.stdout.trim() === 'isolated' &&
    readFileSync(join(own, 'progress.txt'), 'utf8') === 'EDITED\n';
  const report = {
    at: new Date().toISOString(), image, passed, modelRequests: 0,
    checks: { ownReadAndWrite: passed, otherGroupDenied: passed, hostProjectDenied: passed,
      hostSessionStorageDenied: passed, dockerSocketDenied: passed, symlinkEscapeDenied: passed,
      inheritedSecretsAbsent: passed, privateTemp: passed },
    network: 'disabled-for-this-probe', liveNetworkVerified: false, launcherReady: false,
    ...(passed ? {} : { exitCode: result.status, error: result.error?.message ?? result.stderr?.trim() ?? 'probe failed' }),
  };
  writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed, report: values.out, modelRequests: 0, liveNetworkVerified: false }));
  if (!passed) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
