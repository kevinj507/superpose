#!/usr/bin/env node
// Runs the shop scenario's hidden test against a checkout of the shop:
//
//   node scenarios/shop/hidden/check.mjs <repo-dir>
//
// The checkout is copied to a temporary folder first (without .git), so it is
// never changed. Prints one JSON line, {"hidden":"pass"|"fail"|"error","detail":"..."},
// and exits 0, 1 or 2:
//
//   pass   every purchase charged the price its page showed just before it
//   fail   a purchase charged something else: the test's assertion failed
//   error  the test could not run: no such folder, no handle() in src/app.js,
//          a product page without a price, a refused purchase, a crash, a timeout
//
// The test is what-you-see-is-what-you-pay.test.mjs, next to this file.

import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_FILE = 'what-you-see-is-what-you-pay.test.mjs';
const TEST_NAME = 'what you see is what you pay'; // the one test in TEST_FILE, which has its own 30 s timeout
const TIMEOUT_MS = 60_000; // the whole run, in case even that does not end it
const EXIT = { pass: 0, fail: 1, error: 2 };

function verdict(hidden, detail) {
  process.stdout.write(`${JSON.stringify({ hidden, detail })}\n`);
  return EXIT[hidden];
}

function main(args) {
  if (args.length !== 1 || args[0].startsWith('-')) {
    process.stderr.write('Usage: node scenarios/shop/hidden/check.mjs <repo-dir>\n');
    return verdict('error', 'usage: check.mjs <repo-dir>');
  }
  const repo = resolve(args[0]);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) return verdict('error', `${repo} is not a directory`);

  const tmp = mkdtempSync(join(tmpdir(), 'shop-hidden-'));
  try {
    const copy = join(tmp, 'repo');
    cpSync(repo, copy, { recursive: true, filter: (src) => basename(src) !== '.git' });
    // A folder of its own at the top of the copy, so ../src/app.js is the copy's app.
    const testDir = join(copy, '.shop-hidden-test');
    mkdirSync(testDir, { recursive: true });
    copyFileSync(join(HERE, TEST_FILE), join(testDir, TEST_FILE));

    // The test file runs in one fresh process (the app's state starts empty),
    // and the reporter writes its records to a file of their own, apart from
    // anything the app prints.
    const report = join(tmp, 'report.jsonl');
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // started from inside another test run, still run a test run of our own
    const run = spawnSync(
      process.execPath,
      [
        '--test-force-exit', // a timer the app leaves running must not keep the run open
        `--test-reporter=${pathToFileURL(join(HERE, 'reporter.mjs')).href}`,
        `--test-reporter-destination=${report}`,
        join(testDir, TEST_FILE),
      ],
      { cwd: copy, env, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    );
    return judge(run, existsSync(report) ? readFileSync(report, 'utf8') : '');
  } catch (err) {
    return verdict('error', `the hidden test could not be set up: ${err?.message ?? err}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function judge(run, report) {
  if (run.error?.code === 'ETIMEDOUT') return verdict('error', `the hidden test did not finish within ${TIMEOUT_MS / 1000} s`);
  if (run.error) return verdict('error', `the hidden test could not be started: ${run.error.message}`);
  const records = report
    .split('\n')
    .flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l)] : [];
      } catch {
        return [];
      }
    });
  const at = records.findIndex((r) => (r.type === 'pass' || r.type === 'fail') && r.name === TEST_NAME);
  if (at < 0) {
    const failure = records.find((r) => r.type === 'fail');
    const why = failure ? `: ${describe(failure)}` : ` (it ended with ${run.status === null ? `signal ${run.signal}` : `exit code ${run.status}`})`;
    return verdict('error', `the hidden test did not run${why}${stderrTail(run.stderr)}`);
  }
  const result = records[at];
  if (result.type === 'pass') {
    const trail = records.slice(at + 1).find((r) => r.type === 'diagnostic' && r.message.startsWith('trail: '));
    return verdict('pass', `every purchase charged the price its page showed just before it${trail ? ` (${trail.message.slice(7)})` : ''}`);
  }
  if (result.error?.code === 'ERR_ASSERTION') return verdict('fail', `what you see is not what you pay: ${result.error.message.trim()}`);
  if (result.error?.name === 'CannotRun') return verdict('error', `cannot run: ${result.error.message}`);
  return verdict('error', `the hidden test stopped: ${describe(result)}`);
}

function describe(failure) {
  const message = String(failure.error?.message ?? '').trim().split('\n')[0];
  if (failure.failureType === 'testTimeoutFailure') return `the shop did not answer in time${message ? ` (${message})` : ''}`;
  return [failure.error?.name, message].filter(Boolean).join(': ') || failure.failureType || 'failed';
}

function stderrTail(stderr) {
  const text = String(stderr ?? '').trim();
  return text ? `; stderr: ${text.slice(-400)}` : '';
}

process.exitCode = main(process.argv.slice(2));
