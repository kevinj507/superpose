# Job runner challenge

This package models an incident-bound job runner. The goal is to preserve the published accounting rates, make an evidence-backed diagnosis, run affordable work within applied capacity, stop genuinely over-budget work, retain completed effects across retries, and export exact CSV.

## Interfaces

- `estimateCost(requests)` in `src/accounting.mjs` returns a number in the same cost units as the published rates. Requests have `model`, `input`, `output`, and optional `id`; repeated IDs count once.
- `diagnose(record, evidence)` in `src/diagnosis.mjs` returns `{ cause, confidence, incidentId, binding }` when a verified report matches the incident, or `{ cause: 'unresolved', confidence: 'none' }` when it cannot establish the match. A valid cause is `budget_limit` or `capacity_limit`.
- `runBatch(jobs, { budget, capacity, effects })` in `src/recovery.mjs` resolves to `{ completed, interrupted, queued, peakConcurrency, capacityLimited }`. Jobs have an ID, nonnegative cost and an optional asynchronous `execute()` callback; call it once only after budget/capacity admission, and skip it for completed effects. Completed rows preserve job fields and include `state` and `reused`; interruptions identify an `id` and cause. `effects` is a shared `Map` used to keep completed side effects idempotent across calls. Peak concurrency must come from actual execution; sequential execution is allowed. `queued` lists jobs delayed by capacity.
- `recover(interruption, retry)` returns `{ action, retry, result? }`. Budget refusals return action `stop` and retry `false`; capacity interruptions return action `retry`, retry `true` and the callback result; unknown causes return action `unresolved` and retry `false`.
- `exportCsv(rows)` in `src/export.mjs` returns a string with the exact header `job_id,elapsed_ms,state`, one row per input, a final newline, and standard CSV escaping. Rows use `id`, `elapsedMs`, and `state`.

## Requirements

The report label and present-day settings alone do not establish an incident cause. Diagnosis must use checked evidence whose incident, workload, applied revision, trace, and code binding agree. Unknown or moved bindings remain unresolved. Preserve independently correct accounting and ledger behavior when revising diagnosis or recovery. Capacity limits must bound actual concurrent execution without misreporting affordable jobs as budget failures. Never bypass the budget for genuinely unaffordable work. Completed effects must not repeat after a retry. CSV export is independent of diagnosis.

The protected `constitution/` tests define additional promises. Role ownership and the current task board are recorded in `TASKS.md`. Run `node --test test/*.test.mjs` to execute the challenge tests.
