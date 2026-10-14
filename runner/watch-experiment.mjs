#!/usr/bin/env node
// bun runner/watch-experiment.mjs --state run-state.json --out alerts.jsonl
// Input is sanitized launcher telemetry, not raw commands or credentials.
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { observationAlerts, alertText } from './experiment-observer.mjs';
const { values } = parseArgs({ options: { state: { type: 'string' }, out: { type: 'string' }, once: { type: 'boolean' } } });
if (!values.state || !values.out) throw new Error('--state and --out are required');
const seen = new Map();
let stopped = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopped = true; });
do {
  try {
    const state = JSON.parse(readFileSync(values.state, 'utf8'));
    const alerts = observationAlerts(state);
    const active = new Set();
    for (const alert of alerts) {
      active.add(alert.task);
      const signature = `${alert.kind}:${alert.reason}`;
      if (seen.get(alert.task) === signature) continue;
      seen.set(alert.task, signature);
      appendFileSync(values.out, JSON.stringify(alert) + '\n');
      console.log(alertText(alert));
    }
    for (const id of seen.keys()) if (!active.has(id)) {
      seen.delete(id);
      appendFileSync(values.out, JSON.stringify({ task: id, kind: 'resumed', at: Date.now() }) + '\n');
      console.log(`${id}: progress resumed.`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (values.once || stopped) break;
  await new Promise((done) => setTimeout(done, 10_000));
} while (!stopped);
