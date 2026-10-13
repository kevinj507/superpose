#!/usr/bin/env node
// superpose: the command an agent uses inside its claim's working copy.
//
//   node runner/superpose.mjs status
//   node runner/superpose.mjs assume "<statement>"
//   node runner/superpose.mjs finding --contradicts <assumption id> "<statement>"
//   node runner/superpose.mjs finding --helps <claim id> "<statement>"
//   node runner/superpose.mjs replan [--rests-on <ids>] [--add-scope <patterns>] [--statement "<text>"]
//   node runner/superpose.mjs done
//   node runner/superpose.mjs release ["<why>"]
//   node runner/superpose.mjs notices
//
// It reads .superpose/claim.json, written by the runner when it took the
// claim: the service, the graph, the claim id and the lease token. The git
// hooks the runner installs call `superpose hook ...`.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  Api,
  CMD,
  UsageError,
  mustRead,
  adviceFor,
  advanceSeenSeq,
  changedSince,
  claimContext,
  clearMarker,
  explainError,
  findClaimDir,
  formatDuration,
  git,
  hasMarker,
  indexSnapshot,
  latestSeq,
  localNotice,
  noticesAbout,
  outOfScope,
  peekUnread,
  quoteStatement,
  readClaim,
  readMarker,
  readNotices,
  readSeenSeq,
  recordNotices,
  renderClaimMd,
  atomicWrite,
  setMarker,
  shortSha,
  sleep,
  stateFile,
  takeUnread,
  trailerClaims,
  updateClaim,
  writeGitAuth,
} from './lib.mjs';

// Bring the working copy's notices up to the graph as it is now: events
// addressed to the claim since the last read, and advice filed for it that
// no checker has ruled on. The runner does the same every few seconds; here
// it happens at the moments that matter most, `status` and `done`.
function pullNotices(dir, claim, index) {
  if (!index) return [];
  const fresh = recordNotices(dir, [...noticesAbout(index, claim.claim, { afterSeq: readSeenSeq(dir) }), ...adviceFor(index, claim.claim)]);
  advanceSeenSeq(dir, latestSeq(index));
  return fresh;
}

const USAGE = `Usage: ${CMD} <command> [options]

  status                                   your claim, what it rests on, your last push's verdict, notices
  assume "<statement>"                     declare an assumption your work rests on (or: assume --id <assumption id>)
  finding --contradicts <id> "<statement>" report that an assumption is false, with the evidence
  finding --helps <claim id> "<statement>" offer something useful to another claim
  replan [--rests-on <ids|none>] [--add-scope <patterns> | --scope <patterns>] [--statement "<text>"]
                                           re-plan the claim (after it goes stale, or to widen its scope);
                                           --rests-on defaults to the assumptions that still hold; --add-scope
                                           widens the scope, --scope replaces it; lists are comma-separated
  done [--wait <seconds>]                  push if needed, wait for the platform's verdict and tests on
                                           that exact commit (default up to 90 s), then finish the claim
  release ["<why>"]                        hand the claim back unfinished
  notices                                  print every notice for this claim

Options: --dir <working copy> (default: the nearest folder with .superpose/claim.json), --json`;

const OPTIONS = {
  dir: { type: 'string' },
  json: { type: 'boolean' },
  contradicts: { type: 'string', multiple: true },
  helps: { type: 'string', multiple: true },
  where: { type: 'string', multiple: true },
  'rests-on': { type: 'string', multiple: true },
  scope: { type: 'string', multiple: true },
  'add-scope': { type: 'string', multiple: true },
  statement: { type: 'string' },
  id: { type: 'string' },
  wait: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

class Refused extends Error {}

const list = (values) => (values ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);

function say(text) {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function load(values, cwd) {
  const dir = values.dir ? resolve(values.dir) : findClaimDir(cwd);
  if (!dir) {
    throw new UsageError('No claim here: run this inside a claim working copy (a folder with .superpose/claim.json), or pass --dir.');
  }
  const claim = readClaim(dir);
  return { dir, claim, api: new Api(claim.url, claim.graph) };
}

async function snapshotIndex(api) {
  const res = await api.snapshot();
  return res.ok ? indexSnapshot(res.data) : null;
}

function terminalState(dir) {
  if (hasMarker(dir, 'DONE')) return 'done';
  if (hasMarker(dir, 'RELEASED')) return 'released';
  if (hasMarker(dir, 'LOST')) return 'lost';
  if (hasMarker(dir, 'STALE')) return 'stale';
  return null;
}

function refuseIfOver(dir, claimId) {
  const state = terminalState(dir);
  if (state === 'done') throw new Refused(`Claim ${claimId} is already finished; its write access has ended. Stop here.`);
  if (state === 'released') throw new Refused(`Claim ${claimId} was handed back; this copy no longer holds it. Stop here.`);
  if (state === 'lost') throw new Refused(`The lease on claim ${claimId} is gone: ${(readMarker(dir, 'LOST') ?? '').trim()} Stop here.`);
}

function gitHead(dir) {
  const r = git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], { check: false });
  return r.code === 0 ? r.stdout.trim() : null;
}

function dirtyFiles(dir) {
  return git(dir, ['status', '--porcelain', '--untracked-files=all'])
    .stdout.split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3));
}

function isAncestor(dir, a, b) {
  return git(dir, ['merge-base', '--is-ancestor', a, b], { check: false }).code === 0;
}

// ---- commands ----------------------------------------------------------------------------------

async function status({ dir, claim, api }, values) {
  const index = await snapshotIndex(api);
  const ctx = index ? claimContext(index, claim.claim) : null;
  const node = ctx?.claim;
  const state = terminalState(dir);
  const head = gitHead(dir);
  const row = head && ctx ? ctx.pushes.find((p) => p.sha === head) : null;
  if (values.json) {
    say(JSON.stringify({ claim: claim.claim, state: state ?? node?.status, node, restsOn: ctx?.restsOn, requires: ctx?.requires, head, verdict: row ?? null }, null, 2));
    return;
  }
  const out = [];
  const statusWord = state === 'stale' ? 'STALE (must re-plan)' : state ?? node?.status ?? 'unknown';
  out.push(`Claim ${claim.claim}: ${statusWord}${claim.agent ? `, held by ${claim.agent}` : ''}`);
  out.push(`Make this true: ${node?.statement ?? claim.statement}`);
  out.push(`Scope: ${(node?.scope ?? claim.scope).join(', ')}`);
  if (!state || state === 'stale') {
    const left = (claim.expiresAt ?? 0) - Date.now();
    out.push(
      state === 'stale'
        ? `Lease: not renewed while stale; it runs out in ${formatDuration(left)}. Re-plan before then.`
        : `Lease: renewed automatically by the runner (current term ends in ${formatDuration(left)}).`,
    );
  }
  if (ctx) {
    // The brief lists the other work in this reality, which changes as others work.
    atomicWrite(`${dir}/CLAIM.md`, renderClaimMd(claim, index, dir));
    out.push('CLAIM.md is refreshed: it lists the other work in this reality and what each piece rests on.');
    const fresh = pullNotices(dir, claim, index);
    if (fresh.length) {
      out.push(`New notices (also in .superpose/NOTICES.md):`);
      for (const n of fresh) out.push(`  ${n.title}\n    ${n.text.replace(/\n/g, '\n    ')}`);
    }
    out.push('Rests on:');
    if (ctx.restsOn.length) for (const a of ctx.restsOn) out.push(`  ${a.id}  ${a.status.padEnd(12)} ${a.statement}`);
    else out.push('  (no assumptions declared)');
    if (ctx.requires.length) {
      out.push('Builds on:');
      for (const c of ctx.requires) out.push(`  ${c.id}  ${c.status.padEnd(12)} ${c.statement}`);
    }
  } else {
    out.push('(Superpose could not be reached, so the graph is not shown.)');
  }
  if (head) {
    const pushed = git(dir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { check: false }).stdout.trim();
    let line = `Your last commit: ${shortSha(head)}`;
    if (head === claim.baseSha) line += ' (the starting point; nothing committed yet)';
    else if (row) {
      line += ` — pushed; the platform says: ${describeRow(row)}`;
      if (row.verdict === 'checks-failed' && row.checks?.log) line += `\n  End of the test output:\n${indent(lastLines(row.checks.log, 15))}`;
    } else if (pushed === head) line += ' — pushed; the platform has not recorded it yet (that takes a few seconds)';
    else line += ' — not pushed yet';
    out.push(line);
  }
  const dirty = dirtyFiles(dir);
  if (dirty.length) out.push(`Uncommitted changes: ${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ', ...' : ''}`);
  const notices = readNotices(dir);
  if (notices.length) {
    out.push(`Notices (${notices.length}; latest first; full text in .superpose/NOTICES.md):`);
    for (const n of [...notices].reverse().slice(0, 5)) out.push(`  - ${n.title}`);
  } else {
    out.push('Notices: none.');
  }
  if (state === 'stale') out.push(`Next: re-plan. Read .superpose/NOTICES.md, then \`${CMD} replan --rests-on <ids that still hold>\`.`);
  else if (state === 'done') out.push('This claim is finished. Stop here.');
  else if (state === 'released' || state === 'lost') out.push('This copy no longer holds the claim. Stop here.');
  say(out.join('\n'));
}

async function assume({ dir, claim, api }, values, positionals) {
  refuseIfOver(dir, claim.claim);
  const statement = positionals.join(' ').trim();
  if (!statement && !values.id) throw new UsageError(`Say what the work rests on: ${CMD} assume "<statement>"`);
  const res = await api.declare(claim.lease, claim.claim, values.id ? { assumption: values.id } : { statement });
  if (!res.ok) throw new Refused(`Could not record the assumption. ${explainError(res)}`);
  const a = res.data;
  if (values.json) return say(JSON.stringify(a));
  say(
    `Recorded: claim ${claim.claim} now rests on assumption ${a.id}: “${a.statement}”.\n` +
      'If someone shows it is false and a checker agrees, you will get a STALE notice and be asked to re-plan.',
  );
}

async function finding({ dir, claim, api }, values, positionals) {
  refuseIfOver(dir, claim.claim);
  const statement = positionals.join(' ').trim();
  const contradicts = list(values.contradicts);
  const helps = list(values.helps);
  if (!statement) throw new UsageError('Say what you found, with the evidence, in quotes after the options.');
  if (!!contradicts.length === !!helps.length) {
    throw new UsageError('Give exactly one of --contradicts <assumption id> or --helps <claim id>.');
  }
  const effect = contradicts.length ? 'contradicts' : 'helps';
  const targets = contradicts.length ? contradicts : helps;
  // --where c2,c3: the assumption is false only where these claims are together.
  const where = effect === 'contradicts' ? list(values.where) : [];
  const res = await api.finding(claim.lease, { finder: claim.claim, statement, effect, targets, ...(where.length ? { where } : {}) });
  if (!res.ok) throw new Refused(`Could not file the finding. ${explainError(res)}`);
  const { finding: f, duplicate } = res.data;
  const index = await snapshotIndex(api);
  let impact = null;
  if (effect === 'contradicts') {
    const r = await api.impact(f.id);
    if (r.ok) impact = r.data;
  }
  if (values.json) return say(JSON.stringify({ finding: f, duplicate, impact }));
  const named = targets.map((t) => `${t} ${quoteStatement(index?.nodes.get(t))}`).join('; ');
  const out = [];
  out.push(`Filed finding ${f.id}${duplicate ? ' (the same finding was already filed, so nothing new was added)' : ''}: “${f.statement}”.`);
  if (effect === 'contradicts') {
    out.push(`It says this assumption is false: ${named}.`);
    out.push('It is unverified for now, and nobody is stopped while a human or checker looks at it. Keep working,');
    out.push(`but do not build on ${targets.join(', ')}.`);
    if (impact?.affected?.length) {
      out.push(`If it is verified, these claims go stale and must re-plan: ${impact.affected.join(', ')} (${impact.cost} pushes of work so far).`);
    } else if (impact) {
      out.push('If it is verified, no other claim in progress is affected.');
    }
    const own = index ? claimContext(index, claim.claim).restsOn.filter((a) => targets.includes(a.id)) : [];
    if (own.length) {
      out.push(
        `Your own claim rests on ${own.map((a) => a.id).join(', ')} too. If your work no longer relies on it, say what it relies on instead and re-plan:\n` +
          `  ${CMD} assume "<what your work relies on now>"\n  ${CMD} replan --rests-on <the ids that still hold, plus the new one>`,
      );
    }
  } else {
    out.push(`It is offered to ${named}. If a checker verifies it, their agents are told.`);
  }
  say(out.join('\n'));
}

async function replan({ dir, claim, api }, values) {
  refuseIfOver(dir, claim.claim);
  const wasStale = hasMarker(dir, 'STALE');
  const index = await snapshotIndex(api);
  const ctx = index ? claimContext(index, claim.claim) : null;
  let restsOn;
  let kept = false;
  if (values['rests-on']) {
    restsOn = list(values['rests-on']);
    if (restsOn.length === 1 && restsOn[0] === 'none') restsOn = [];
  } else {
    if (!ctx) throw new Refused('Superpose could not be reached to read your current assumptions; pass --rests-on <ids>.');
    restsOn = ctx.restsOn.filter((a) => a.status === 'holding').map((a) => a.id);
    kept = true;
  }
  // --scope replaces the scope; --add-scope widens the current one.
  const current = ctx?.claim?.scope ?? claim.scope;
  const scope = values.scope
    ? list(values.scope)
    : values['add-scope']
      ? [...new Set([...current, ...list(values['add-scope'])])]
      : undefined;
  const res = await api.replan(claim.lease, claim.claim, { restsOn, scope, statement: values.statement });
  if (!res.ok) {
    if (res.data?.error === 'contradicted') {
      throw new Refused(
        `${explainError(res)}\nDrop it from --rests-on. If your new approach relies on something else, declare that first with ` +
          `\`${CMD} assume "<statement>"\` and pass its id.`,
      );
    }
    throw new Refused(`Could not re-plan. ${explainError(res)}`);
  }
  const { claim: next, git: access } = res.data;
  if (access?.token) writeGitAuth(dir, access.remote, access.token);
  // A claim taken over while stale came with no code: fetch it now.
  let fetched = '';
  if (access?.token && !gitHead(dir)) {
    const f = git(dir, ['fetch', '--quiet', 'origin', 'main'], { check: false, timeoutMs: 120_000 });
    if (f.code === 0) {
      git(dir, ['reset', '--quiet', '--hard', 'refs/remotes/origin/main']);
      fetched = `Fetched the claim's repository: your copy is now at ${shortSha(gitHead(dir))}.\n`;
    } else {
      fetched = `Could not fetch the claim's repository (${f.stderr.trim().split('\n').at(-1)}); try \`git fetch origin main && git reset --hard origin/main\`.\n`;
    }
  }
  const updated = updateClaim(dir, {
    scope: next.scope,
    statement: next.statement,
    version: next.version,
    status: next.status,
    expiresAt: next.lease?.expiresAt ?? claim.expiresAt,
    ...(access ? { gitExpiresAt: access.expiresAt } : {}),
  });
  clearMarker(dir, 'STALE');
  const fresh = await snapshotIndex(api);
  atomicWrite(`${dir}/CLAIM.md`, renderClaimMd(updated, fresh, dir));
  const rests = restsOn.map((a) => `${a} ${quoteStatement(fresh?.nodes.get(a))}`).join('; ') || 'nothing';
  recordNotices(dir, [
    localNotice(`You re-planned claim ${claim.claim} (version ${next.version})`, `It now rests on: ${rests}. Scope: ${next.scope.join(', ')}.`, 'local.replanned'),
  ]);
  if (values.json) return say(JSON.stringify({ claim: { ...next, lease: undefined }, restsOn, head: gitHead(dir) }));
  say(
    `Re-planned claim ${claim.claim}: now version ${next.version}.\n` +
      fetched +
      `It rests on: ${rests}${kept ? ' (the assumptions that still hold; pass --rests-on to choose)' : ''}.\n` +
      `Scope: ${next.scope.join(', ')}.\n` +
      (wasStale
        ? 'Pushes are accepted again and the runner renews the lease as before. CLAIM.md is updated.\n' +
          'Now rework the code to match the new plan, commit, and push.'
        : 'The new plan is in force and CLAIM.md is updated. Carry on with the work.'),
  );
}

// Make sure the work is pushed and in scope, wait for the platform's verdict
// on the exact commit, then finish.
async function done({ dir, claim, api }, values) {
  refuseIfOver(dir, claim.claim);
  if (hasMarker(dir, 'STALE')) {
    throw new Refused(`Claim ${claim.claim} is stale, so it cannot be finished. Re-plan first (see .superpose/NOTICES.md).`);
  }
  // Nothing is finished past what the platform said about it. Anything the
  // agent has not yet been shown is shown now, once; the next `done` goes on.
  pullNotices(dir, claim, await snapshotIndex(api));
  const unread = peekUnread(dir, 'agent').filter(mustRead);
  if (unread.length) {
    takeUnread(dir, 'agent');
    throw new Refused(
      `Superpose told this claim things you have not read yet:\n\n` +
        unread.map((n) => `## ${n.title}\n${n.text}`).join('\n\n') +
        `\n\nRead them. If they change what the work must do, change it, commit and push. If they change nothing, run \`${CMD} done\` again.`,
    );
  }
  const dirty = dirtyFiles(dir);
  if (dirty.length) {
    throw new Refused(
      `Commit or discard these changes first:\n  ${dirty.join('\n  ')}\n` +
        '(`git add <file> && git commit`, or `git checkout -- <file>` / `rm <file>` for files that should not be kept)',
    );
  }
  const head = gitHead(dir);
  if (!head) throw new Refused('Nothing is committed yet. Do the work, commit it, and push before you finish.');

  const files = changedSince(dir, claim.baseSha, head);
  const outside = outOfScope(files, claim.scope);
  if (outside.length) {
    throw new Refused(
      `Your work changes files outside the claim's scope (${claim.scope.join(', ')}):\n  ${outside.join('\n  ')}\n` +
        `Put them back as they were at the start (\`git checkout ${shortSha(claim.baseSha)} -- <file>\`, or \`git rm <file>\` for new files), ` +
        `commit, and run done again. If the claim truly needs them, widen the scope with \`${CMD} replan --add-scope <patterns>\`.`,
    );
  }

  git(dir, ['fetch', '--quiet', 'origin', 'main'], { check: false, timeoutMs: 60_000 });
  const remote = git(dir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { check: false }).stdout.trim();
  if (remote !== head) {
    if (remote && !isAncestor(dir, remote, head)) {
      throw new Refused('origin/main has commits that your branch does not. Run `git pull --rebase origin main`, then run done again.');
    }
    say(`Pushing ${shortSha(head)} to origin main...`);
    const push = git(dir, ['push', 'origin', 'HEAD:refs/heads/main'], { check: false, timeoutMs: 120_000 });
    if (push.code !== 0) throw new Refused(`The push failed:\n${(push.stderr || push.stdout).trim()}`);
  }

  if (files.length) {
    say(`Waiting for the platform's verdict on ${shortSha(head)} (scope, then the tests on that exact commit)...`);
    const row = await verdictFor(api, claim, head, Number(values.wait ?? 90));
    if (row.pending) {
      say('The platform has not recorded the push yet. Finishing anyway: it checks every push it receives, and lands the claim only if its tests pass.');
    } else {
      if (!row.accepted) {
        throw new Refused(
          `The platform did not accept commit ${shortSha(head)} as this claim's head (${row.reason}).` +
            (row.reason === 'stale' ? ' The claim is stale: re-plan first.' : ''),
        );
      }
      if (row.verdict === 'scope-violation') {
        throw new Refused(`The platform found files outside the scope in ${shortSha(head)}: ${(row.outside ?? []).join(', ')}. Fix that first.`);
      }
      if (row.verdict === 'checks-failed' || row.verdict === 'budget-exhausted') {
        throw new Refused(
          `The platform's tests ${row.verdict === 'checks-failed' ? 'failed' : 'ran out of time'} on ${shortSha(head)}` +
            ` (\`${row.checks?.command ?? 'the checks'}\`${row.checks?.exitCode !== undefined ? `, exit code ${row.checks.exitCode}` : ''}). The end of the output:\n` +
            `${indent(lastLines(row.checks?.log ?? '', 40))}\n` +
            'Fix the code, commit, push, and run done again.',
        );
      }
      say(`The platform's verdict on ${shortSha(head)}: ${describeRow(row)}.`);
      if (row.verdict === 'unverified' && row.checks?.status !== 'skipped') {
        say('Finishing anyway: the platform lands the claim only if the tests pass.');
      }
      // The gate on the pair: nothing finishes that breaks the constitution
      // together with the line.
      if (row.verdict === 'checks-passed') {
        const paired = await pairFor(api, claim, head, Number(values.wait ?? 150));
        const pair = paired?.pair;
        if (pair?.status === 'broken') {
          const index = await snapshotIndex(api);
          throw new Refused(
            `Not finished: commit ${shortSha(head)} merged with the line at ${shortSha(pair.lineHead ?? '')} breaks the constitution: ` +
              (pair.broken ?? []).map((a) => `${a} ${quoteStatement(index?.nodes.get(a))}`).join('; ') +
              (pair.partner ? `, together with ${pair.partner} ${quoteStatement(index?.nodes.get(pair.partner))} (already landed)` : '') +
              `.\nThe end of the output:\n${indent(lastLines(pair.log ?? '', 30))}\n` +
              `Your commit alone passes; the pair does not. Read .superpose/NOTICES.md: re-plan (\`${CMD} replan --rests-on <ids>\`), make your statement true without breaking the article, inside your scope, push, and run done again.`,
          );
        }
        if (pair?.status === 'conflict') say(`Note: ${shortSha(head)} no longer merges cleanly with the line (${(pair.files ?? []).join(', ')}); the landing will need a decision.`);
        else if (pair?.status === 'passed') say(`The constitution holds on ${shortSha(head)} merged with the line at ${shortSha(pair.lineHead ?? '')}.`);
        else if (!pair || pair.status === 'running') say('The constitution check on your commit merged with the line has not finished; finishing anyway, the landing runs it again.');
      }
    }
  } else {
    say('Nothing changed relative to the starting point; finishing with no new commits.');
  }

  const res = await api.finish(claim.lease, claim.claim);
  if (!res.ok) {
    if (res.data?.error === 'stale') {
      setMarker(dir, 'STALE', 'The platform refused to finish: the claim is stale.');
      throw new Refused(`Not finished: claim ${claim.claim} has gone stale. Read .superpose/NOTICES.md and re-plan.`);
    }
    throw new Refused(`Could not finish. ${explainError(res)}`);
  }
  setMarker(dir, 'DONE', `Finished at ${new Date().toISOString()} with ${head}.`);
  if (values.json) return say(JSON.stringify({ finished: claim.claim, head }));
  say(`Finished claim ${claim.claim} at ${shortSha(head)}. Its write access has ended. You are done: stop here.`);
}

// The ledger row once the pair check on a commit has settled (passed, broken,
// conflict, error or skipped), or as it stands when the wait runs out.
async function pairFor(api, claim, sha, waitSeconds) {
  const started = Date.now();
  let row = null;
  while (Date.now() - started < waitSeconds * 1000) {
    const index = await snapshotIndex(api);
    row = index?.pushes.find((p) => p.claim === claim.claim && p.sha === sha) ?? row;
    if (row?.pair && row.pair.status !== 'running') return row;
    await sleep(5000);
  }
  return row;
}

// The ledger row for one commit, once the platform is through with it: the
// scope check from the push event (or, if that is slow, from asking it to
// read the commit), then the tests in a fresh container on that commit.
async function verdictFor(api, claim, sha, waitSeconds) {
  const started = Date.now();
  let row = null;
  let nudged = false;
  let told = started;
  while (Date.now() - started < waitSeconds * 1000) {
    const index = await snapshotIndex(api);
    row = index?.pushes.find((p) => p.claim === claim.claim && p.sha === sha) ?? row;
    if (row && settled(row)) return row;
    if (!row && !nudged && Date.now() - started > 15_000) {
      nudged = true;
      const r = await api.notePush(claim.lease, claim.claim, sha);
      if (r.ok) row = { ...r.data, sha };
    }
    if (Date.now() - told > 20_000) {
      told = Date.now();
      say(`  ...${row ? describeRow(row) : 'not recorded yet'} (${formatDuration(Date.now() - started)})`);
    }
    await sleep(3000);
  }
  return row ?? { pending: true };
}

function settled(row) {
  if (!row.accepted || row.verdict === 'scope-violation') return true;
  return row.verdict !== 'unverified' || row.checks?.status === 'skipped';
}

// One ledger row in plain words.
function describeRow(row) {
  if (!row.accepted) return `not accepted as the claim's head (${row.reason})`;
  if (row.verdict === 'scope-violation') return `outside the scope: ${(row.outside ?? []).join(', ')}`;
  if (row.verdict === 'checks-passed') return 'in scope, tests passed';
  if (row.verdict === 'checks-failed') return `in scope, tests FAILED${row.checks?.exitCode !== undefined ? ` (exit code ${row.checks.exitCode})` : ''}`;
  if (row.verdict === 'verifier-failed') return 'in scope; the tests could not be run (a platform problem, not your code)';
  if (row.verdict === 'budget-exhausted') return 'in scope; the tests ran out of time';
  if (row.checks?.status === 'skipped') return 'in scope; the project declares no tests';
  if (row.checks?.status === 'running') return 'in scope; tests running';
  return 'in scope; tests not started yet';
}

const indent = (text) => text.split('\n').map((l) => `    ${l}`).join('\n');
const lastLines = (text, n) => text.trim().split('\n').slice(-n).join('\n');

async function release({ dir, claim, api }, values, positionals) {
  if (hasMarker(dir, 'RELEASED')) return say(`Claim ${claim.claim} was already handed back.`);
  refuseIfOver(dir, claim.claim);
  const why = positionals.join(' ').trim() || 'no reason given';
  // Committed work goes up first, so whoever takes the claim next starts from it.
  const head = gitHead(dir);
  const remote = git(dir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { check: false }).stdout.trim();
  if (head && head !== remote && !hasMarker(dir, 'STALE')) {
    git(dir, ['push', 'origin', 'HEAD:refs/heads/main'], { check: false, timeoutMs: 120_000 });
  }
  const res = await api.release(claim.lease, claim.claim);
  if (!res.ok) throw new Refused(`Could not hand the claim back. ${explainError(res)}`);
  setMarker(dir, 'RELEASED', `Handed back at ${new Date().toISOString()}: ${why}`);
  if (values.json) return say(JSON.stringify({ released: claim.claim }));
  say(`Handed back claim ${claim.claim} (${why}). The work you pushed stays in its repository for the next agent. Stop here.`);
}

function notices({ dir }) {
  try {
    say(readFileSync(`${dir}/.superpose/NOTICES.md`, 'utf8'));
  } catch {
    say('No notices yet.');
  }
}

// ---- hooks ---------------------------------------------------------------------------------------

const ZERO = /^0{40}$/;

// git pre-push: refuse a push that cannot count (stale, finished, outside the
// scope), and show what Superpose said since the last push.
function prePush({ dir, claim }) {
  const input = readFileSync(0, 'utf8');
  // The hook's parent is the `git push` itself. While it runs, the runner
  // holds off renewing the lease: a renewal replaces the git token, and the
  // old one stops working at once, which would fail this push halfway.
  atomicWrite(stateFile(dir, 'pushing.json'), JSON.stringify({ pid: process.ppid, at: Date.now() }) + '\n');
  const problems = [];
  const warnings = [];
  const unread = takeUnread(dir, 'push');
  if (unread.length) {
    say('Superpose: new notices for this claim since your last push (also in .superpose/NOTICES.md):');
    for (const n of unread) say(`\n## ${n.title}\n${n.text}`);
    say('');
  }
  const state = terminalState(dir);
  if (state === 'done') problems.push(`Claim ${claim.claim} is finished; its write access has ended.`);
  if (state === 'released') problems.push(`Claim ${claim.claim} was handed back; this copy no longer holds it.`);
  if (state === 'lost') problems.push(`The lease on claim ${claim.claim} is gone. Stop working on it.`);
  if (state === 'stale') {
    problems.push(
      `Claim ${claim.claim} is STALE: an assumption it rests on was shown to be false, so pushes are refused until you re-plan.\n` +
        `  Read .superpose/NOTICES.md, then: ${CMD} replan --rests-on <assumption ids that still hold>`,
    );
  }
  for (const line of input.split('\n').filter(Boolean)) {
    const [, localSha, remoteRef, remoteSha] = line.split(' ');
    if (ZERO.test(localSha)) {
      if (remoteRef === 'refs/heads/main') problems.push('Deleting main is not allowed.');
      continue;
    }
    if (remoteRef !== 'refs/heads/main') {
      warnings.push(`Only main counts: a push to ${remoteRef} is recorded but never becomes the claim's head.`);
    }
    const files = changedSince(dir, claim.baseSha, localSha);
    const outside = outOfScope(files, claim.scope);
    if (outside.length) {
      problems.push(
        `These files are outside the claim's scope (${claim.scope.join(', ')}):\n    ${outside.join('\n    ')}\n` +
          `  Put them back as they were at the start (git checkout ${shortSha(claim.baseSha)} -- <file>, or git rm for new files) and commit,\n` +
          `  or, if the claim truly needs them, widen the scope: ${CMD} replan --add-scope <patterns>`,
      );
    }
    const range = remoteSha && !ZERO.test(remoteSha) ? `${remoteSha}..${localSha}` : claim.baseSha ? `${claim.baseSha}..${localSha}` : localSha;
    const log = git(dir, ['log', '--format=%H%x1f%B%x1e', range], { check: false }).stdout;
    const unattributed = log
      .split('\x1e')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split('\x1f'))
      .filter(([, body]) => !trailerClaims(body ?? '').includes(claim.claim))
      .map(([sha]) => shortSha(sha));
    if (unattributed.length) {
      warnings.push(`Commits without the trailer "Superpose-Claim: ${claim.claim}" will be flagged: ${unattributed.join(', ')}.`);
    }
  }
  for (const w of warnings) say(`Superpose warning: ${w}`);
  if (problems.length) {
    process.stderr.write(`\nPush refused by Superpose (claim ${claim.claim}):\n- ${problems.join('\n- ')}\n\n`);
    process.exitCode = 1;
  }
}

// git commit-msg: name the claim in a trailer if the message does not.
function commitMsg({ dir, claim }, positionals) {
  const file = positionals[0];
  if (!file) return;
  const message = readFileSync(file, 'utf8');
  if (trailerClaims(message).includes(claim.claim)) return;
  git(dir, ['interpret-trailers', '--in-place', '--trailer', `Superpose-Claim: ${claim.claim}`, file]);
}

// Claude Code PostToolUse: put new notices into the agent's context at once.
function claudeNotices({ dir }) {
  const unread = takeUnread(dir, 'agent');
  if (!unread.length) return;
  const text =
    `Superpose notices for your claim (new since your last step; also in .superpose/NOTICES.md):\n\n` +
    unread.map((n) => `## ${n.title}\n${n.text}`).join('\n\n');
  say(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));
}

// Claude Code Stop: an agent that has neither finished nor handed back its
// claim is asked to do one or the other, once.
function claudeStop({ dir, claim }, input) {
  if (input?.stop_hook_active) return;
  const state = terminalState(dir);
  if (state && state !== 'stale') return;
  const reason =
    state === 'stale'
      ? `Claim ${claim.claim} is STALE and has not been re-planned. Read .superpose/NOTICES.md, re-plan with ` +
        `\`${CMD} replan --rests-on <ids that still hold>\`, rework, push, and run \`${CMD} done\`. ` +
        `If you cannot continue, run \`${CMD} release "<why>"\`.`
      : `You have not finished claim ${claim.claim}. If its statement is true, the tests pass and your work is committed and pushed, ` +
        `run \`${CMD} done\`. If you cannot finish it, run \`${CMD} release "<why>"\` so another agent can take it over. Then stop.`;
  say(JSON.stringify({ decision: 'block', reason }));
}

async function hook(values, positionals) {
  const [name, ...rest] = positionals;
  if (name === 'pre-push') return prePush(load(values), rest);
  if (name === 'commit-msg') return commitMsg(load(values), rest);
  // Claude Code hooks must never break the agent's session: any failure is silent.
  let input = null;
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || 'null');
  } catch {
    input = null;
  }
  try {
    const ctx = load(values, input?.cwd);
    if (name === 'claude-notices') return claudeNotices(ctx);
    if (name === 'claude-stop') return claudeStop(ctx, input);
  } catch {
    // ignored
  }
}

// ---- main ------------------------------------------------------------------------------------------

const COMMANDS = { status, assume, finding, replan, done, release, notices };

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    say(USAGE);
    return command || values.help ? 0 : 2;
  }
  try {
    if (command === 'hook') {
      await hook(values, rest);
      return process.exitCode ?? 0;
    }
    const fn = COMMANDS[command];
    if (!fn) throw new UsageError(`Unknown command "${command}".`);
    await fn(load(values), values, rest);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${USAGE}\n`);
      return 2;
    }
    if (err instanceof Refused) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    process.stderr.write(`superpose ${command} failed: ${err?.stack ?? err}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
