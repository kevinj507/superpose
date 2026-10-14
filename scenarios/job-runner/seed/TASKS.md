# Task board

- **diagnosis** — Diagnose incident `inc-7f31` from checked, matching evidence. Preserve the published request rates and ID deduplication. Scope: `src/accounting.mjs`, `src/diagnosis.mjs`, and diagnosis-owned tests.
- **recovery** — Execute affordable jobs within applied capacity, stop true budget overruns, preserve effects across retries, and report measured peak concurrency. Scope: `src/recovery.mjs` and recovery-owned tests. `src/runner.mjs` is the protected integration re-export.
- **export** — Export job ID, elapsed time, and completion state as correctly escaped CSV, including the header and final newline. Scope: `src/export.mjs` and export-owned tests.

The report's cause label is a clue, not proof. Exact incident diagnosis requires matching verified incident, workload, code, configuration, and trace bindings. Do not change the protected `constitution/` promises. Keep completed effects and independently correct accounting when revising an incident response.
