import { EXIT_FETCH_FAILED, EXIT_MERGE_CONFLICT, tail, type CheckConfig, type ExecJob, type ExecOutcome } from './checks';
import type { RepoHost } from './repos';
import type { PairCheck, RepoRef } from './types';
import { CHECK_INPUT_GUARD, checkInputEnv } from './check-inputs';

// The gate on combinations. A claim's own checks run on its commit alone;
// the break the pricing test showed lives in the combination, so at every
// push the commit is also merged with the line as it stands and the
// constitution's checks run on the pair. Two containers' worth of steps in
// one container: a trusted step with read tokens makes the merges (no repo
// code runs), an untrusted step with no token runs the checks.
//
// When an article breaks on the pair, the partner is looked for: the merges
// of the head with each landing since the claim's fork point are made in the
// trusted step too, and the untrusted step runs the broken articles on them,
// oldest first; the first that breaks names the claim it landed. "Holds on
// the line before c3, breaks with c2 and c3 together" is then a measured
// sentence, with no judgement in it.

export interface PairJob {
  line: RepoRef;
  claim: RepoRef;
  sha: string;
  articles: { id: string; check: string }[];
  // Landings on the line since the claim's fork point, oldest first.
  candidates: { claim: string; merge: string }[];
  config: CheckConfig; // the project's setup and timebox; `check` is not used
}

export const PAIR_MERGE_SCRIPT = `
set -u
rm -rf /work && mkdir -p /work && cd /work
git init -q -b main
git config user.name "Superpose"
git config user.email "gate@superpose.invalid"
git config core.hooksPath /dev/null
git -c http.extraHeader="Authorization: Bearer $LINE_TOKEN" ls-remote --exit-code "$LINE_REMOTE" refs/heads/main > /dev/null 2>&1
found=$?
if [ $found -eq 2 ]; then
  echo "EMPTY LINE"
  exit 0
fi
[ $found -eq 0 ] || exit ${EXIT_FETCH_FAILED}
git -c http.extraHeader="Authorization: Bearer $LINE_TOKEN" fetch -q "$LINE_REMOTE" main || exit ${EXIT_FETCH_FAILED}
git checkout -q -B main FETCH_HEAD || exit ${EXIT_FETCH_FAILED}
echo "BASE $(git rev-parse HEAD)"
git worktree add -q --detach /work-line HEAD || exit ${EXIT_FETCH_FAILED}
git -c http.extraHeader="Authorization: Bearer $CLAIM_TOKEN" fetch -q "$CLAIM_REMOTE" "$SHA" || exit ${EXIT_FETCH_FAILED}
git branch -q -f head FETCH_HEAD
if ! git merge -q --no-ff -m "pair" head > /dev/null 2>&1; then
  echo "CONFLICT"
  git diff --name-only --diff-filter=U
  exit ${EXIT_MERGE_CONFLICT}
fi
echo "MERGED $(git rev-parse HEAD)"
for cand in $CANDIDATES; do
  id=\${cand%%=*}
  sha=\${cand#*=}
  if git worktree add -q "/work-$id" "$sha" > /dev/null 2>&1 && git -C "/work-$id" merge -q --no-ff -m "pair" head > /dev/null 2>&1; then
    echo "CAND $id ok"
  else
    echo "CAND $id skipped"
  fi
done
touch /work/.pair-ready
`;

export const PAIR_RUN_SCRIPT = `
set -u
${CHECK_INPUT_GUARD}
[ -f /work/.pair-ready ] || { echo "PAIR SKIPPED"; exit 0; }
TAB="$(printf '\\t')"
run() {
  timeout -k 5 "$TIMEOUT" sh -c "$1" > "$2" 2>&1
}
# The constitution's checks in one folder; the ids that broke go to a file.
check_in() {
  dir=$1
  label=$2
  cd "$dir" || return 2
  if [ -n "\${SETUP:-}" ]; then
    run "$SETUP" "/tmp/setup-$label.log" || { echo "SETUP FAILED ($label)"; tail -c 2000 "/tmp/setup-$label.log"; return 2; }
  fi
  : > "/tmp/broken-$label"
  : > "/tmp/unavailable-$label"
  printf '%s\\n' "$CHECKS" | while IFS="$TAB" read -r id cmd; do
    [ -n "$id" ] || continue
    run "$cmd" "/tmp/check-$label-$id.log"
    code=$?
    if [ $code -eq 0 ]; then
      echo "ARTICLE $label $id ok"
    elif [ $code -eq 124 ] || [ $code -eq 137 ]; then
      echo "ARTICLE $label $id UNAVAILABLE"
      echo "$id" >> "/tmp/unavailable-$label"
    else
      echo "ARTICLE $label $id BROKEN"
      echo "$id" >> "/tmp/broken-$label"
    fi
  done
  [ -s "/tmp/unavailable-$label" ] && return 2
  [ -s "/tmp/broken-$label" ] && return 1
  return 0
}
check_in /work pair
status=$?
[ $status -eq 2 ] && exit 2
if [ $status -eq 0 ]; then
  echo "PAIR OK"
  exit 0
fi
for id in $(cat /tmp/broken-pair); do
  echo "--- $id"
  tail -c 3000 "/tmp/check-pair-$id.log"
done
# A failure already present on the line is not evidence against this claim.
# Both folders use the same declared runtime inputs and exact fetched line.
check_in /work-line baseline
baseline_status=$?
[ $baseline_status -eq 2 ] && exit 2
: > /tmp/introduced
: > /tmp/preexisting
for id in $(cat /tmp/broken-pair); do
  if grep -qxF "$id" /tmp/broken-baseline; then
    echo "$id" >> /tmp/preexisting
  else
    echo "$id" >> /tmp/introduced
  fi
done
echo "BASELINE_BROKEN $(tr '\\n' ' ' < /tmp/preexisting)"
if [ ! -s /tmp/introduced ]; then
  echo "BLOCKED"
  exit 1
fi
echo "BROKEN $(tr '\\n' ' ' < /tmp/introduced)"
# Search only for newly failing articles; an existing failure cannot name a partner.
CHECKS=$(printf '%s\\n' "$CHECKS" | while IFS="$TAB" read -r id cmd; do
  if grep -qxF "$id" /tmp/introduced; then printf '%s\\t%s\\n' "$id" "$cmd"; fi
done)
# The partner: the oldest landing the head already breaks the articles with.
for id in $CANDIDATES; do
  [ -d "/work-$id" ] || continue
  check_in "/work-$id" "$id" > /dev/null 2>&1
  candidate_status=$?
  if [ $candidate_status -eq 0 ]; then
    echo "CAND $id passes"
  elif [ $candidate_status -eq 1 ]; then
    echo "PARTNER $id"
    break
  else
    echo "CAND $id unavailable"
    break
  fi
done
exit 1
`;

type Exec = (job: ExecJob) => Promise<ExecOutcome>;

export async function checkPair(host: RepoHost, exec: Exec, job: PairJob, now: () => number = Date.now): Promise<PairCheck> {
  const startedAt = now();
  const candidates = job.candidates.slice(-8);
  const perRun = job.config.timeoutSeconds;
  // One check per article, in the pair and in each candidate: the job's own
  // timebox covers them all.
  const timeoutSeconds = Math.min(1200, Math.max(60, perRun * (2 + candidates.length) * (job.articles.length + (job.config.setup ? 1 : 0))));
  const ttl = Math.max(120, timeoutSeconds * 2 + 120);
  const lineToken = await host.mintToken(job.line.name, 'read', ttl);
  try {
    const claimToken = await host.mintToken(job.claim.name, 'read', ttl);
    try {
      const outcome = await exec({
        steps: [
          {
            script: PAIR_MERGE_SCRIPT,
            env: {
              LINE_TOKEN: lineToken.secret,
              LINE_REMOTE: job.line.remote,
              CLAIM_TOKEN: claimToken.secret,
              CLAIM_REMOTE: job.claim.remote,
              SHA: job.sha,
              CANDIDATES: candidates.map((c) => `${c.claim}=${c.merge}`).join(' '),
            },
          },
          {
            script: PAIR_RUN_SCRIPT,
            env: {
              SETUP: job.config.setup ?? '',
              CHECKS: job.articles.map((a) => `${a.id}\t${a.check}`).join('\n'),
              ...checkInputEnv(job.config.inputs),
              TIMEOUT: String(perRun),
              CANDIDATES: candidates.map((c) => c.claim).join(' '),
            },
          },
        ],
        timeoutSeconds,
      });
      return { ...pairResult(outcome, startedAt, now()), ...(job.config.inputs ? { inputVersion: job.config.inputs.version } : {}) };
    } finally {
      await host.revokeToken(job.claim.name, claimToken.id).catch(() => {});
    }
  } finally {
    await host.revokeToken(job.line.name, lineToken.id).catch(() => {});
  }
}

// What the container's output means. Only the merge step speaks for the
// platform (a fetch that failed); whatever the checks end with is a verdict
// on the pair.
export function pairResult(outcome: ExecOutcome, startedAt: number, finishedAt: number): PairCheck {
  const stdout = outcome.stdout ?? '';
  const log = tail(`${stdout}${outcome.stderr ? `\n${outcome.stderr}` : ''}${outcome.error ? `\n${outcome.error}` : ''}`);
  const lineHead = /BASE ([0-9a-f]{40})/.exec(stdout)?.[1] ?? null;
  const merge = /MERGED ([0-9a-f]{40})/.exec(stdout)?.[1];
  const base = { lineHead, ...(merge ? { merge } : {}), log, startedAt, finishedAt };
  if (outcome.error || outcome.exitCode === null) return { ...base, status: 'error' };
  if (/^(EMPTY LINE|PAIR SKIPPED)$/m.test(stdout)) return { ...base, status: 'skipped' };
  if ((outcome.step ?? 0) === 0 && outcome.exitCode !== 0) {
    if (outcome.exitCode === EXIT_MERGE_CONFLICT) {
      // The files follow the script's own bare CONFLICT line (git's "CONFLICT
      // (content): …" lines, if any, come before it).
      const after = stdout.split(/^CONFLICT$/m).pop() ?? '';
      const files = after.split('\n').map((l) => l.trim()).filter(Boolean);
      return { ...base, status: 'conflict', files };
    }
    return { ...base, status: 'error' };
  }
  if (outcome.exitCode === 0) return { ...base, status: 'passed' };
  if (outcome.exitCode === 1) {
    const baselineBroken = (/^BASELINE_BROKEN (.*)$/m.exec(stdout)?.[1] ?? '').split(/\s+/).filter(Boolean);
    if (/^BLOCKED$/m.test(stdout) && baselineBroken.length) return { ...base, status: 'blocked', baselineBroken };
    const broken = (/^BROKEN (.*)$/m.exec(stdout)?.[1] ?? '').split(/\s+/).filter(Boolean);
    const partner = /^PARTNER (\S+)/m.exec(stdout)?.[1] ?? null;
    return broken.length ? { ...base, status: 'broken', broken, partner, ...(baselineBroken.length ? { baselineBroken } : {}) } : { ...base, status: 'error' };
  }
  // The setup failed, or a check ran out of time: not a verdict on the pair.
  return { ...base, status: 'error' };
}

// The claims a gate finding is about: the pushed claim, and the partner when
// one was found.
export function pairWhere(claim: string, pair: PairCheck): string[] {
  return pair.partner && pair.partner !== claim ? [claim, pair.partner] : [claim];
}
