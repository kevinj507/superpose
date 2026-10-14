# Observe agents discovering and resolving an interaction

Version `shop-observation-v2`, revised 2026-10-14 after Kevin delegated experiment design and operator judgment and selected 6 luna for every agent. Kevin observes. The operator prepares the scenario, runs the checks, applies a fixed response policy and reports stalls. Kevin supplies no requirements, hints or decisions during a run. This document replaces the earlier proposal that he should coach or adjudicate the comparison groups.

The first live pilot is three runs with three coding agents at a time: ordinary Git, Git with explicit instructions to reason about interactions, and Superpose. Six tasks are assigned in each run, with a fresh context per task, so the pilot contains up to eighteen task sessions, not nine. No real-agent run is started by preparing this design.

Every coding agent uses exactly `gpt-6-luna`, at medium reasoning effort. Start a new session for each task; do not fork, resume or inherit this operator conversation. Disable reading and generating provider memory, extra subagents, and automatic model substitution. The local provider catalog lists this exact model; that is not yet proof of request access. Record the actual session identifier and model when execution begins, and stop on a mismatch or a reused session identifier.

Each task receives its own container containing only its checkout and a fixed toolchain. Agents in one group collaborate through that group's Git repository and, for Superpose, its scoped service routes. Containers cannot read other groups, the parent project, private evaluators, earlier transcripts, graph answers or owner credentials. A group-scoped gateway must restrict network access as well; unrestricted web access could expose old answers even with separate files. No shared chat or global memory connects groups. Operator alerts to Kevin stay outside coding sessions, and the fixed owner policy does not pass one group's newly discovered fix to another group. Filesystem isolation and network routing need independent preflight evidence before live execution.

The no-model probe `runner/probe-experiment-isolation.mjs` passed on this host using an already-local Docker image identified by its immutable digest. It verified reading/writing the permitted checkout, rejection of a synthetic sibling answer and a symlink escape, absence of the host project/session storage/Docker socket and inherited owner secrets, and private temporary storage. Its report explicitly leaves live network verification and launcher readiness false. This verifies a tested container boundary, not a deployed agent launcher; repeat it with the final frozen toolchain before execution.

## Questions we will answer

1. With the same clear product intent, do agents avoid or discover the interaction between caching and changing prices? Do they create a useful executable promise or merely implement the feature correctly?
2. When a reproducible interaction is present, does the platform check the named combination, deliver evidence to the relevant work and preserve its history? This is a separate controlled rehearsal, so success here cannot be confused with spontaneous agent discovery.
3. What causes agents to stop or waste work: unclear context, a false suspicion, missing evidence, a dependency, a merge, a platform problem, a time limit or a model limit?

A pilot can reveal behavior and harness defects. One block cannot establish a reliable win, scaling behavior or a benefit specifically caused by routing. If all three groups implement the product correctly on their first attempt, record that as a ceiling of this scenario. Do not introduce an undisclosed bug or rerun until Superpose wins.

## Public product promises

All six promises below are given in each agent's initial brief, not just left in a file it might never read. They are also in `PROMISES.md`. Their executable expression is the variable under investigation, not a hidden business requirement.

| Promise | Meaning |
| --- | --- |
| Pay the shown price | A page request followed by a purchase of that product, with no intervening purchase, charges the displayed price. |
| Prices follow demand | Each successful purchase raises only that product's next price by 5%, compounded and rounded to cents. Reset restores base prices. |
| Useful caching | Repeated requests reuse a rendered page while its product and price are unchanged and its age is below 60 seconds. Refresh on a price change or at the expiry boundary. |
| Honest order records | A purchase returns and records its product and paid price. Unknown products return 404, cannot be bought and cannot create orders. |
| Complete catalog | The home page lists every product in catalog order, links to its product page and shows its current price. Product pages show their name and price. |
| A working HTTP server | `createServer()` provides the shop over HTTP. Importing the module and creating a server do not start listening. |

Sequential purchases are the scope. Quotes held across another person's purchase, simultaneous checkout, sessions, taxes, payment providers, persistence and authentication are outside this tiny scenario. Price correctness and useful caching are simultaneous requirements: turning either feature off fails acceptance.

The page task explicitly supplies an observable interface for testing caching: `PAGE_TTL_MS`, `createProductPages({ttlMs, now, render})` returning `{productPage, clear}`, the shop's `productPage`, and `clearProductPages`. The supplied clock and renderer let the evaluator count actual reuse without prescribing a cache key or repair algorithm. The existing cache, pricing, order, home and server tasks otherwise retain their interfaces and file scopes.

## Condition A: natural discovery and construction

Start from the same untouched shop seed. Each group builds cache, fast pages, demand pricing, purchases that move prices, a home page and an HTTP server. The public promises are identical. The existing three small executable articles remain. Remove the pre-written `see-is-pay` article from the starting code and plan; the pay-shown requirement remains public. Agents may implement it directly, propose an executable article, or report an interaction.

| Group | Instructions and channels |
| --- | --- |
| Ordinary Git | Task board, public promises, shared Git history and normal fetch/incorporate/test/push workflow. The common operator request channel is available, without additional instruction to enumerate assumptions or contradictions. |
| Matched Git | The same setup plus explicit instructions to identify assumptions, check effects in both directions, report interactions with involved tasks and evidence, and propose missing executable promises. Findings are shared in Git history/a common run log. |
| Superpose | The same semantic instructions as matched Git, plus claim forks, findings, protected articles, combination checks and targeted delivery. The operator uses the platform's adoption and verification routes. |

Use the same model/version, effort, context limits, tool capabilities, task order, concurrency, workspace isolation and owner facts. Use Cloudflare Artifacts as the Git host in every group for the live comparison; the current ordinary-Git runner's local bare origin needs a remote-origin adapter first. If a local Git rehearsal is used, label its times separately, never mix them into the hosted comparison. Superpose's additional checks and landing waits are part of the platform bundle and are measured separately from agent work.

Randomize the sequential run order using the fixed seed `14010`, generated by `armOrder()` before looking at outcomes. Every group receives new repositories, graph/run IDs and contexts. Sharing across groups is disabled; the operator cannot carry an agent's newly discovered remedy to a later group. History from the old Haiku runs is background, not a matched control for the new launcher.

## Condition B: a controlled conflict rehearsal

This condition uses no coding model. Prepare two exact branch heads from the existing golden fixtures: the cache/page work and the pricing/order work. A common baseline is green. Each branch alone is green. Their combination shows a cached price of $40 while the next purchase charges $42. The corrected integration is green. Name the exact branch versions; retain the unchanged product promises and ordinary file permissions.

Rehearse a located finding against the agreed pay-shown article through mechanical checking and notification. The active page/cache and pricing/order claims are the named combination; a third unrelated claim is a delivery control. Verify confirmed evidence and appropriate recipients, an inconclusive result after code moves, a refuted suspicion, an unadopted proposal, expiry of explicit speculation, and preservation of the previous plan. These mechanisms have local engine, real-Git script and Worker-runtime tests; the live API/Workflow rehearsal must also pass against the deployed code before model runs.

This is deliberately created test input. It demonstrates platform behavior, not that an agent noticed the problem. If Condition A never exercises delivery/repair, its report says so. A later real-agent recovery comparison would start all groups with the same independently verified conflict and clearly disclose that it was seeded; it is a separately budgeted experiment, not a silent extension of this pilot.

## The operator's fixed policy

Every agent can send at most two clarification/proposed-rule requests per task. Blocker reports have no quota and do not request coaching. Requests and responses have timestamps, the task, promise ID, exact branch version, action, reason and evaluator evidence. The target response window is 30 seconds; a delayed response is recorded as operator waiting time, not erased.

- A clarification repeats the relevant published promise verbatim. It supplies no code, repair strategy or suggestion about which file is wrong.
- A proposed article must express one of the six published promises. The operator records the semantic match; a claimed ID alone does not prove a match. Equivalent wording is allowed. A promise changing price behavior, removing cache reuse, changing routes or broadening the scenario is declined with the fixed reason that it falls outside the published intent.
- A proposal without a check can be adopted as prose. That does not create executable enforcement. A proposal with a check is qualified on fixed examples in an isolated process without credentials before adoption. A valid pay-shown check passes the correct integration and fails the known stale-price combination; constant-true and constant-false checks are rejected. Other checks use the counterexample appropriate to their promise. An article about price equality alone need not test caching performance: full product acceptance separately enforces every promise.
- Checks are taken only from the proposing task's permitted files and exact recorded commit. If qualified, the operator lands a copy under `constitution/` using owner access, without modifying feature code. Adoption waits while unfinished dependency interfaces prevent meaningful qualification; it is not evidence that the proposal is false. Record the wait and do not substitute an unpublished implementation.
- In ordinary/matched Git, accepted promises/checks are owner commits on the shared line with a response to the proposer. In Superpose, the same content is owner-landed and adopted through the API. All groups receive the same kind of permission to propose, the same acceptance criteria and the same request ceiling. Visibility and routing then follow the group’s own coordination mechanism.
- An agent-filed prose finding is investigated only against its claimed evidence and the public promise, with an independently reproduced result recorded before verification. Timeout, inaccessible code or platform failure leaves it inconclusive. The operator never verifies a report because a timer ended.
- A blocked agent gets no solution, extra context or extra turns. Record the blocker and tell Kevin. The baseline outcome remains unfinished if it cannot proceed. Any later assisted repair is a separate, clearly labelled follow-up with fresh measurements.
- One transport retry is allowed for a confirmed infrastructure failure with unchanged inputs; the same rule applies to every group and preserves the original time/cost record. No additional agent attempt, semantic rescue, scope expansion or budget extension is allowed in the pilot. An unresolved investigation expires after its configured window and is parked under the same published policy.

The operator is acting for the experiment, with Kevin's delegated authority. This does not add a model judge to Superpose's base infrastructure or give ordinary coding agents owner credentials.

## Independent acceptance

`scenarios/shop/hidden/experiment-contract.mjs` evaluates fresh processes independently of agent-written tests or test scripts. It checks:

- Displayed versus charged prices across several products and successive purchases.
- Actual compounded prices, rounding, per-product independence and reset behavior.
- Actual render reuse, per-product cache entries, refresh on price movement, expiry and clear behavior.
- Returned order prices, stored order history, and unknown-product responses without phantom orders.
- The unchanged catalog, product links/order/names, current home-page price and current product pages.
- HTTP behavior through an actual server.

The corrected golden fixture must pass all six groups of checks. The known broken combination must fail the intended interaction. Frozen-pricing and disabled-cache examples must fail full acceptance even when they satisfy price equality. Deleted tests never grant acceptance. Changed owner files or cross-task edits are separately recorded and cause the run to fail the declared scope/fixture contract; approved owner article additions are logged exceptions. Crashes, missing interfaces and check timeouts are errors/incomplete outcomes, never passes.

Before any agent starts, move private evaluators/reference fixes and the scenario validation harness out of its accessible filesystem. A seed-only copy is necessary but not sufficient on a shared host: the launcher must prove the agent cannot read the original repository, secrets, sibling contexts, prior transcripts or the graph's old answers. Freeze hashes of the plan, seed, public prompts, owner policy, evaluators and launcher, and record the actual model and Git/Worker versions. Stop preflight if isolation or hard limits cannot be enforced.

## What Kevin will see

Poll normalized launcher/graph observations every 10 seconds. Provide a short progress update at least each minute during active runs, and promptly report:

- An agent explicitly blocked by access, merge resolution, a platform error, an early exit or a budget/time limit.
- A possible stall: no completed action/code/test progress for three minutes, or three identical failed attempts without intervening progress. Label uncertainty rather than claiming the agent is definitely stuck.
- Ordinary waiting for a prerequisite or a check still inside its deadline. Waiting is a distinct state, not an agent failure.
- A discovered interaction, approved or declined article, checked result, warning delivered to a holder, repair attempt and checked final result.

Example: “The page agent may be stuck: the same test has failed three times without a code change. The pricing agent is still working; the server agent is waiting for its dependency. I’m preserving the run without sending a hint.” The next update says whether progress resumed. Notifications are deduplicated, and sending an observation to Kevin does not change an agent's prompt.

`experiment-observer.mjs` implements these distinctions; `watch-experiment.mjs` consumes sanitized telemetry and writes alerts. The launcher must populate task start/progress times, explicit blockers, repeated-failure counts and check deadlines before the observer is considered live. The operator delivers the alerts in this thread while a run is active. The protocol does not claim an installed unattended notification service.

## Limits and reporting

For the first live pilot: one pre-ordered block of three runs, three concurrent coding slots, six task sessions per run, one attempt per task, at most 50 turns and 15 minutes per task, and 30 minutes per run including infrastructure waits. The model ceiling is $0.50 per task, at most $9 for the eighteen sessions, with no unapproved retries or second block. These are caps, not a promise that an unknown model will complete the tasks at that price. Cloudflare usage and operator time are separately recorded; model spending is not a cap on all infrastructure charges.

Existing runners use Claude Code, which is not installed here. A launcher replacement, a shared hosted-Git baseline, normalized observer telemetry, the request/reply adapter, budget/timeout enforcement, workspace isolation and an appropriate deployed Superpose version are execution prerequisites. Check model access without launching coding agents. A launcher incapable of enforcing the caps fails preflight. Ask for a single explicit go-ahead for the concrete bounded real-agent pilot after these prerequisites are prepared; Kevin is not asked to design the test or decide routine runtime questions.

Primary result: final product acceptance with every requested feature preserved. Also report spontaneous discovery versus prevention, article/check proposals, contradictions with correct involved work, wrong suspicions, appropriate/irrelevant warning recipients, rework, unfinished tasks, cost/turns, operator actions, agent time and infrastructure waiting.

For affected holders, separate finding filed, checked/verified, locally delivered, presented in the agent session, first substantive response and a combined-product repair. Receipt/presentation are recorded by the runner; action and repair are annotated against the transcript and checked commit. A replan, a push or green individual CI is not by itself a verified repair. Missing stages remain null. Never exclude a failed or unfinished run from the comparison. Publish the event timeline and interventions along with the final score so Kevin can see how the outcome happened.

After the pilot, the next test is chosen from its actual gaps: a disclosed seeded recovery comparison if discovery was too easy; a controlled false-finding/isolation test if routing is noisy; or a bounded later-work wave if assumptions need testing across handoffs. Each is a separate test with its question and budget fixed before running.

## Execution record, 2026-10-14

The natural comparison ran with independent Codex app-server conversations and a Docker exec-server per task. Model credentials stayed with the host; task containers had no external networking. A Unix-socket gateway supplied only their own graph API and granted Git remotes. All three groups used Cloudflare Artifacts and actual session records confirmed gpt-6-luna / medium. The same product promises, scopes and evaluation cases were used.

The initial block exposed a defective spending guard and is retained as a launcher calibration failure. A corrected block followed with fresh groups and unchanged product inputs. The budget guard now uses conservative standard-tier API-equivalent token costs and a request reserve; actual subscription dollar billing is unavailable and remains null. The single-block plan was therefore exceeded for infrastructure correction. All calibration results and the reason for the repeat remain in the record. Operator replies also exceeded the target response window; timestamps expose that delay. No coding hints were supplied.

The corrected comparison passed every independent product check in all three groups. Superpose's first evaluation occurred before the final two landings completed; that provisional failure is preserved separately from the passing settled result. The final evaluator belongs to the exact shared commit. The results note gives observations and limits; it does not claim a routing advantage or statistical reliability. The separate controlled live conflict rehearsal remains outstanding.
