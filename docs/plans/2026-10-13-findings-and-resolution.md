# Deliver and resolve findings without breaking isolation

This is the living execution plan for the framework Kevin accepted on 2026-10-13. Progress, discoveries, decisions and outcomes must stay current. The product is Superpose: a statement layer over Git, with claim forks on Cloudflare Artifacts and coordination on Workers. Its purpose is to tell an agent when another piece of work changes something its work relies on, with evidence and a record of the resolution.

## Purpose / Big Picture

An agent can report a suspected contradiction and continue a bounded investigation without stopping unrelated work. Executable constitutional articles supply mechanical verification; prose needs owner judgment. Independent groups retain their isolation unless the owner publishes a specific finding. Agents may propose product promises, but only the owner can adopt or amend the constitution. The current merge-and-check pipeline remains in place while this workflow is completed.

## Progress

- [x] Read the handoff and graph nodes 9355, 9353, 9357, 9336, 9246, 9260, 9327 and 9328.
- [x] Kevin accepted the product framing, qualified evidence, isolation policy, bounded hedges, and matched experiment design.
- [x] Cloned `kevinj507/superpose`; local commit identity is Kevin Joo <kevinj507@gmail.com>.
- [x] Saved a graph export outside the repository in thread storage. Supplied credentials are in the ignored `.env`, mode 0600.
- [x] Finish the bounded primary-source research note and record session 6 in graphtask.
- [x] Establish the existing test and typecheck baseline.
- [x] Implement owner decisions, article proposals and adoption, and correction history.
- [x] Implement deliberate sharing across isolated lines and bounded investigation behavior.
- [x] Verify agent-filed executable contradictions against recorded code combinations.
- [x] Expose the workflow through HTTP and the agent CLI, including retraction guidance and meaningful notices.
- [x] Run scripted verification and prepare the matched experiment protocol and measurement tools.
- [x] Complete tests, typecheck, local review, and update the graph session with results.

## Surprises & Discoveries

The engine already holds unverified findings locally and has a hedge deadline, but the test director blindly verifies findings after a delay. That shortcut cannot serve as the new verification policy. The baseline was 178 passing tests and a passing typecheck. Graph session 6 is #9362; the bounded research note is #9363, still in review. The current storage uses legacy claim and assumption states; avoid introducing another parallel status vocabulary. Core tests have no Cloudflare dependency; Worker tests use fake Git repositories and remote bindings are disabled.

## Decision Log

Kevin accepted the statement-and-context workflow as the product promise, while its advantage over equally instructed Git agents remains a hypothesis. Do not claim novelty or scalability from one run per arm.

Verification, relevance and permission to share are distinct. Unverified findings stay local by default. The owner may deliberately share a candidate result with its uncertainty intact. Verification must not erase isolation boundaries.

A finding does not automatically create a reality. Existing claim forks support investigation. Alternate lines are explicit, budgeted choices. Hedge expiry requests a decision and cannot create evidence or adopt an article.

Agent proposals stay in review until owner adoption. Proposed check code is evidence, not trusted executable constitution code; adoption of an executable article requires a check file already present in the owner-controlled constitution of the selected line.

Finish semantic verification and resolution before redesigning merge throughput. Batching, speculative dependencies, a one-container landing and nonblocking working-line landings are deferred. Real-agent runs require a separate agreement on launcher, protocol and budget. No model judge is required by the base infrastructure.

## Outcomes & Retrospective

The semantic milestone is implemented locally. Full validation passed 205 tests across 21 files and typechecking; focused checks cover the final history and privacy corrections. Local browser screenshots of the canvas and owner decision confirmation were inspected; no browser errors appeared. Owner article review, located mechanical checks, independent-group context, candidate publication, bounded investigation and preserved amendment/replan history are available through the API and agent CLI. Canvas inspectors display evidence, proposals and investigation decisions. Delivery receipts distinguish receipt from presentation; action and repair still need transcript annotation. No deployment or real-agent experiment has been launched. The matched experiment protocol is ready for review, not executed. The existing legacy claim/assumption state storage remains; this milestone does not rewrite it to the proposed four-state representation or change merge throughput.

## Context and Orientation

`src/core/engine.ts` manages claims, leases, assumptions, findings, doubt and pair verdicts. A claim is work with a promised outcome and a file scope. A finding reports evidence supporting or contradicting a statement. `where` identifies the claims whose combination is at issue. `src/core/types.ts` defines these records, and `src/core/store.ts` supplies in-memory storage. `src/sql-store.ts` persists the same records as JSON in a Durable Object, so additive fields need no table migration.

`src/graph.ts` wraps engine operations in synchronous SQLite transactions and coordinates Git operations. `src/index.ts` protects owner routes with ADMIN_TOKEN and agent operations with leases. `src/core/pair.ts`, `src/push-flow.ts`, and `src/land-flow.ts` run checks on combinations of exact code versions. `runner/lib.mjs` and `runner/superpose.mjs` create briefs, notices and the CLI. `runner/run.mjs` launches agents; `runner/plain.mjs` is the comparison. Read their launch code before selecting any new agent command.

## Plan of Work

Milestone one adds owner-reviewed article proposals and decisions without weakening the constitution. Agent lease routes create proposals; owner routes adopt or reject them. Adoption records its authority and makes the article effective only after its executable check is present. Superseding an article retires its prior active version, preserves the record, and invalidates verdicts dependent on it. Meaningful core and Worker tests demonstrate that agents cannot adopt their own proposals or turn elapsed time into verification.

Milestone two adds a deliberate sharing policy for isolated lines. Findings remain scoped to their originating group until the owner authorizes publication. Publishing an unverified candidate delivers an advisory notice; it does not mark work stale. Publishing a verified contradiction applies doubt only to newly authorized, relevant recipients. Existing project collaboration remains the default, and speculation gets no automatically created fork. Hedge expiry exposes a decision and pauses only work explicitly declared to depend on the unresolved finding.

Milestone three mechanically verifies agent-filed contradictions against executable articles. Capture the line, selected claim heads and article versions before checking. Merge the recorded code in a trusted setup step and execute checks without write credentials. A failing article verifies the allegation only for that recorded combination; a passing check refutes it there. Conflicts, timeouts, missing code and platform failures remain inconclusive. Reject a result whose inputs moved while checking. Prose remains owner-reviewed.

Milestone four exposes these capabilities through the HTTP API and CLI, updates briefs and notices, and replaces blind verification in the scripted director with an explicit policy. Preserve isolation in polling and brief generation as well as engine notifications. Build deterministic scripted cases for false suspicions, confirmed composition failures and intentional cross-group sharing. Prepare measurement of discovery, checking, delivery, action, repair, false alerts, rework and cost.

## Concrete Steps

Use Bun in `/root/workspace/superpose`. Install existing pinned dependencies with `TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/superpose-bun-cache bun install --frozen-lockfile`; these overrides avoid the sandbox's read-only default temporary/cache paths. Run `bun run test` and `bun run typecheck`. Use narrow test-file selections during implementation, then the complete repository checks after the changes settle.

Keep secrets in `.env` and never print values. Use the isolated GitHub configuration `/tmp/superpose-gh.e3Obsc` for GitHub CLI operations. For graphtask, read the supplied token inside the process and send it only as an authorization header to `https://graphtask.wafers.live`, with writer attribution. Session 6 supersedes graph node 9355; record accepted decisions without overwriting old proposal text as if it were final.

## Validation and Acceptance

An agent can propose a promise, see it in review, and cannot enforce it until owner adoption. An executable adoption fails if its check is not present in the trusted constitution. A hedge deadline never verifies a finding. Independent groups receive no routine cross-group findings; explicit sharing preserves candidate status. A reproduced pricing contradiction reaches exactly the affected work and records the checked versions. A refuted suspicion leaves unrelated work untouched. Changed code or articles invalidate prior verdicts. Worker tests verify authentication, persistence and the same observable outcomes over HTTP.

Scripted verification uses fake repositories or local Git and no model credits. The real comparison is ordinary Git, matched-prompt Git and Superpose, three agents per run with matched model and limits. Freeze product intent and owner adoption rules beforehand. Hidden answers remain outside agent reach. Pilot and repetition budgets must be agreed before running; historical Haiku outcomes are not a matched baseline for a replacement model.

## Idempotence and Recovery

Keep legacy records readable through additive optional fields. Validate all input before mutation and use the existing transactions for multi-record changes. Workflow results must be idempotent and reject changed or superseded inputs. Preserve earlier code, findings and articles rather than deleting history. Restore hidden scenario folders if any local rehearsal relocates them. The graph export in thread storage is the recovery copy for this session.

## Artifacts and Notes

Graph: `jprk87jdmkrj923a`. Prior session: 9355. Handoff: 9360. The accepted hedge is 9246; budget guidance is 9260. Local graph backup and primary-source downloads are in `/root/.bb/thread-storage/superpose-handoff/`. Research conclusions belong in the Superpose graph with source links and a clear distinction between observation and inference.

## Interfaces and Dependencies

Use the existing Engine, Store, Coordinator and RepoHost boundaries. New owner decisions and proposal metadata use the same graph record and five edge purposes. HTTP mutations remain POST routes with existing authentication classes. Do not add an LLM SDK, external database, alternate Git service or new graph. Mechanical checks run on the existing Cloudflare execution infrastructure and require no model. This change introduces no new package dependency.

## Changelog

2026-10-13: created after Kevin accepted the framework. Records isolation, evidence, budget and adoption rules; separates the semantic workflow from merge-pipeline performance changes and real-agent runs.

2026-10-13: completed the semantic implementation, 205 passing tests, primary-source research node #9363, and a proposed three-arm protocol. Forked lines carry accepted article versions; later amendments remain local. Replanned claims retain earlier promises and grounding edges.

## Observation design revision, 2026-10-14

Kevin delegated the experiment design and operator judgments: he will observe and receive notices when agents are stuck, without coaching or routine runtime decisions. The protocol now states six compatible public promises, separates withheld executable checks from public product intent, and distinguishes natural construction from a controlled no-model conflict rehearsal. A fixed spec, scenario preparation with hashes, independent product evaluator, owner policy and neutral stall/wait alert rules are implemented. The evaluator qualifies correct and broken integrations and rejects shortcut solutions. All promises are included in the Superpose initial brief as well as ordinary Git’s README-based brief.

The real-agent pilot is bounded to one three-run block, three concurrent slots and six task contexts per run, at most 50 turns and $0.50 per task ($9 model ceiling), with fixed time limits and no agent retries. This is a proposed execution ceiling, not permission to spend. Claude Code is absent here. Launcher replacement, hosted Git for the baseline, request/telemetry adapters, isolation and hard-limit enforcement, and a compatible deployed service remain execution prerequisites. No model run or deploy occurred. Graph design record: #9376.

Kevin selected 6 luna for all coding agents and authorized independent sessions or subagents with group isolation. The fixed spec now pins `gpt-6-luna` at medium effort, a fresh session per task, no conversation inheritance, no memory and no model fallback. Use a separate task container with only its checkout; collaboration stays inside the group through Git/Superpose. Parent secrets, hidden answers and other groups stay outside. The host has Docker available. A no-model filesystem probe tests the container boundary; a group-scoped live network gateway and replacement launcher remain prerequisites, so a filesystem pass alone never authorizes or marks a model run ready.

## Execution outcome, 2026-10-14

Finished the Codex launcher, network isolation, hosted-Git comparison adapter, telemetry and cost guard, then ran the accepted natural comparison. All eighteen corrected task sessions used fresh gpt-6-luna / medium contexts. Ordinary Git, matched Git and Superpose each passed all six independent product checks. A faulty first cost guard is preserved as a calibration failure; the corrected block used new groups with unchanged task inputs. Superpose's first read of main was premature while two landings remained; its passing settled commit and both snapshots are saved. The launcher now waits for remaining landings before evaluating.

Kevin's concurrency concern was audited: BB global limit unlimited, VPS limit 20, one active BB thread, and a separate three-agent limit for the standalone experiment. No concurrency or rate-limit error appears in the interrupted session streams; their token totals reproduce the old budget cutoff. The corrected tasks completed above that cutoff with unchanged concurrency. Current host load/memory showed no pressure explaining those stops.

The semantic service is deployed on Kevin's account as Worker version a351ee7e-cafd-44a7-8de6-99a1e326093a. Operator replies and delays, proposals without qualified checks, two adopted prose articles, calibration outcomes and the unsettled snapshot remain on the record. Actual subscription dollar usage is unknown. The results note is docs/experiments/2026-10-14-observation-results.md. Graph #9376 contains the live record. Validation exercised 224 tests; the refreshed generated bundle's script checks and typecheck passed. The separate controlled live conflict rehearsal and merge-throughput redesign remain outstanding. This natural pilot did not demonstrate a routing advantage.
