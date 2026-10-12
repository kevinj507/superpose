import type { RepoHost } from './repos';
import type { CheckRun } from './types';

// How a repo says what its checks are: `superpose.json` at the root, e.g.
//   { "setup": "npm ci", "check": "npm test", "timeoutSeconds": 300 }
// Without one, a package.json with a test script means `npm install` then
// `npm test`. Read from the exact commit being checked, never from the agent.
export interface CheckConfig {
  setup?: string;
  check: string;
  timeoutSeconds: number;
}

const DEFAULT_TIMEOUT = 300;
const MAX_TIMEOUT = 1200;

export async function readCheckConfig(host: RepoHost, repo: string, sha: string): Promise<CheckConfig | null> {
  const declared = await host.readFile(repo, sha, 'superpose.json');
  if (declared !== null) {
    const parsed = parseJson(declared);
    if (parsed && typeof parsed.check === 'string' && parsed.check.trim()) {
      return {
        setup: typeof parsed.setup === 'string' && parsed.setup.trim() ? parsed.setup : undefined,
        check: parsed.check,
        timeoutSeconds: clampTimeout(parsed.timeoutSeconds),
      };
    }
  }
  const pkg = await host.readFile(repo, sha, 'package.json');
  const scripts = pkg !== null ? parseJson(pkg)?.scripts : undefined;
  if (scripts && typeof scripts === 'object' && typeof (scripts as Record<string, unknown>).test === 'string') {
    return { setup: 'npm install --no-audit --no-fund', check: 'npm test', timeoutSeconds: DEFAULT_TIMEOUT };
  }
  return null;
}

// Exit codes the scripts below use to say "the platform failed", as opposed
// to "the code failed".
export const EXIT_FETCH_FAILED = 90;
export const EXIT_MERGE_CONFLICT = 91;
export const EXIT_PUSH_REJECTED = 93;

// A check runs in a fresh container as two separate processes, so code from
// the repo never runs in a process that was given a token:
//   1. FETCH_SCRIPT, with the read token: fetch exactly one commit;
//   2. RUN_SCRIPT, with no token: the setup and the check, each bounded by
//      `timeout` (an exec's own timeout does not bound wall time), with their
//      output kept to its last 64 KB inside the container.
export const FETCH_SCRIPT = `
set -u
rm -rf /work && mkdir -p /work && cd /work
git init -q
git config core.hooksPath /dev/null
git -c http.extraHeader="Authorization: Bearer $GIT_TOKEN" fetch -q --depth 1 "$REMOTE" "$SHA" || exit ${EXIT_FETCH_FAILED}
git checkout -q FETCH_HEAD || exit ${EXIT_FETCH_FAILED}
`;

export const RUN_SCRIPT = `
set -u
cd /work || exit ${EXIT_FETCH_FAILED}
run() {
  timeout -k 5 "$TIMEOUT" sh -c "$1" > /tmp/out.log 2>&1
  code=$?
  tail -c 65536 /tmp/out.log
  return $code
}
if [ -n "\${SETUP:-}" ]; then
  echo "\\$ $SETUP"
  run "$SETUP" || exit $?
fi
echo "\\$ $CHECK"
run "$CHECK"
`;

// Kept for tests that look at the whole check as one script.
export const CHECK_SCRIPT = FETCH_SCRIPT + RUN_SCRIPT;

export interface ExecOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  error?: string; // the container could not run the job at all
}

// What the outcome of a check run means for the verdict.
export function checkRunFrom(outcome: ExecOutcome, config: CheckConfig, startedAt: number, finishedAt: number): CheckRun {
  const log = tail(`${outcome.stdout}${outcome.stderr ? `\n${outcome.stderr}` : ''}${outcome.error ? `\n${outcome.error}` : ''}`);
  const base = { command: config.check, startedAt, finishedAt, log };
  if (outcome.error || outcome.exitCode === null) return { ...base, status: 'error' };
  const exitCode = outcome.exitCode;
  if (exitCode === 0) return { ...base, status: 'passed', exitCode };
  if (exitCode === EXIT_FETCH_FAILED) return { ...base, status: 'error', exitCode };
  if (exitCode === 124 || exitCode === 137) return { ...base, status: 'timeout', exitCode };
  return { ...base, status: 'failed', exitCode };
}

export function tail(text: string, max = 4000): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

function clampTimeout(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : DEFAULT_TIMEOUT;
  return Math.min(MAX_TIMEOUT, Math.max(10, n));
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// A job is one or more steps run one after another in the same container,
// each a separate process with its own environment; the first that fails
// ends the job with its exit code.
export interface ExecJob {
  steps: { script: string; env: Record<string, string> }[];
  timeoutSeconds: number;
}

// Run a claim's checks on one exact commit. A read token for the claim's repo
// is minted for this run only and revoked afterwards.
export async function runCheck(
  host: RepoHost,
  exec: (job: ExecJob) => Promise<ExecOutcome>,
  repo: { name: string; remote: string },
  sha: string,
  config: CheckConfig,
  now: () => number = Date.now,
): Promise<CheckRun> {
  const startedAt = now();
  const token = await host.mintToken(repo.name, 'read', Math.max(60, config.timeoutSeconds * 2 + 120));
  try {
    const outcome = await exec({
      steps: [
        { script: FETCH_SCRIPT, env: { GIT_TOKEN: token.secret, REMOTE: repo.remote, SHA: sha } },
        { script: RUN_SCRIPT, env: { SETUP: config.setup ?? '', CHECK: config.check, TIMEOUT: String(config.timeoutSeconds) } },
      ],
      timeoutSeconds: config.timeoutSeconds,
    });
    return checkRunFrom(outcome, config, startedAt, now());
  } finally {
    await host.revokeToken(repo.name, token.id).catch(() => {});
  }
}
