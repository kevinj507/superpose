import { EXIT_FETCH_FAILED, EXIT_MERGE_CONFLICT, EXIT_PUSH_REJECTED, tail, type CheckConfig, type ExecJob, type ExecOutcome } from './checks';
import type { LandingOutcome } from './engine';
import type { RepoHost } from './repos';
import type { RepoRef } from './types';

// Runs in a fresh container: a real `git merge` of the claim's exact commit
// into its line, the checks on the merged result, and a push to the line only
// if they pass (a claim lands only with a passing verdict on what it becomes
// part of). Tokens arrive in the environment, never in the script.
export const LAND_SCRIPT = `
set -u
rm -rf /work && mkdir -p /work && cd /work
git init -q -b main
git config user.name "Superpose"
git config user.email "land@superpose.invalid"
git -c http.extraHeader="Authorization: Bearer $LINE_TOKEN" fetch -q "$LINE_REMOTE" main || exit ${EXIT_FETCH_FAILED}
git checkout -q -B main FETCH_HEAD || exit ${EXIT_FETCH_FAILED}
git -c http.extraHeader="Authorization: Bearer $CLAIM_TOKEN" fetch -q "$CLAIM_REMOTE" "$SHA" || exit ${EXIT_FETCH_FAILED}
if ! git merge -q --no-ff -m "$MESSAGE" FETCH_HEAD; then
  echo "CONFLICT"
  git diff --name-only --diff-filter=U
  exit ${EXIT_MERGE_CONFLICT}
fi
if [ -n "\${CHECK:-}" ]; then
  if [ -n "\${SETUP:-}" ]; then
    echo "\\$ $SETUP"
    timeout -k 5 "$TIMEOUT" sh -c "$SETUP" 2>&1 || exit $?
  fi
  echo "\\$ $CHECK"
  timeout -k 5 "$TIMEOUT" sh -c "$CHECK" 2>&1 || exit $?
  git clean -fdxq
fi
git -c http.extraHeader="Authorization: Bearer $LINE_TOKEN" push -q "$LINE_REMOTE" HEAD:main || exit ${EXIT_PUSH_REJECTED}
echo "MERGED $(git rev-parse HEAD)"
`;

export interface LandingJob {
  line: RepoRef;
  claim: RepoRef;
  claimId: string;
  sha: string;
  statement: string;
  config: CheckConfig | null;
}

export async function runLanding(
  host: RepoHost,
  exec: (job: ExecJob) => Promise<ExecOutcome>,
  job: LandingJob,
): Promise<LandingOutcome> {
  const timeoutSeconds = job.config?.timeoutSeconds ?? 300;
  const ttl = Math.max(60, timeoutSeconds * 2 + 300);
  const lineToken = await host.mintToken(job.line.name, 'write', ttl);
  const claimToken = await host.mintToken(job.claim.name, 'read', ttl).catch(async (err) => {
    await host.revokeToken(job.line.name, lineToken.id).catch(() => {});
    throw err;
  });
  try {
    const outcome = await exec({
      script: LAND_SCRIPT,
      env: {
        LINE_TOKEN: lineToken.secret,
        LINE_REMOTE: job.line.remote,
        CLAIM_TOKEN: claimToken.secret,
        CLAIM_REMOTE: job.claim.remote,
        SHA: job.sha,
        MESSAGE: landingMessage(job.claimId, job.statement),
        SETUP: job.config?.setup ?? '',
        CHECK: job.config?.check ?? '',
        TIMEOUT: String(timeoutSeconds),
      },
      timeoutSeconds,
    });
    return landingOutcome(outcome);
  } finally {
    await host.revokeToken(job.line.name, lineToken.id).catch(() => {});
    await host.revokeToken(job.claim.name, claimToken.id).catch(() => {});
  }
}

// The merge commit names its claim, so blame on the line leads back to the
// claim, its assumptions and its decision.
export function landingMessage(claimId: string, statement: string): string {
  const title = statement.replace(/\s+/g, ' ').trim().slice(0, 72);
  return `Land ${claimId}: ${title}\n\nSuperpose-Claim: ${claimId}`;
}

export function landingOutcome(outcome: ExecOutcome): LandingOutcome {
  const log = tail(`${outcome.stdout}${outcome.stderr ? `\n${outcome.stderr}` : ''}${outcome.error ? `\n${outcome.error}` : ''}`);
  if (outcome.error || outcome.exitCode === null) return { status: 'error', log };
  if (outcome.exitCode === 0) {
    const merge = /MERGED ([0-9a-f]{40})/.exec(outcome.stdout)?.[1];
    return merge ? { status: 'landed', merge, log } : { status: 'error', log: `no merge commit reported\n${log}` };
  }
  if (outcome.exitCode === EXIT_MERGE_CONFLICT) {
    const after = outcome.stdout.split('CONFLICT')[1] ?? '';
    const files = after.split('\n').map((l) => l.trim()).filter(Boolean);
    return { status: 'conflict', files, log };
  }
  if (outcome.exitCode === EXIT_FETCH_FAILED || outcome.exitCode === EXIT_PUSH_REJECTED) return { status: 'error', log };
  return { status: 'failed', log };
}
