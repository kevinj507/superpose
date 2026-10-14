import { EXIT_FETCH_FAILED, EXIT_MERGE_CONFLICT, tail, type CheckConfig, type ExecJob, type ExecOutcome } from './checks';
import type { Engine } from './engine';
import type { RepoHost } from './repos';
import type { FindingEvidence } from './types';

export type FindingCheckContext = ReturnType<Engine['beginFindingCheck']>;

// Only the owner-controlled article commands run. Proposed checks never
// enter this job. Setup uses read credentials, and code runs in a separate
// process without those credentials, just like the existing pair gate.
export function findingScripts(context: FindingCheckContext): { merge: string; check: string } {
  const merge = `
set -u
rm -rf /work /work-baseline
mkdir -p /work && cd /work
git init -q -b main
git config core.hooksPath /dev/null
git config user.name Superpose
git config user.email gate@superpose.invalid
git -c http.extraHeader="Authorization: Bearer $LINE_TOKEN" fetch -q "$LINE_REMOTE" "$LINE_HEAD" || exit ${EXIT_FETCH_FAILED}
git checkout -q -B main FETCH_HEAD || exit ${EXIT_FETCH_FAILED}
git worktree add -q /work-baseline HEAD || exit ${EXIT_FETCH_FAILED}
${context.heads.map((_, i) => `git -c http.extraHeader="Authorization: Bearer $TOKEN_${i}" fetch -q "$REMOTE_${i}" "$SHA_${i}" || exit ${EXIT_FETCH_FAILED}
git merge -q --no-ff -m "finding combination" FETCH_HEAD > /tmp/merge.log 2>&1 || { cat /tmp/merge.log; exit ${EXIT_MERGE_CONFLICT}; }`).join('\n')}
`;
  const check = `
set -u
run() {
  timeout -k 5 "$TIMEOUT" sh -c "$1" > /tmp/check.log 2>&1
  code=$?
  tail -c 4000 /tmp/check.log
  return $code
}
for work in /work-baseline /work; do
  cd "$work" || exit ${EXIT_FETCH_FAILED}
  if [ -n "\${SETUP:-}" ]; then
    run "$SETUP" || { echo "FINDING inconclusive"; exit 0; }
  fi
  passed=0
  failed=0
${context.articles.map((_, i) => `  run "$ARTICLE_${i}"
  code=$?
  if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then echo "FINDING inconclusive"; exit 0; fi
  if [ "$code" -eq 0 ]; then passed=$((passed + 1)); else failed=$((failed + 1)); fi`).join('\n')}
  if [ "$work" = /work-baseline ] && [ "$failed" -gt 0 ]; then
    echo "The article already fails on the baseline; no named partner is established."
    echo "FINDING inconclusive"
    exit 0
  fi
done
if [ "$failed" -eq 0 ]; then echo "FINDING refuted";
elif [ "$passed" -eq 0 ]; then echo "FINDING confirmed";
else echo "Only some of the alleged articles failed."; echo "FINDING inconclusive"; fi
`;
  return { merge, check };
}

export function findingEvidence(context: FindingCheckContext, outcome: ExecOutcome): FindingEvidence {
  const statuses = [...outcome.stdout.matchAll(/^FINDING (confirmed|refuted|inconclusive)$/gm)];
  const status = !outcome.error && outcome.exitCode === 0 ? statuses.at(-1)?.[1] : undefined;
  return {
    ...context.evidence,
    status: status === 'confirmed' || status === 'refuted' ? status : 'inconclusive',
    log: tail([outcome.stdout, outcome.stderr, outcome.error].filter(Boolean).join('\n')),
  };
}

export async function checkFinding(
  host: RepoHost,
  exec: (job: ExecJob) => Promise<ExecOutcome>,
  context: FindingCheckContext,
  config: CheckConfig,
): Promise<FindingEvidence> {
  const tokens: { repo: string; id: string }[] = [];
  try {
    const line = await host.mintToken(context.line.name, 'read', 900);
    tokens.push({ repo: context.line.name, id: line.id });
    const credentials: Record<string, string> = { LINE_TOKEN: line.secret, LINE_REMOTE: context.line.remote, LINE_HEAD: context.evidence.lineHead };
    for (const [i, head] of context.heads.entries()) {
      const token = await host.mintToken(head.repo.name, 'read', 900);
      tokens.push({ repo: head.repo.name, id: token.id });
      credentials[`TOKEN_${i}`] = token.secret;
      credentials[`REMOTE_${i}`] = head.repo.remote;
      credentials[`SHA_${i}`] = head.sha;
    }
    const scripts = findingScripts(context);
    const outcome = await exec({
      steps: [
        { script: scripts.merge, env: credentials },
        { script: scripts.check, env: {
          SETUP: config.setup ?? '', TIMEOUT: String(config.timeoutSeconds),
          ...Object.fromEntries(context.articles.map((article, i) => [`ARTICLE_${i}`, article.check])),
        } },
      ],
      timeoutSeconds: config.timeoutSeconds * (context.articles.length + 1) * 2 + 60,
    });
    return findingEvidence(context, outcome);
  } catch {
    return { ...context.evidence, status: 'inconclusive', log: 'The checker could not prepare or execute the recorded combination.' };
  } finally {
    await Promise.allSettled(tokens.map((token) => host.revokeToken(token.repo, token.id)));
  }
}
