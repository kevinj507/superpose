# Observe coordination with minimal Codex instructions

Kevin accepted this direction on 2026-10-14. This document records the next pilot's design; it is not a launch record or a claim that its scenario has been qualified.

The purpose is to observe what agents do and use the observations to change Superpose. A successful ordinary Codex group, a sufficient shared notes file, an unused Superpose feature, or unnecessary Superpose overhead are useful results. The experiment must not manufacture reliance on a bad premise or supply coordination decisions to the comparison groups.

## Groups and limits

Use three groups, with three coding roles in each: worker execution, retry handling, and independent CSV export. Each group gets its own repository and runtime. Within a group, collaboration and agents' own coordination choices are allowed.

| Group | Additional project support |
| --- | --- |
| Codex baseline | None. An ordinary task request and normal project documentation. |
| Codex with shared notes | A shared notes location, with a brief statement that it is available. No required format, reporting cadence, or workflow. |
| Codex with Superpose | The current product's task claims, constitution checks, and tool reference. Agents choose whether to declare assumptions, file findings, or otherwise coordinate. |

All coding sessions use **gpt-6-luna, medium effort, the same service tier and Codex configuration**, with no fallback. Verify the actual provider selection before launch. Here the baseline means Codex without our added project coordination instructions; it does not mean a direct model API loop. A separate raw-model comparison is outside this short pilot.

Use three coding slots at a time and run the groups sequentially. Target five minutes of coding per group and 15–20 minutes for the live comparison, with a hard 20-minute live deadline including setup and settlement. Preparation time is reported separately. Freeze the order before launch. No repeat to obtain a desired outcome and no extra investigation or judge agents. Keep existing action/usage guards, recorded outside the task prompt, and do not reset them with another session. Do not impose fresh-session replacement as a treatment in this pilot.

## What the baseline receives

Give each role one ordinary feature request, the repository, and access to normal product requirements and interfaces. For example:

> Implement retry handling for this job service. Preserve completed effects, keep genuinely over-budget jobs stopped, and satisfy the product requirements in the README.

The other requests concern worker execution and CSV export. Their exact wording, interfaces, tests, and seed must be qualified and frozen before launch. They describe desired behavior rather than a coordination method.

Do not tell baseline agents to write progress JSON, use a findings journal, list assumptions, perform a prescribed investigation, acknowledge a message, wait at a tool checkpoint, park work, replan, or request a reset. Do not warn them that the scenario contains a misleading diagnosis. Do not place experiment reports, observation scripts, verdicts, or operator notes in their checkouts. Agents may create their own notes or mechanisms; record those choices without coaching.

Do not leak this protocol, earlier experiments, hidden reference repairs, other groups' transcripts, or operator reasoning. Host telemetry records prompts, tool actions, provider events, Git activity, stalls, and artifacts without asking agents to report those events themselves. Stop/time limits and isolation are infrastructure controls, not behavioral instructions.

## A small evolving project

Use a job service whose initial runtime supports a reasonable existing implementation. After work begins, a worker rollout changes a relevant runtime behavior. Ordinary project diagnostics expose the change; the worker task is likely to encounter it first, but early discovery by any role is allowed. Retry work may be affected, while CSV work remains independent.

Include one obsolete diagnostic clue as well as the consequential current evidence, so indiscriminate warnings and unsupported changes can be observed. These are two clues in one episode, not independent true/false trials. Use ordinary project artifacts and executable behavior rather than a prewritten finding delivered into every conversation.

Every group receives the same initial code, requirements, interfaces, checks, and access to the same evidence at the same elapsed time from group start. Evidence must concern that group's runtime. Roles in a group can inspect their own shared service and collaborate; the operator does not select recipients or announce the diagnosis for baseline or notes groups. Superpose routes only findings actually filed through its ordinary product path. Preload task claims and product promises, not contested assumptions or their dependency edges on the agents' behalf.

The release time is fixed before launch, independent of whether agents adopt any premise. If agents anticipate the change, finish before release, or do not encounter it, preserve that observation and label the relevant question unexercised. Do not delay them, force false belief, create a warning for them, or rerun until the conflict occurs. If five minutes proves insufficient, report unfinished work rather than extend the run silently.

## Qualification and observation

Before live coding, qualify the initial and updated runtime, public interfaces, evidence provenance, independent product oracle, positive reference repair, and rejection cases without model calls. Confirm the exact tool shell and Git hooks work. Audit every outgoing prompt and mounted file: the baseline must receive no old challenge-controller instructions, and none of the containers can read operator secrets, hidden checks, prior runs, or another group's data. Independently probe repository and runtime access boundaries. Use a fresh isolated Codex session for every role.

Measure discovery, communication, recipients, agent-created coordination mechanisms, evidence checked, actual changes after new information, invalid work that continues, unnecessary changes to independent work, final product behavior, actions, usage, and elapsed time. Record what agents actually do rather than treating a seeded dependency or an acknowledgment as proof of belief or recovery. Report suspected stalls to Kevin; do not send agents a repair hint.

Separate final correctness from whether the discovery/coordination opportunity occurred. Report each group individually. With one episode per group, do not claim a reliable ranking, effect size, scale result, or general model capability. Count the support supplied by our runner and the extra instructions supplied by Superpose as part of the treatment.

## Launch boundary

The old challenged-assumption controller cannot run this protocol unchanged: it writes experiment state into checkouts, injects a candidate and checked diagnosis, schedules investigation turns, and prescribes replanning. Reuse its isolated sessions, scoped transport, external event capture, and budget accounting only. The new baseline path must omit that coordination controller.

At the time this direction was recorded, no live coding-agent run had started under this protocol. Freeze and review the qualified fixture, exact prompts, group order, isolation evidence, and limits before a live launch; honor Kevin's standing instruction to ask before a real-agent run. Do not rerun the older experiment and describe it as this comparison.

Related evidence: [first pilot review](2026-10-14-first-pilot-review.md) and [challenged-assumption results](2026-10-14-challenged-assumption-restart-results.md).

## Authorized short pilot

Kevin explicitly authorized execution with “let's run it.” The order is Codex, notes, Superpose, with three roles and one initial feature request per role. The baseline prompts are just the corresponding feature requests from `runner/minimal-fixture.mjs`; the notes treatment adds the shared notes location, and the Superpose treatment adds its claim/tool reference. No model-directed observation files enter the baseline.

The simulated service changes at **40 seconds after all three sessions are ready and coding starts**, regardless of their plans. Before the rollout, a temporary refusal uses `capacity_limit`. The new revision returns a legacy `budget_limit` label for the same affordable, temporary refusal, retaining HTTP 429 and a retry delay. Current runtime diagnostics record capacity admission; an older, clearly versioned maintenance record is also available. Future error mapping is not exposed in the seed. The project requirements do not change.

Five minutes per role, 50 counted actions and the existing $0.50 conservative API-equivalent guard apply. Nine initial coding sessions, three simultaneous slots, no replacement treatment and no extra model judge. The hard 20-minute live deadline starts with group setup; preparation is outside that measured interval. Record any group not reached before the deadline rather than adding time.

Each coding container sees its own checkout and scoped Git/API transport, its group's read-only service runtime, and, only in the notes condition, its group's writable shared notes directory. Test these exact mounts and denied routes before any model turn. Common Codex settings disable cross-session memory, apps, plugins, web search and additional subagents; all groups use those same settings. This studies minimally instructed isolated Codex sessions, not every possible default Codex configuration.

Superpose receives no operator-created candidate, contested assumption, or dependency edge. An owner permission automatically permits agent-filed findings to be shared inside their own project; permission is not verification. Ordinary native notices may be steered to an active Superpose holder. No experiment diagnosis or repair hint is sent. These added product facilities are part of its treatment and must be counted.

The independent evaluator checks both service revisions, genuine budget admission, actual execution counts, retained effects, bounded pending work, and exact escaped CSV. Public service tests also see the mounted current runtime. Cloudflare check containers have no mount of that simulated external runtime, so their default client uses the initial revision; a green platform check is not evidence about the rolled runtime. Report this environment limitation explicitly. Evaluate the actual shared Git line and preserve unsubmitted workspace changes separately; the host does not merge or complete work on the agents' behalf.

If all roles finish before the rollout, the coordination opportunity is unexercised. If a role chooses not to inspect diagnostics, declare assumptions, use notes, or file findings, preserve that behavior. Do not prompt it to use the missing mechanism. Fixed order and one episode per group limit comparisons to observations.

### Setup deviations retained

The first attempt stopped before feature turns because the outer sandbox denied Codex app-server's normal state writes. The labelled live retry permits those host writes while retaining isolated coding containers.

Codex and notes then completed their single task turns before the 40-second rollout; neither group was repeated or given another task. Superpose setup stopped before any Superpose model turn: conservative overlap matching ordered the two wildcard test scopes, preventing simultaneous task assignment. Only those setup patterns were changed to exact role test filenames; prompts, seed source, runtime, oracle, budgets and model are unchanged. The untouched Superpose group continues under a separate label, with the original live deadline and a maximum of nine actual coding sessions across the completed groups and continuation. This is a recorded setup repair, not a matched block with identical controller source.

The nine coding sessions have now completed and closed. [Results and limitations](2026-10-14-minimal-codex-results.md) preserve original shared-line scores and separately label the diagnostic of the controls' unsubmitted patches. No subsequent coding-agent run is part of this pilot.
