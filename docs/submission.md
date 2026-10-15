# Submission text

Copy-ready fields for the manual entry. Source URL: https://github.com/kevinj507/superpose. The source must be accessible to judges when submitted; visibility requires the owner’s approval. Kevin supplies the video and personal form details.

## Project vision

Superpose is a coordination layer for many coding agents working on one product. Git records code changes; Superpose also records what each agent promises, which assumptions its work depends on, and what new evidence changes.

Each agent takes a scoped claim backed by an Artifacts fork and uses ordinary Git. The owner's constitution records standing product promises. Executable articles check a submission combined with the shared line, separately from the claim's own tests. Findings reach affected work. A verified contradiction can require replanning while preserving existing code; a shared unverified finding supplies context without becoming truth or stopping unrelated work.

The canvas exposes claims, dependencies, exact commits, check results and the history behind decisions. An unrelated claim is not blamed for an article already failing on the shared line; it can complete after repair.

The repository includes a reproducible scripted recovery demo with zero model calls and separate real-agent pilots. In a runtime-change pilot Superpose detected, routed and repaired a regression, delivering 10/11 checks against 8/11 in each control. In an uncertain-discovery pilot it shared two agent-authored findings but delivered 5/11 while controls passed 11/11, exposing completion bugs. Those original results remain visible. Subsequent fixes passed separate real-Cloudflare qualification. These are exploratory observations, not a claim of general superiority.

## Cloudflare usage

Workers serves the API, live canvas and selected product line. Each project uses a SQLite Durable Object for its coordination graph, leases, evidence ledger and serialized landing state.

Artifacts is the Git backend: shared lines and individual claims are real repositories with scoped access. Agents clone, commit and push using Git. Artifacts push events start Workflows that read actual commit identities, check declared scope and run tests. Separate Workflows coordinate landing and the scripted playground. Cloudflare Containers execute checks and Git integration with a public registry image.

The constitution is checked on combined code, with separate evidence for a pre-existing shared-line failure. Declared service snapshots can also trigger checks of current shared code and produce findings bound to exact code and input versions. The graph routes those findings to relevant work and retains unsuccessful evidence.

Setup creates an installation in the judge's own account and generates private application credentials. The smoke test and recovery demo use actual Workers, Artifacts, Workflows and Containers with concurrent scripted holders. They need no model login or local Docker. Optional real coding agents run as clients; the coordination and Git backend remain on Cloudflare.

## Run instructions

```text
Prerequisites: Bun, Git, a Cloudflare Workers Paid account with Artifacts and Containers access and a workers.dev subdomain, plus a Cloudflare API token scoped to that account. See README.md and docs/setup.md for permissions and troubleshooting.

git clone https://github.com/kevinj507/superpose.git
cd superpose
bun install --frozen-lockfile

Supply CLOUDFLARE_API_TOKEN securely through your environment or secret manager, then run:

bun run setup --account-id YOUR_ACCOUNT_ID --name YOUR_UNIQUE_WORKER_NAME
bun run smoke
bun run demo

Choose a fresh lowercase deployment name, 3–40 characters, starting with a letter. Setup generates application credentials and saves them privately under ignored .superpose/. It creates matching Worker, Artifacts, Workflow and container resources. Keep this local state for access and redeployment.

Smoke checks two concurrent submissions through actual Artifacts events, cloud tests and landing. Demo creates three scoped holders, changes a public service snapshot, observes automatic constitution failure and targeted notification, repairs the worker, and completes the unchanged CSV commit through its normal waiting CLI. Worker and CSV land; the idle retry holder is released. Expect all 11 product checks to pass, a canvas URL, and .superpose/runs/<graph-id>/result.json. Qualified runs took about 2–3 minutes; first container provisioning can take longer. Failure or timeout is not a pass.

These are scripted clients with zero model calls, not a model benchmark. README.md links the separate real-agent pilots and their original failures, plus credential-free receipts. AGENTS.md gives the same quickstart for a judge's agent.

Optional, with an existing Claude Code login and model credits:
bun run plan scenarios/tiny --graph my-first-project
bun run agents --graph my-first-project --agents 3 --agent claude --model haiku

To remove one locally recorded demo and its repositories after inspection:
bun run cleanup <graph-id>

Cleanup keeps the server and local receipt. Local development checks:
bun run test
bun run typecheck

Kevin provides the video and submits the entry manually.
```
