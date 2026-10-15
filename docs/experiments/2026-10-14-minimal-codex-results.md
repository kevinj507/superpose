# Minimal instructions produced edits; the live recovery comparison was not exercised

Nine isolated **gpt-6-luna / medium** coding sessions completed: three each for Codex, optional shared notes, and Superpose. Every role received one ordinary feature request. No progress JSON, prescribed investigation, injected finding, verified diagnosis, checkpoint, replan prompt, or forced reset was supplied. Superpose received its ordinary claim/tool reference; no agent filed a finding or declared a contested assumption.

This run captured useful task and delivery behavior, but **does not establish a coordination advantage**. The two controls completed before the scheduled runtime change. Superpose's agents were active when it changed, but did not discover/report it. The controls' shared repositories also remained unchanged because their edits were not pushed. Both limitations must accompany any outcome comparison.

## Observed behavior

| Group | Last coding turn ended | Counted actions | Delivery and coordination |
| --- | --- | --- | --- |
| Codex | 21 seconds | 15 | Edited all three features; no tests, commits, or pushes. |
| Shared notes | 27 seconds | 25 | Agents inspected notes; nobody wrote notes. One local worker commit; no pushes. Retry inspected runtime diagnostics before the change. |
| Superpose | 78 seconds; shared line settled/evaluated at 118 seconds | 27 | Three feature commits submitted and landed. Retry added and ran four focused tests. No findings or new assumptions. |

Times start with the group's feature turns; these are observations with different delivery endpoints, not speed estimates. The rollout was fixed at 40 seconds. Neither control had an active role at that point; all three Superpose roles did. One episode per group and fixed ordering cannot establish reliable model/platform rankings.

The baseline prompts were 112–185 characters and consisted only of the relevant feature request and a reference to README requirements. Notes added its shared location. Superpose added its claim/tool reference. Transcripts show exactly one outgoing feature prompt per role and no product-notice prompts: there were no findings to route. All nine threads were distinct, with no model fallback, fresh replacements, compaction treatment, extra investigator, or model judge. No action, time or usage guard fired. The live block, including setup repair, ended about eight minutes after its start; preparation was separate.

## Code outcomes and the meaning of delivery

The original shared-line checks fail in all groups. For the controls, that checks the unchanged seed, not their edited feature implementations. An ordinary Codex task response can be a local patch. We gave each role a separate clone and the README said to deliver through Git, but the task requests did not explicitly ask for commits/pushes. Thus a shared-line score is an incomplete measure of what those minimally instructed agents accomplished. Superpose's claim reference supplied an explicit submission workflow; its successful delivery is an observation about that treatment, not proof that ordinary Codex cannot deliver code.

After the controls finished, a separately labelled diagnostic copied each role's assigned feature file into a scratch copy. No source, original score, shared commit, or transcript was changed, and the diagnostic was not delivered to agents. Those composed patches pass the initial service, actual execution counts, genuine budget stops, idempotence, bounded pending work, and exact escaped CSV. They fail the two checks involving the changed runtime. Superpose's actual shared commit has the same pattern: six checks pass, the two changed-runtime checks fail.

The changed service returns the legacy label `budget_limit` for an affordable temporary capacity refusal, retaining HTTP 429 and a retry delay. All groups' resulting code still trusts that label as a reason to stop. This is a fragile retained assumption in the code. It is not evidence that an agent ignored checked contrary information: the controls had finished, no warning was sent, and Superpose's agents did not inspect the changed runtime. The one notes diagnostic inspection occurred before the rollout and concerned the old revision.

## What Superpose did and did not do

Superpose enforced scope, checked commits, and landed all three features. Its final graph contains three landed claims, the owner product article, and zero agent findings. Routing and contradiction recovery therefore remained unexercised. A graph layer does not produce a discovery simply because a service changed; some agent, test, monitor, or human must observe and report the consequential fact.

Clarification after Kevin's review: **agent reporting is not required for an executable constitution violation.** The existing gate automatically creates a verified finding when a current combination fails an article, applies contradiction impact, and prevents completion of the broken claim. In this episode the adopted check did not observe the changed service; the separate final evaluator detected the failure but only wrote a report. Framing zero findings primarily as agents failing to use the finding command understates that disconnected detection path. Automatic detection and reporting of violations covered by the constitution remain part of the intended product contract. Required runtime inputs, their versions, and change-triggered checks need to be connected before this episode can qualify that contract; silently using an old fallback cannot establish the current runtime promise.

The platform's green checks used the initial service fallback. Cloudflare check containers did not mount this pilot's simulated external runtime. They consequently did not reproduce the rolled service failure. The independent evaluator did. This environment limitation was recorded before launch: green results here establish behavior in the check environment, not current deployed behavior. A useful future design must account for the runtime/configuration evidence underlying a verdict, as well as its code version.

There was also real setup friction. Conservative scope matching treats two wildcard filename segments as potentially overlapping, so `test/worker*.mjs` and `test/retry*.mjs` created an ordering dependency. The initial Superpose setup could not assign both simultaneously. Exact role test filenames allowed parallel assignment. This is a concrete usability/throughput issue, not a model failure.

## Limits and the next design correction

My scenario sizing and release timing failed to create an active recovery opportunity for the controls. Their early finish is preserved, not rerun or converted into a claim that they cannot recover. The run meets the minimal-instruction requirement and records default behavior, but still does not answer the main dynamic coordination question.

For a future study, use an ordinary sequence of product tasks so a later task encounters a changed service after earlier work was completed. Another normal feature request is different from directing an agent to investigate a finding or write experiment records. Keep the same minimal task style and let agents decide how to communicate and repair. Do not keep them artificially busy or force commitment to a false premise.

Also state the control's workspace topology explicitly. Separate clones require a submission/integration step; a shared project directory would naturally contain all local edits. Both are useful workflows to study, but neither can silently stand in for all ordinary Codex usage. Preserve the distinction between patch correctness, delivery, discovery, routing, verification, and recovery. Merely providing an empty shared file did not cause coordination in this small episode.

No further coding-agent run was launched to obtain a platform win. These observations should guide the next design and possible changes to Superpose rather than defend its current format.

## Qualification, deviations and evidence

Thirteen fixture/session/gateway checks and typechecking passed before the live launch. After the setup failure, four fixture/prompt/scope tests passed, including a new regression proving the corrected role scopes are disjoint. Actual containers proved their own runtime readable but unwritable, operator files hidden, other-group API routes denied, and shared notes mounted only in the notes condition before model turns. All task containers were closed; no experimental agent remains running.

The first startup-only attempt failed when the outer sandbox denied normal Codex app-server state writes. The labelled retry allowed the host launcher those writes while keeping Docker isolation. The initial Superpose setup failed before any Superpose feature turn. Its unstarted holder was released; only the untouched Superpose group continued with explicit scope filenames and the original live deadline. Baseline/notes prompts, seed contents, runtime, oracle, model and limits were not changed, and neither control repeated. Controller source changes and all attempts remain preserved, so this is not advertised as a pristine matched block.

Total: **67 counted actions**, about **$0.123108 conservative API-equivalent usage**, not actual subscription billing. Each of nine roles remained under its original $0.50 measure, 50 actions and five minutes. The corrected live attempt plus continuation stayed inside its original 20-minute deadline.

- [Control block manifest](/root/.bb/thread-storage/thr_mzwkfv2wea/superpose-handoff/minimal-live-20261014t2344/manifest.json), [original results](/root/.bb/thread-storage/thr_mzwkfv2wea/superpose-handoff/minimal-live-20261014t2344/results.json), and [events](/root/.bb/thread-storage/thr_mzwkfv2wea/superpose-handoff/minimal-live-20261014t2344/events.jsonl).
- [Superpose continuation manifest](/root/.bb/thread-storage/thr_mzwkfv2wea/superpose-handoff/minimal-superpose-continuation-20261014t2348/manifest.json), [results](/root/.bb/thread-storage/thr_mzwkfv2wea/superpose-handoff/minimal-superpose-continuation-20261014t2348/results.json), and [settled graph](/root/.bb/thread-storage/thr_mzwkfv2wea/superpose-handoff/minimal-superpose-continuation-20261014t2348/g3/settled-snapshot.json).
- [Audit](/root/.bb/thread-storage/superpose-handoff/minimal-observation-audit.json), [Codex patch diagnostic](/root/.bb/thread-storage/thr_mzwkfv2wea/superpose-handoff/minimal-live-20261014t2344/g1/patch-diagnostic.json), and [notes patch diagnostic](/root/.bb/thread-storage/thr_mzwkfv2wea/superpose-handoff/minimal-live-20261014t2344/g2/patch-diagnostic.json).
- [Frozen design](2026-10-14-minimal-codex-coordination.md), [knowledge session #9385](https://graphtask.wafers.live/g/jprk87jdmkrj923a?node=9385), and [Superpose canvas](https://superpose.kevinj507.workers.dev/g/minimal-20261014t234828-g3).

Final Superpose shared SHA: `c7b0f3d82a75eb5c49066f4ca25d3b9e282be39e`. All per-role transcripts, unsubmitted workspaces, original oracle outputs, and controller source snapshots remain in the evidence directories. No Worker deployment occurred for this pilot.
