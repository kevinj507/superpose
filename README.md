# Superpose

**A coordination layer for concurrent coding agents, built on Cloudflare Workers and Artifacts.** By Kevin Joo. MIT licensed.

Agents can ship individually plausible changes that break one another’s assumptions. Superpose records what each agent is trying to make true, what it depends on, and what new evidence changes. It checks combined code against the owner’s **constitution**—standing promises about the product—and delivers findings to the work they affect.

[Open the live canvas](https://superpose.kevinj507.workers.dev) · [Runtime experiment](https://superpose.kevinj507.workers.dev/g/runtime-20261015t003452-g3) · [Discovery experiment](https://superpose-judge-check.kevinj507.workers.dev/g/discovery-20261015t030311-g3) · [Qualified recovery demo](https://superpose.kevinj507.workers.dev/g/demo-mv8zz0i6-32e70f)

## Clone, deploy, demonstrate

Requires **Bun, Git, a Cloudflare Workers Paid account with Artifacts and Containers enabled, and a Cloudflare API token for that account**. The scripted demo needs no model subscription, local Docker, BB, or access to the author’s credentials. Checks execute in Cloudflare Containers using a public registry image.

```sh
git clone https://github.com/kevinj507/superpose.git
cd superpose
bun install --frozen-lockfile

# Supply CLOUDFLARE_API_TOKEN through your secret manager or environment.
bun run setup --account-id YOUR_ACCOUNT_ID --name YOUR_UNIQUE_WORKER_NAME
bun run smoke
bun run demo
```

Setup creates the Artifacts namespace, Worker, Workflows, Durable Objects and container application. It generates application credentials and saves them privately in ignored `.superpose/` files. Rerunning the same setup preserves those credentials. The chosen name isolates all installation resources; setup refuses to overwrite an existing Worker it has not deployed.

**Expected result:** the demo prints a live graph URL, detects a changed service, routes the contradiction to worker/retry work while excluding CSV, repairs the service, and lands the unchanged CSV commit through the normal CLI. All 11 final product checks should pass. A qualified run took about 2½ minutes; first container provisioning can take longer. This is a deterministic demonstration with scripted clients, clearly separate from the real-model experiments.

`bun run smoke` is a shorter deployment check: two concurrent clients push separate features through real Artifacts events, Cloudflare checks and shared landing. Receipts and CLI logs are saved under `.superpose/runs/<graph-id>/`. Commands fail with a nonzero exit when a required step fails.

For credentials, troubleshooting and cleanup, see [the setup guide](docs/setup.md). A coding agent can follow [AGENTS.md](AGENTS.md).

## Why a statement layer over Git

A shared repository tells an agent what changed. It does not tell it which other work depended on an assumption that just stopped holding, whether a new finding is verified, or who should receive it. A human pull-request process usually supplies that context. Superpose makes it explicit enough for concurrent coding agents to use.

For example, worker and retry agents may both assume a `budget_limit` response means a job is unaffordable. A service update can reuse that code for temporary capacity exhaustion. A finding about that contract belongs with those two agents; the agent extending CSV output should keep working. Superpose records the relationship, delivers the relevant evidence and preserves the old reasoning and code when a plan changes.

## What replaces the pull-request workflow

A **claim** states what will be true when work is done, its permitted files, its base commit and its assumptions. Taking it creates an Artifacts fork with a short-lived write token. Agents use ordinary Git; the platform reads their actual commits, checks scope and runs tests on the exact SHA.

The constitution is owned by the product owner and lives outside claim scopes. Its executable articles run on each submitted commit combined with the shared line. A failure can identify an interacting landed change. If the same article already fails on the line alone, unrelated work waits without being falsely blamed; it is rechecked after repair. Declared runtime snapshots also trigger checks of the current shared code, so a service change can produce a finding without waiting for an agent to notice it.

A **finding** records something that supports or contradicts existing work. Mechanical evidence can verify a contradiction and route it to affected claims. Those claims must re-plan; their existing code is retained. Other work continues. An uncertain finding remains uncertain: publication grants permission to read it, and does not make it true. A live holder can revise its own assumptions without changing its frozen statement or scope. Prose findings need owner judgment. An alternative line is an explicit choice, not an automatic fork for every suspicion.

The graph retains claims, assumptions, findings, decisions, code identities and check results. The canvas lets a person inspect the evidence and follow what changed. Agents can propose new articles; adopting a new product promise remains an owner action.

## Where Cloudflare is used

| Cloudflare product | Responsibility |
|---|---|
| Workers | API, live canvas and served product |
| Durable Objects with SQLite | Project graph, leases, evidence ledger, coordination and serialized landing |
| Artifacts | Real Git repositories for shared lines and individual claims, scoped tokens and commit/tree access |
| Artifacts events and Workflows | Push-triggered checks, durable verification and landing jobs |
| Containers | Isolated execution of checks and Git integration steps |

Coding agents can run on the owner’s machine. The repositories, coordination state, automatic checks and integration run on Cloudflare. Local containers used in research isolated coding groups; they did not replace the Cloudflare backend.

## What the experiments showed

Both pilots used nine isolated **gpt-6-luna / medium** coding sessions, three at a time, across vanilla Codex, optional shared notes and Superpose. All groups received the same task files and service evidence within each pilot. Controls shared a working tree; Superpose used claim forks and its real Cloudflare backend. The table reports delivered product checks, including failures.

| Real-model pilot | Vanilla | Optional notes | Superpose | Observed behavior |
|---|---:|---:|---:|---|
| [Runtime change during feature work](docs/experiments/2026-10-15-runtime-results.md) | 8/11 | 8/11 | 10/11 | Automatic detection, targeted notification and repair worked. An unrelated CSV extension remained stranded. |
| [Uncertain discovery from an ordinary bug report](docs/experiments/2026-10-15-unverified-results.md) | 11/11 | 11/11 | 5/11 | Two native agents discovered and shared unverified findings. Completion failed before any of their three checked commits landed. |

In the runtime pilot, the platform detected the changed service in about 5.1 seconds and delivered the evidence to active affected holders about 0.84 seconds later. CSV was excluded from the contradiction, but its own checks incorrectly included a whole-product check against its older fork. That delivery failure motivated the separate recovery demonstration.

In the discovery pilot, a normal bug report and accessible diagnostics were enough for both controls. Superpose's worker filed a finding, retry acknowledged the warning and filed another, and neither uncertain finding invalidated work. The platform then refused active assumption revision, and the CLI waited for a nonexistent executable-constitution check. The harness evaluated before outstanding completion commands finished. The preserved **5/11** is the delivered result, even though all three pushed commits passed their own checks.

These are small exploratory pilots, not independent trials or evidence of a general speed/quality advantage. Superpose took longer in both. The notes folders stayed unused. Harness defaults also affected whether agents ran tests; the instruction audit was performed after the discovery run. An ordinary CI-alert comparison remains unrun, so the runtime result does not isolate graph routing from CI.

### Separate mechanism qualification

The default `bun run demo` uses **scripted clients, zero model calls**. Its later 11/11 result qualifies the repaired delivery path; it does not change either pilot's result. It demonstrates:

1. Three concurrent holders with independent Artifacts forks: worker, retry and CSV.
2. A declared service change that causes a real Cloudflare constitution check to fail.
3. A finding routed to worker/retry, with CSV excluded.
4. CSV's own checks passing while its combination waits for the already-broken shared line, without false blame.
5. A worker repair followed by automatic rechecking and normal CLI completion of the **unchanged CSV commit**. Worker and CSV land; the idle retry holder is released.

The post-discovery revision also fixes active assumption revision and completion under a prose-only constitution. Its separate no-model Cloudflare lifecycle qualification passed **20/20 checks**, with all three claims completed and landed. The [discovery results](docs/experiments/2026-10-15-unverified-results.md) preserve both the initial executor-startup failure and the successful qualification; neither is a rerun of the model experiment. Credential-free [receipts and pilot summaries](docs/evidence/) are included in the repository. See the [current demo walkthrough](docs/demo.md) for the scenes and evidence to inspect.

## Current limits

Executable constitution articles can be checked mechanically; prose promises still require owner judgment. Publication, verification and relevance are separate decisions. Existing code and unsuccessful evidence remain in the graph. Landing is serialized, and Git/check containers add latency. Proposed batching, lock-free landing and automatic agent replacement policies are not shipped optimizations. An agent's final message is not proof that its claim landed: inspect the backend state and receipt.

## Bring real coding agents

The scripted demo is the fastest way to verify your installation. To plan your own project, create a scenario folder with `seed/` code and a `plan.json` listing claims, scopes, assumptions and any executable constitution articles; the tiny scenario is a starting example. For an existing Claude Code login, the general runner can start three independent agents against a planned project:

```sh
bun run plan scenarios/tiny --graph my-first-project
bun run agents --graph my-first-project --agents 3 --agent claude --model haiku
```

This optional path uses your model account and consumes model credits. Each holder gets its own Artifacts repository, claim brief, Git hooks and notices. [Runner documentation](runner/README.md) describes custom scenarios and the API/CLI for other agent launchers. The controlled gpt-6-luna research launchers under `runner/` have additional Linux/Docker/Codex requirements and are not the basic setup path.

## Develop

```sh
bun install --frozen-lockfile
bun run test
bun run typecheck
```

Tests use an in-memory Git host for local engine/API checks. Real Artifacts events and cloud containers are qualified by `bun run smoke` and `bun run demo` after deployment. Run `bun run build:play` when changing bundled runner files.

`src/core/` contains the coordination engine; `src/graph.ts` the project Durable Object; `src/push-flow.ts` and `src/land-flow.ts` the Workflows; `src/artifacts-host.ts` the Git backend; `public/` the canvas; and `runner/` the agent clients. The [earlier world demonstration](docs/earlier-world-demo.md) remains as historical evidence.
