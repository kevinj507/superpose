import {
  EXIT_FETCH_FAILED,
  EXIT_MERGE_CONFLICT,
  EXIT_PUSH_REJECTED,
  runCheck,
  tail,
  type CheckConfig,
  type ExecJob,
  type ExecOutcome,
} from './checks';
import type { LandingOutcome } from './engine';
import { changedPathsChecked, type RepoHost } from './repos';
import { inScope } from './scope';
import type { CheckRun, RepoRef } from './types';

// Landing runs in three containers, so code from the repo never runs where a
// token that can write the line exists:
//   1. merge (trusted: no repo code runs): fetch the line and the claim's exact
//      commit, `git merge --no-ff`, and push the merge commit to a staging
//      branch of the line repo;
//   2. check (untrusted, read token only): the claim's checks on the merge;
//   3. promote (trusted, fresh): move the line's main to that merge commit,
//      fast-forward only, and drop the staging branch.
// Git never runs hooks here (none are fetched, and hooks are off), and the
// tokens arrive in the environment, never in the script.

export function stagingRef(claimId: string): string {
  return `refs/heads/superpose/landing-${claimId}`;
}

export const MERGE_SCRIPT = `
set -u
rm -rf /work && mkdir -p /work && cd /work
git init -q -b main
git config user.name "Superpose"
git config user.email "land@superpose.invalid"
git config core.hooksPath /dev/null
git -c http.extraHeader="Authorization: Bearer $LINE_TOKEN" ls-remote --exit-code "$LINE_REMOTE" refs/heads/main > /dev/null 2>&1
found=$?
if [ $found -eq 0 ]; then
  git -c http.extraHeader="Authorization: Bearer $LINE_TOKEN" fetch -q "$LINE_REMOTE" main || exit ${EXIT_FETCH_FAILED}
  git checkout -q -B main FETCH_HEAD || exit ${EXIT_FETCH_FAILED}
  echo "BASE $(git rev-parse HEAD)"
  git -c http.extraHeader="Authorization: Bearer $CLAIM_TOKEN" fetch -q "$CLAIM_REMOTE" "$SHA" || exit ${EXIT_FETCH_FAILED}
  if ! git merge -q --no-ff -m "$MESSAGE" FETCH_HEAD; then
    echo "CONFLICT"
    git diff --name-only --diff-filter=U
    exit ${EXIT_MERGE_CONFLICT}
  fi
elif [ $found -eq 2 ]; then
  # A line with no commits yet: the claim's work becomes its first history.
  git -c http.extraHeader="Authorization: Bearer $CLAIM_TOKEN" fetch -q "$CLAIM_REMOTE" "$SHA" || exit ${EXIT_FETCH_FAILED}
  git checkout -q -B main FETCH_HEAD || exit ${EXIT_FETCH_FAILED}
else
  # The line could not be read (network, auth), which is not an empty line.
  exit ${EXIT_FETCH_FAILED}
fi
git -c http.extraHeader="Authorization: Bearer $LINE_TOKEN" push -q --no-verify -f "$LINE_REMOTE" "HEAD:$STAGING" || exit ${EXIT_PUSH_REJECTED}
echo "MERGED $(git rev-parse HEAD)"
`;

export const PROMOTE_SCRIPT = `
set -u
rm -rf /work && mkdir -p /work && cd /work
git init -q -b main
git config core.hooksPath /dev/null
git -c http.extraHeader="Authorization: Bearer $LINE_TOKEN" fetch -q "$LINE_REMOTE" "$STAGING" || exit ${EXIT_FETCH_FAILED}
[ "$(git rev-parse FETCH_HEAD)" = "$MERGE" ] || { echo "the staging branch moved"; exit ${EXIT_PUSH_REJECTED}; }
git -c http.extraHeader="Authorization: Bearer $LINE_TOKEN" push -q --no-verify "$LINE_REMOTE" "$MERGE:refs/heads/main" || exit ${EXIT_PUSH_REJECTED}
git -c http.extraHeader="Authorization: Bearer $LINE_TOKEN" push -q --no-verify "$LINE_REMOTE" ":$STAGING" || true
echo "LANDED $MERGE"
`;

export interface LandingJob {
  line: RepoRef;
  claim: RepoRef;
  claimId: string;
  sha: string;
  statement: string;
}

export type MergeResult =
  | { status: 'merged'; merge: string; base: string | null; log: string }
  | Exclude<LandingOutcome, { status: 'landed' }>;

type Exec = (job: ExecJob) => Promise<ExecOutcome>;

const TOKEN_TTL = 900;

export async function mergeForLanding(host: RepoHost, exec: Exec, job: LandingJob): Promise<MergeResult> {
  const lineToken = await host.mintToken(job.line.name, 'write', TOKEN_TTL);
  try {
    const claimToken = await host.mintToken(job.claim.name, 'read', TOKEN_TTL);
    try {
      const outcome = await exec({
        steps: [
          {
            script: MERGE_SCRIPT,
            env: {
              LINE_TOKEN: lineToken.secret,
              LINE_REMOTE: job.line.remote,
              CLAIM_TOKEN: claimToken.secret,
              CLAIM_REMOTE: job.claim.remote,
              SHA: job.sha,
              MESSAGE: landingMessage(job.claimId, job.statement),
              STAGING: stagingRef(job.claimId),
            },
          },
        ],
        timeoutSeconds: 120,
      });
      const result = mergeResult(outcome);
      // The script found no main on the line. If the line has commits, that
      // was a failed read, not an empty line: retried, never judged.
      if (result.status === 'merged' && !result.base && (await host.readHead(job.line.name))) {
        return { status: 'error', log: `the line looked empty to the merge, but it has commits\n${result.log}` };
      }
      return result;
    } finally {
      await host.revokeToken(job.claim.name, claimToken.id).catch(() => {});
    }
  } finally {
    await host.revokeToken(job.line.name, lineToken.id).catch(() => {});
  }
}

// The claim's checks, on the merged result, holding only a read token.
export function checkMerged(host: RepoHost, exec: Exec, line: RepoRef, merge: string, config: CheckConfig): Promise<CheckRun> {
  return runCheck(host, exec, line, merge, config);
}

export async function promoteLanding(host: RepoHost, exec: Exec, line: RepoRef, claimId: string, merge: string): Promise<LandingOutcome> {
  const lineToken = await host.mintToken(line.name, 'write', TOKEN_TTL);
  try {
    const outcome = await exec({
      steps: [{ script: PROMOTE_SCRIPT, env: { LINE_TOKEN: lineToken.secret, LINE_REMOTE: line.remote, STAGING: stagingRef(claimId), MERGE: merge } }],
      timeoutSeconds: 120,
    });
    const log = logOf(outcome);
    if (!outcome.error && outcome.exitCode === 0 && outcome.stdout.includes(`LANDED ${merge}`)) return { status: 'landed', merge, log };
    return { status: 'error', log: `could not move the line to the merge: ${log}` };
  } finally {
    await host.revokeToken(line.name, lineToken.id).catch(() => {});
  }
}

// What a landing would change on its line outside the claim's scope. A
// claim's pushes are judged from a base chosen when each push arrives, but
// git merges from the merge base, and the two can differ: a reopened claim,
// or one that merged other work in, could make its landing undo files it
// does not own. So the exact merge is judged against the line head it was
// made on, before anything runs on it, and lands only if this is empty.
export async function outsideScope(host: RepoHost, line: string, base: string | null, merge: string, scope: string[]): Promise<string[]> {
  const listed = await changedPathsChecked(host, line, base, merge);
  if (listed.tooLarge) return ['(more changed files than can be listed)'];
  return listed.paths.filter((path) => !inScope(path, scope));
}

export function outsideScopeOutcome(outside: string[]): Exclude<LandingOutcome, { status: 'landed' }> {
  const shown = outside.slice(0, 20).join(', ') + (outside.length > 20 ? `, and ${outside.length - 20} more` : '');
  return { status: 'failed', log: `not landed: the merge changes files outside the claim's scope: ${shown}` };
}

// What the checks on the merged result mean for the landing.
export function landingFromCheck(run: CheckRun): Exclude<LandingOutcome, { status: 'landed' }> | null {
  if (run.status === 'passed' || run.status === 'skipped') return null;
  if (run.status === 'error') return { status: 'error', log: run.log };
  return { status: 'failed', log: run.log };
}

// The merge commit names its claim, so blame on the line leads back to the
// claim, its assumptions and its decision.
export function landingMessage(claimId: string, statement: string): string {
  const title = statement.replace(/\s+/g, ' ').trim().slice(0, 72);
  return `Land ${claimId}: ${title}\n\nSuperpose-Claim: ${claimId}`;
}

export function mergeResult(outcome: ExecOutcome): MergeResult {
  const log = logOf(outcome);
  if (outcome.error || outcome.exitCode === null) return { status: 'error', log };
  if (outcome.exitCode === 0) {
    const merge = /MERGED ([0-9a-f]{40})/.exec(outcome.stdout)?.[1];
    const base = /BASE ([0-9a-f]{40})/.exec(outcome.stdout)?.[1] ?? null;
    return merge ? { status: 'merged', merge, base, log } : { status: 'error', log: `no merge commit reported\n${log}` };
  }
  if (outcome.exitCode === EXIT_MERGE_CONFLICT) {
    // The files follow the script's own bare CONFLICT line; git's "CONFLICT
    // (content): …" lines, which it prints before, are not file names.
    const after = outcome.stdout.split(/^CONFLICT$/m).pop() ?? '';
    const files = after.split('\n').map((l) => l.trim()).filter(Boolean);
    return { status: 'conflict', files, log };
  }
  return { status: 'error', log };
}

function logOf(outcome: ExecOutcome): string {
  return tail(`${outcome.stdout}${outcome.stderr ? `\n${outcome.stderr}` : ''}${outcome.error ? `\n${outcome.error}` : ''}`);
}
