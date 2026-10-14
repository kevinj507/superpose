#!/usr/bin/env node
// bun runner/measure-run.mjs --snapshot snapshot.json --observations audit.jsonl
// Optional --notices <claimdir> may repeat; reads only receipt files, no tokens.
import { readFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { measureRun } from './measurements.mjs';
const { values } = parseArgs({ options: { snapshot: { type: 'string' }, observations: { type: 'string' }, notices: { type: 'string', multiple: true, default: [] } } });
if (!values.snapshot) throw new Error('--snapshot is required');
const jsonl = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const observations = values.observations ? jsonl(values.observations) : [];
for (const directory of values.notices) {
  const notices = JSON.parse(readFileSync(join(directory, '.superpose/notices.json'), 'utf8'));
  for (const n of notices) if (n.data?.finding && n.claim && Number.isFinite(n.receivedAt)) observations.push({ stage: 'delivered', finding: n.data.finding, claim: n.claim, at: n.receivedAt });
  const presentations = join(directory, '.superpose/presentations.jsonl');
  if (existsSync(presentations)) observations.push(...jsonl(presentations));
}
console.log(JSON.stringify(measureRun(JSON.parse(readFileSync(values.snapshot, 'utf8')), observations), null, 2));
