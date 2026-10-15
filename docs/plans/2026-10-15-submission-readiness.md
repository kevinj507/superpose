# Make Superpose reproducible for the Cloudflare submission

## Purpose / Big Picture

Kevin's objective is a submitted Cloudflare hackathon entry: a working product for concurrent coding agents, built on Workers and Artifacts, with source code, an explanation, a 5–10 minute demo video, and simple run instructions. A judge or their coding agent should be able to clone the repository, supply their own Cloudflare account credentials, deploy Superpose, and run a small demonstrable scenario without this development machine, BB, or the private knowledge graph.

The hard deadline is **2026-10-15 06:59 UTC**, equivalent to October 14 at 11:59 p.m. PDT and October 15 at 2:59 a.m. EDT. Kevin called this 2:59 a.m. EST; use the UTC deadline to avoid a one-hour error. The official rules were checked on October 15. Proposed working targets: reproducible deployment/demo by 04:00 UTC, optional small experiments only while that path is secure, scope freeze by 04:30, video ready by 05:30, upload and links checked by 06:15, human submission by 06:30. These are scheduling targets, not completed work or guarantees.

The existing Superpose knowledge graph is the work record: https://graphtask.wafers.live/g/jprk87jdmkrj923a. Use its dependencies and source records before each implementation step, update it as work happens, and keep this file as a portable copy of the current plan. Do not create a new knowledge graph.

## Progress

Current continuation: session #9397, after full handoff #9396. Kevin owns the video. The completed pilot remains 11/11, 11/11, 5/11. Its separate no-model qualification passed 20/20 checks and all three actual landings. The root README, supporting docs and public evidence receipts now provide a single judge/agent entry point. Portable wrapper/cleanup qualification passed; full local verification passed 272 tests and typecheck. Production was updated to ff4a4f2a-3b0a-42d3-9b5a-1d88806f70c4; fresh production recovery passed all 11 checks in 159 seconds. Source review found no known credentials or token-pattern matches across the reviewed source and reachable history; final copy/link changes are being checked. Source access/publication and Kevin's manual entry remain outstanding.

- [x] 2026-10-15 02:19 UTC: audited the repository README, deployment config, runtime experiment launcher and qualification script; verified official deadline and required deliverables.
- [x] 2026-10-15: retrieved the existing graph and full export; reread the submission/scoring records, build notes, accepted findings framework, earlier recovery experiment, latest runtime experiment, and relevant research.
- [x] 2026-10-15 02:24 UTC: reconciled the existing submission, project hub, build notes and latest result; created session #9389 and tasks #9390–#9395, verified their dependency/evidence edges, and saved a fresh full graph export.
- [x] 02:47 UTC: portable setup and smoke passed from a clean checkout on separate Cloudflare resources; two concurrent submissions checked and landed in67s.
- [x] 02:56 UTC: corrected CSV own-check configuration and baseline attribution; real Cloudflare demo retained and normally completed the unchanged CSV commit after repair,11/11 integrated checks,145s.
- [x] Portable bun run demo implemented and passed with no model login or host-specific executor. Real-agent quickstart remains part of documentation.
- [x] About 03:10 UTC: completed the approved uncertain-discovery pilot. Controls passed 11/11; Superpose delivered 5/11 because its three checked submissions did not finish landing. Two agent-originated findings were shared while unverified; affected receipt was observed. Preserve the result and its limitations.
- [x] Implemented narrow live-assumption revision, prose-only completion and pending-command settlement fixes; 42 focused tests and typecheck passed. Deployed test version 9565012c-b3ae-42aa-a0f8-5cae0934e0b6.
- [x] Separate prose lifecycle qualification: 20/20 checks, three normal CLI completions and actual landings in 119.275 s. The first sandbox executor-startup failure is retained. No model rerun.
- [x] Central judge/agent README, setup/agent guidance, current demo walkthrough, public receipts and copy-ready submission fields prepared. Kevin owns video production.
- [ ] Check repository access, license, video, hosted URLs, and human submission receipt.
- [ ] Optional/deferred: ordinary CI-alert comparison. The spontaneous unverified-finding experiment has finished; neither experiment is a submission prerequisite.

## Surprises & Discoveries

The runtime-change experiment already used the actual deployed Worker, Artifacts repositories, Workflows and Cloudflare check containers. Local Docker containers isolated coding-agent execution and private evaluation; they did not emulate Superpose's backend. Control groups had Artifacts-backed origins but were evaluated on their local shared edits whether or not they pushed. Preserve that distinction rather than prescribing Git coordination to the vanilla control.

The initial audit found portability incomplete: the research scripts depended on local credentials and Docker, and the old README/demo emphasized a placeholder world scenario. Portable setup/smoke/demo commands now pass on a separate Cloudflare installation and README has been rewritten in the working tree. Research launchers still have additional host dependencies and must remain separate from the judge quickstart. The old storyboard is now explicitly historical in `docs/earlier-world-video.md`; `docs/demo.md` describes the current qualified demo.

The graph already has submission task #9184, superseding #9202, and scoring guidance #9203. The October 13 target is obsolete. Earlier #9362 explicitly deferred the throughput changes proposed at the end of design #9353; do not present batching or a one-container landing path as shipped.

The earlier experiment #9383 already exercised candidate uncertainty, confirmation/refutation, selective invalidation and replacement sessions under a controlled protocol. The new research gap is spontaneous discovery and handling of an unknown finding with minimally instructed agents, not a claim that no unverified finding has ever been tested.

## Decision Log

Kevin, October 15: submission is the goal; experiments must reflect Workers and Artifacts; judges must be able to deploy using their own keys; use the graph and prior work to avoid omissions. This supersedes the earlier instruction to postpone submission work until requested.

Execution choice: prioritize the repeatable deployment/demo and packaging before spending the remaining deadline on additional experiments. Keep both follow-up questions as explicit optional work, without choosing a desired winner.

Execution choice: use a deterministic scripted demo to establish that the real platform works without requiring model credits. Label scripted behavior honestly and provide a separate path for actual concurrent coding agents. Existing real-agent evidence supports the explanation; a scripted replay is not a new model-performance result.

## Outcomes & Retrospective

Portable setup, smoke, and recovery demo pass on a separate Cloudflare installation. Original experiment results remain unchanged. The approved unverified-finding pilot finished: controls 11/11, native 5/11 delivered, with spontaneous uncertain findings and targeted receipt but completion bugs. Its post-run product fixes passed the separate full no-model lifecycle qualification (20/20). Pending provider-command settlement has unit coverage; no model experiment was rerun. Publication, final instructions and entry remain outstanding. Kevin handles video.

## Context and Orientation

`src/index.ts` serves the API and canvas through Workers. `src/graph.ts` stores each project's coordination state in a SQLite Durable Object. `src/artifacts-host.ts` uses the Artifacts binding for real Git repositories and scoped credentials. `src/push-flow.ts` receives Artifacts push events and runs verification. `src/land-flow.ts` integrates accepted work. `src/checker.ts` executes checks in Cloudflare Containers. `wrangler.jsonc` declares these resources and the Artifacts namespace/event trigger.

`runner/runtime-fixture.mjs` defines the small job-service scenario. Its service change causes affordable jobs to be incorrectly stopped unless temporary refusals are handled correctly. `runner/runtime-input-adapter.mjs` publishes observed public service inputs; it supplies no diagnosis. `runner/run-runtime-codex.mjs` is the isolated research harness. `runner/qualify-runtime-inputs.mjs` exercises the real backend without models, but currently depends on this machine's executor setup. `docs/experiments/2026-10-15-runtime-results.md` records the result and the CSV delivery limitation.

Graph reading path: #9176 project purpose; #9184 submission deliverables; #9193 official requirements; #9203 scoring; #9330 historical platform lessons; #9353 evolving design read together with #9362 accepted implementation scope; #9383 controlled recovery experiment; #9388 runtime result; #9246 selective propagation and uncertainty; #9234 exact-checker research. Historical claims retain their dates and evidence limits.

## Plan of Work

First add a small setup entry point under `scripts/`, exposed through `package.json`. It should accept the judge's account ID, existing credential mechanism, and deployment name; check prerequisites; create or reuse the requested Artifacts namespace; generate Superpose admin/agent secrets without printing them; deploy matching Worker/Workflow/event names; and save a private local connection file plus the public URL. It must not require Kevin's account wrapper on other machines. On this machine follow `.cloudflare-account` and the installed wrapper. Avoid changing the existing hosted service while testing a new installation.

Correct the CSV failure before using the scenario to claim uninterrupted independent delivery. Standalone checks should test the claim's own code appropriately, while the constitution tests its combination with the shared line. Distinguish a pre-existing shared-line failure from a failure introduced by an unrelated claim. Qualify a pending unrelated fork before and after a shared repair, including rechecking and the normal delivery path; do not finish the feature manually behind the experiment's back.

Package a scripted demo that creates a fresh graph, seeds actual Artifacts repositories, holds concurrent claims, changes the declared runtime, observes a real automatic check and finding, shows selective notification, repairs through ordinary submission, and checks final integrated behavior. Print its canvas URL and concise receipts identifying Cloudflare resources and exact commits. Produce a nonzero exit on unmet conditions, with bounded waiting and a useful current-stage error. A local pass against fake repositories is not acceptance.

Then update the README and add a concise repository `AGENTS.md` directing a judge's agent through the same setup and demo commands, expected outcomes, model requirements for optional live agents, and cleanup. Prepare the explanation and video around visible behavior that actually shipped. Preserve the old world demo as historical evidence if useful; do not imply placeholder commits build its finished application.

The two optional experiments answer distinct questions. The CI comparison adds ordinary automatic failure alerts without graph routing, retaining a minimally instructed vanilla control. The unknown-finding experiment gives realistic work and evidence but no prescribed finding, JSON report, or forced belief; records discovery, uncertainty, verification, sharing, affected work and final behavior. Both retain isolated groups, exact gpt-6-luna, equal common task information, no coaching, bounded cost/time, and independent evaluation. Read #9383 first to avoid repeating a controlled-path test and calling it spontaneous discovery.

## Concrete Steps

Existing local verification commands, from the repository root:

    bun install --frozen-lockfile
    bun run test
    bun run typecheck

Implemented interfaces (passed from a clean checkout):

    bun run setup --account-id <judge-account> --name <deployment-name>
    bun run demo

The demo should read the setup output automatically and print a URL plus pass/fail results. Document the exact authentication options and Cloudflare token permissions after checking the current official product documentation; do not guess permission names. Workers Paid and availability of Artifacts/Containers are account prerequisites. Coding-agent login is separate from Cloudflare authentication.

## Validation and Acceptance

A clean checkout can deploy to the selected account and run the scripted scenario using only documented prerequisites and user-supplied Cloudflare credentials. No BB command, private graph, host-specific path/image, Kevin secret, or model account is needed for that scripted path. The real-agent path demonstrates at least two concurrently active coding agents and states its additional login/runtime requirements.

The deployment creates real Artifacts repositories, receives real push events, runs Cloudflare checks, and records checked code/input versions. The demo shows only affected claims receiving the contradiction, a repaired current line, and successful independent-feature delivery. Missing runtime data and stale check results cannot become a green verdict. The video distinguishes this deterministic mechanism demonstration from the actual model experiments and their limitations.

No comparative win is required. A null result is recorded honestly. The final run instructions fit the form's current limits, the source includes the existing MIT LICENSE, the video is 5–10 minutes, and links can be opened by judges. Kevin completes the actual entry: the official rules exclude automated entry. Capture the receipt once he submits.

## Idempotence and Recovery

Setup should reuse only explicitly selected resources and preserve generated secrets on a retry. Demo runs get unique names and keep failure receipts; cleanup targets only those resources. Never erase or rewrite prior experiment graphs, commits, transcripts or results to improve the presentation. Keep a full knowledge-graph export before and after this planning update.

## Artifacts and Notes

Official rules: https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf

Submission page: https://www.cloudflare.com/git-competition/submit/

Current live service: https://superpose.kevinj507.workers.dev

Real runtime pilot: https://superpose.kevinj507.workers.dev/g/runtime-20261015t003452-g3

The earlier runtime pilot passed 8/11 checks for vanilla, 8/11 for optional notes, and 10/11 for Superpose. Superpose detected, routed and repaired the runtime failure; its CSV extension was stranded. A separate diagnostic passed 11/11 after merging the unchanged CSV commit, but is not a delivered experiment result. This evidence does not isolate graph routing from ordinary CI alerts.

## Interfaces and Dependencies

Use the existing Worker API, Artifacts binding and native claim/submit interfaces rather than a parallel mock coordination implementation. Keep model execution a client choice: local/container isolation is compatible with a Cloudflare-hosted coordination and Git backend. Share scenario data between demonstrations and research where sensible, without exposing private evaluation answers to coding agents.

Updated October 15, 2026 to incorporate Kevin's deadline, platform, reproducibility and graph-maintenance requirements. Implementation statuses must be updated as the work proceeds.
