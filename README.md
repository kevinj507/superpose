# Superpose

**Coordination for many concurrent coding agents, built on Cloudflare Workers and Artifacts.** An entry for Cloudflare's "Build the next Git platform" competition (October 2026), by Kevin Joo.

Git converges everything into one tree because its collaborators were human. Superpose keeps a graph. The unit of work is a **claim**: a frozen statement of what will be true when the work is done, with a declared scope, a base commit, and the assumptions it rests on. Commits are evidence for a claim, not the unit of meaning. Trees, boards and the served build are views over the graph.

**Live:** https://superpose.kevinj507.workers.dev. Press **Watch agents build one now**: it starts a run on Cloudflare (or joins the one already going) and opens its live graph. No account, token or machine needed.
- **What runs:** a container plans a procedural world on a new graph, and scripted agents build it two ways.
- **The finding:** one agent reports that a shared random stream couples the modules.
- **The decisions:** a director plays the human, verifying that finding and switching the served reality to the line that does not rest on it.
- **Timing:** about 3 minutes from start to switch. The graph is deleted two hours later.

Open any graph at `/g/<graph>`; the served reality of a graph is at `/served/<graph>/`.

**A real run to look at:** [`/g/world-rehearsal-0212`](https://superpose.kevinj507.workers.dev/g/world-rehearsal-0212). Two Claude Code agents built a procedural world two ways: one random stream shared by every module, or one stream per module.
- **Discovered unprompted:** working on stable share links, one agent found that the shared stream couples modules, and filed it as a finding with evidence.
- **Propagated:** once verified, exactly the work resting on it went stale and re-planned.
- **Switched:** the served world at [`/served/world-rehearsal-0212/`](https://superpose.kevinj507.workers.dev/served/world-rehearsal-0212/) moved to the other reality.
- **Cost:** 19 agent runs, $0.22.

## What it does

- **A repo and a token per claim.** Claiming work forks the claim's line into its own Artifacts repo. The agent gets a git write token that never outlives its lease. Renewing the lease renews the token, and finishing or handing the claim back revokes it. Agents need nothing new: `git clone`, `commit`, `push`.
- **Every push is checked by the platform, not reported by the agent.** An Artifacts event trigger starts a Workflow for every push. It reads the commit, works out which files it changes against the claim's base, and judges them against the declared scope. Then a fresh Container fetches that exact commit and runs its tests. The verdict is recorded in a ledger keyed to the SHA; a new commit starts unverified.
- **A finding reaches only the claims that rest on it.** An agent that discovers an assumption is false files a finding.
  - While unverified, it stops nobody and runs beside the work as a hedge.
  - Once verified, exactly the claims resting on that assumption go stale, directly or through claims built on them. Their agents hear at their next lease renewal, their tokens are not renewed until they re-plan, and their pre-finding work is kept. Everyone else keeps pushing.
  - The cost of verifying a finding is shown before it fires.
- **Landing is a real git merge, in dependency order, by one writer.** The graph's Durable Object lands finished claims one at a time per line, in three containers:
  1. merge without running any project code;
  2. run the tests on the merged result, holding only a read token;
  3. move the line to that exact tested commit.

  A claim built on another waits for it to land, so its fork already contains that work. A conflict becomes a review item on the claim.
- **Why a file is the way it is.** `GET /api/graphs/<graph>/why?path=<file>` lists the landed claims that changed it, each with the statement it set out to make true, the assumptions it rested on (and whether they still hold), the verdict on its commit and the merge that brought it in. Every commit carries a `Superpose-Claim:` trailer.
- **Realities instead of a mainline.** A decision can be built two ways, as two lines. A finding's impact lists every reality: what in it is at risk, and which realities rest on nothing the finding contradicts. Switching what is served is one pointer change; the old reality stays retraceable. The served reality is a live website.

**Measured on the live system** (`sim/layer2.mjs`, report in `sim/report-2026-10-12.json`). 97 scripted agents held real leases, each with its own repo and git token, renewing every 15 s. A finding was filed and left unverified for 20 s, and nobody was stopped. Once verified:
- every one of the 9 affected agents heard within one renewal interval (at most 14 s);
- none of the other 88 heard anything;
- all 4 pushes made from stale claims were refused.

## What an agent can and cannot do

- **Write access comes only from a lease.** An agent's git token can push to its own claim's repo and nowhere else, and lives no longer than its lease. Every token a lease held is revoked when it ends. The 24-hour tokens that Artifacts' `create()` and `fork()` return are revoked at once.
- **What changed is read by the platform, never taken from the agent.** Scope verdicts come from the commit's trees. A commit too large to list completely cannot land.
- **Project code never runs next to a write token.** A check fetches with a read token in one process, then runs the project's code in another process with no token. A landing merges in a container that runs no project code, tests the merge in a second container with a read token only, and moves the line from a third.
- **The served reality is sandboxed.** Agent-written pages are served with a CSP sandbox, so they run in an origin of their own.
- **Two adversarial code reviews ran,** four reviewers, then two. Every finding is fixed and has a test.

## Cloudflare architecture

| Product | Role |
|---|---|
| **Workers** | The HTTP API (`src/index.ts`), the canvas (`public/`) and the served reality |
| **Durable Objects** (SQLite) | One per project graph (`src/graph.ts`): claims, leases, findings, the verdict ledger, lines. The single writer for coordination state and for landings |
| **Artifacts** | A repo per line (`<graph>.line.<name>`) and per claim (`<graph>.claim.<id>`). Lease-scoped write tokens, plus reads of commits, trees and files for the scope check and the served site |
| **Artifacts events → Workflows** | `cf.artifacts.repo.pushed` for the namespace starts `PushFlow` (scope check, then tests) for every push. `LandFlow` runs each landing |
| **Containers** | A fresh container per check or landing step (`src/checker.ts`), from a public Node image; the playground's agents also run in one |

## Run it

**Watch it:** plan a project and start agents against the hosted instance (needs `SUPERPOSE_ADMIN_TOKEN` and `SUPERPOSE_AGENT_KEY`), or deploy your own:

```sh
git clone https://github.com/kevinj507/superpose && cd superpose && npm install
# Your Cloudflare account needs Workers Paid (Artifacts, Containers).
# Create the Artifacts namespace "superpose" in the dashboard (Storage & databases > Artifacts), or:
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/artifacts/namespaces" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" -d '{"namespace":"superpose"}'
npx wrangler secret put ADMIN_TOKEN    # for planners and humans
npx wrangler secret put AGENT_KEY      # for agents taking work
npx wrangler deploy                    # Worker, Durable Objects, Workflows, push trigger, containers
```

Then plan a project and start agents. Node 22 and git are needed, plus Claude Code (logged in) for real agents:

```sh
export SUPERPOSE_URL=https://<your worker>.workers.dev SUPERPOSE_ADMIN_TOKEN=... SUPERPOSE_AGENT_KEY=...
node runner/plan.mjs scenarios/world --graph demo            # seed the code, create assumptions, lines and claims
node runner/run.mjs --graph demo --agents 3 --model sonnet   # real agents; --agent scripted needs no model
```

Open `/g/demo` to watch: claims colour as agents take, push, finish and land them. To see a finding propagate, file one from an agent's working copy:

```sh
node runner/superpose.mjs finding --contradicts <assumption> "<what is false>"
```

Then verify it with `POST /api/graphs/demo/findings/<id>/verify` (admin token). Only the claims resting on that assumption light up. `node sim/smoke.mjs` checks a deployment end to end. More is in `runner/README.md`.

## Develop

```sh
npm install
npx vitest run     # engine and coordinator in Node; the API and Durable Object in the local Workers runtime
npx tsc --noEmit
```

Tests run against an in-memory git host (`src/core/fake-host.ts`) with real content-addressed trees, three-way merges and token checks, because Artifacts is not emulated locally. Containers and the push trigger run only when deployed. `sim/smoke.mjs` and `sim/layer2.mjs` run against a deployment.

## Layout

- `src/core/`: the engine in plain TypeScript, with no Cloudflare dependency.
  - `engine.ts`: claims, leases, findings, propagation, the ledger, landing, realities.
  - `coordinator.ts`: the claim lifecycle across the git host.
  - `repos.ts`: the git host interface and tree diff.
  - `checks.ts` and `landing.ts`: the container scripts.
- `src/graph.ts`: the per-graph Durable Object. `src/push-flow.ts` and `src/land-flow.ts`: the Workflows. `src/checker.ts`: the container. `src/artifacts-host.ts`: the Artifacts binding.
- `public/`: the canvas. `runner/`: the agent runner. `scenarios/`: projects to run agents on. `sim/`: checks against a deployment.

MIT licensed.
