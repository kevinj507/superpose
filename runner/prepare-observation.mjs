#!/usr/bin/env node
// bun runner/prepare-observation.mjs --out /tmp/shop-observation --arm matched-git
// Creates an agent-visible copy. Private evaluators and references are not copied.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { armOrder, discoveryPlan, OBSERVATION_SPEC, productBrief } from './experiment-spec.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { out: { type: 'string' }, arm: { type: 'string' } } });
if (!values.out || !OBSERVATION_SPEC.arms.includes(values.arm)) throw new Error('--out and --arm ordinary-git|matched-git|superpose are required');
const out = resolve(values.out);
if (existsSync(out) && readdirSync(out).length) throw new Error('The output directory must be new or empty');
const seed = join(out, 'seed');
mkdirSync(out, { recursive: true });
cpSync(join(root, 'scenarios/shop/seed'), seed, { recursive: true });
rmSync(join(seed, 'constitution/see-is-pay.test.js'));
const plan = discoveryPlan(JSON.parse(readFileSync(join(root, 'scenarios/shop/plan.json'), 'utf8')));
writeFileSync(join(out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
writeFileSync(join(seed, 'PROMISES.md'), productBrief());
let readme = readFileSync(join(seed, 'README.md'), 'utf8');
readme = readme.replace('each article a test: what you see is what you pay (a buyer is charged the price the page showed just before the purchase), an unknown product', 'each existing article a test: an unknown product');
readme = readme.replace('These files belong to the owner and no task changes them.', 'These files belong to the experiment operator and no task changes them. PROMISES.md defines the product’s complete requested behavior; some promises do not yet have an executable article.');
readme += '\n' + productBrief() + '\n## Experiment requests\n\nThe operator answers clarification and proposed-rule requests using the published promises. Kevin observes. Put each request on a separate line in .experiment/requests.jsonl as JSON with task, kind (clarify or propose), promise, statement, and optional checkFile. You may make at most two requests per task. Replies arrive in .experiment/replies.jsonl. Continue independent work while waiting. Report a blocker with kind: "blocked", the last attempted action and what it needs. The operator provides no solution or debugging hints.\n';
if (values.arm !== 'ordinary-git') readme += '\nBefore writing code, name the assumptions your approach needs. Check how your changes could break another task and how another task could break yours. Report an interaction with the involved tasks and reproducible evidence. Propose a check for a product promise that has no executable article.\n';
writeFileSync(join(seed, 'README.md'), readme);
writeFileSync(join(seed, '.gitignore'), '.experiment/\n');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const seedFiles = [];
function recordFiles(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) recordFiles(path, relative);
    else seedFiles.push({ path: relative, sha256: hash(path) });
  }
}
recordFiles(seed);
writeFileSync(join(out, 'operator-manifest.json'), JSON.stringify({
  version: OBSERVATION_SPEC.version, arm: values.arm, runOrder: armOrder(), limits: OBSERVATION_SPEC.limits,
  planSha256: hash(join(out, 'plan.json')), seedFiles,
  specSha256: hash(join(root, 'runner/experiment-spec.mjs')),
  ownerPolicySha256: hash(join(root, 'runner/experiment-owner-policy.mjs')),
  evaluatorSha256: hash(join(root, 'scenarios/shop/hidden/experiment-contract.mjs')),
  launcher: null, model: OBSERVATION_SPEC.agents.model,
  agentPolicy: OBSERVATION_SPEC.agents, isolationPolicy: OBSERVATION_SPEC.isolation,
  isolationVerified: false, runAuthorized: false,
}, null, 2) + '\n');
console.log(JSON.stringify({ prepared: out, arm: values.arm, order: armOrder(), privateFilesCopied: false, payShownCheckSupplied: false }));
