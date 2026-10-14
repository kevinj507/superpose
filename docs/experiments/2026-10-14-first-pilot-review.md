# Review of the first 6 luna pilot

Reviewed 2026-10-14, after preparing [the next experiment](2026-10-14-challenged-assumption.md). No new coding-agent run was started for this review. A check qualification was reproduced without a model.

## What the result actually says

All three groups built a shop that passes all six independent product checks. For the main coordination question, this was a failed exercise: the setup never produced the required finding-delivery-verification-recovery sequence, and the separately planned controlled rehearsal was not run. A product pass cannot stand in for that missing experiment. It did demonstrate correct construction with explicit requirements, several usable platform operations, and problems in the experiment machinery and proposal workflow.

Kevin's correction was to make the next run actually exercise the core behavior. The responsibility lies with the experiment design/operator: the page task made the interaction foreseeable, candidate publication was omitted, owner replies were late, and no coverage barrier prevented us from finishing without the intended sequence. Those are not findings that agents ignored a warning they received.

| Group | Final product checks | Observed elapsed time | Counted tool actions |
| --- | --- | --- | --- |
| Ordinary Git | 6/6 pass | 2m17s including evaluation | 55 |
| Git with interaction instructions | 6/6 pass | 3m30s including evaluation | 62 |
| Superpose | 6/6 pass after landing | 5m21s to the final shared commit | 91 |

These are one run per group, in matched-Git → ordinary-Git → Superpose order. The timing endpoints differ: the Git numbers include evaluation; Superpose's number ends at the last landing. They are descriptive observations, not reliable speed estimates. Superpose's final accepted head is `48691256a6844c2a23cf8591e73668e61bd41d55`.

The six checks cover displayed versus paid prices, actual compounded price increases, real cache reuse/refresh/expiry, accurate orders, the catalog/home page, and real HTTP behavior. Constant prices or disabled caching cannot earn this product pass. Product acceptance must be distinguished from satisfying every experimental protocol condition.

The session audit finds eighteen distinct fresh task sessions, all `gpt-6-luna` with medium effort, six per group and three slots per group. No provider error notifications appear in those corrected-session transcripts. Every recorded feature commit stays within its task's published files. Two matched-Git commits also contain the request-channel file `.experiment/requests.jsonl`; that instrumentation change needs separate treatment below. No coding agent changed the constitution.

## Agents prevented the interaction we hoped to observe

The page task explicitly required refreshing on a price change, and all agents received the public displayed-price/payment promise. We removed the supplied executable `see-is-pay` article, but retained its business intent and made cache freshness explicit. This was not a repeat of the earlier experiment with an undisclosed price-equality requirement.

The transcripts show the same prevention in all groups:

- Matched Git's page agent said it would check `priceOf(id)` on every request and include the price in its cache key, so a purchase could not leave an old price visible until expiry. It implemented this before pricing had landed.
- Ordinary Git's page agent chose a product/current-price cache key at the outset, then rebased and added a price-change regression test after pricing landed.
- Superpose's page agent chose entries containing `{ price, html }`, comparing the current price and evicting on mismatch. It stated this plan before the later pricing-article notice arrived.

The evidence supports anticipation and construction, rather than a warning correcting an already mistaken plan. There was no verified contradiction, broken combination rejected by the gate, or checked repair in this natural run. The separately planned controlled conflict rehearsal was not completed.

Success therefore cannot establish that routing caused correctness. Failure to show a benefit here also does not establish that routing is useless when relevant context is larger or an assumption changes later. Changing the task wording and model from the older Haiku rounds prevents attributing the difference between those rounds and this pilot to Superpose's new features alone.

## A filed candidate did not reach its intended recipient

Pricing claim c3 filed f1, an unverified advisory finding for purchase claim c4: capture the current paid price before advancing the next price. It was filed before c4 started.

The final snapshot leaves f1 unverified, with no `publishedTo` permission. There is no `finding.shared` event. Its statement appears in the finder's outputs, but not in c4's initial prompt, subsequent user messages, recorded command outputs or final notice file. We have evidence of filing, not presentation to the intended recipient. This is not evidence that c4 ignored a warning.

The current engine filters unverified findings to the finder, a holder investigating that finding, or explicitly published destinations. The CLI's advice path also requires publication before another holder can receive an unverified finding. That policy protects isolated groups, but the first pilot did not include an explicit decision to share this advisory within its own group. This gap must be described as a policy/operator omission; it should not be presented as successful candidate routing.

Other notices did work. Both the page and purchase transcripts contain the adopted pricing article, and agents acknowledged it and refreshed their briefs. Those notices repeated an already public requirement; they do not prove a new causal insight or conflict repair. Filing, publication, local receipt, presentation and changed behavior need distinct measurements.

## Proposed checks exposed two different weaknesses

Matched Git produced four unique proposed checks. Three named files outside the proposing task's scope or did not provide an independently qualifiable in-scope artifact. They were not adopted.

The server proposal supplied a real check in its own `test/server.test.js`. It compared a page with the first purchase only. The known stale-cache integration fails on a later page/purchase, so this check passes both the correct and broken examples. The owner declined it. Reproduction during this review at proposer commit `c38c62bf24d0e047132049313e7a13b9be8f00ba` again gives exit 0 on both examples. A plausible description and a passing test are insufficient protection.

Superpose recorded two prose proposals: pricing article a8 and order-record article a14. Both match existing public promises; neither introduced an executable check. The purchase agent first tried to submit its own `test/orders.test.js`, but the API rejected it because proposal `checkFile` must be under `constitution/`. The CLI then says to keep proposed checks outside `constitution/`, whose files agents may not change. Proposal-source files and the owner-adopted destination are being conflated. This is a concrete workflow defect, separate from an agent writing a weak test. The intended owner-copy-and-qualification path was not demonstrated.

Adopting prose does not mechanically enforce the proposed behavior. The saved settled snapshot predates the later adoption of a14; the owner-action journal records that adoption separately. Neither adoption is evidence that executable protection improved this product.

## Owner timing and request tracking did not meet the protocol

All four matched-Git owner replies arrived after the proposing session had completed. Recorded request-to-reply delays were approximately 64, 178, 178 and 168 seconds, beyond the intended 30-second window. Three replies arrived after the whole matched-Git group had finished. The agents therefore did not experience the timely proposal/qualification service described in the design.

The Superpose proposals were also resolved late: a8 roughly 134 seconds after filing and a14 roughly 131 seconds after filing. Both proposers had completed by their own response time, although other active claims received the a8 adoption notice. This uneven opportunity limits comparisons of proposal and owner-service behavior. The operator supplied no repair algorithm, but absence of coaching does not make delayed interventions equivalent.

The matched-Git pending journal contains eight entries for four unique proposals. Requests committed into shared Git were rediscovered in other clones and treated as new local requests; one was queued twice in its original clone as the file changed. The subsequent owner review counted only the four originals. This did not expose one group to another, but it corrupts naive proposal counts and can consume request allowances incorrectly. Requests need stable IDs, original authorship and an out-of-code transport or explicit handling of copied records.

## Launcher and evaluation errors affected observation

The preceding 18:39 block is a preserved launcher-calibration failure, not a valid product comparison. Its guard charged every accumulated token at an unrelated output rate. For example, pricing's 171,892 total tokens became a $0.257838 estimate and crossed that guard's $0.25 threshold; the corrected conservative accounting of the recorded input/output counts is $0.0221885. These amounts are accounting estimates, not subscription invoices.

The corresponding provider turn ended `interrupted`, while normalized telemetry labelled the task `done` with no blocker. The telemetry implementation treats every non-failed completed turn as done. That can hide the very interruption Kevin wanted to observe. The old cancellation handler also allowed later groups to start after the active child was stopped. The corrected block used fresh contexts and repositories; the repeat is an explicit deviation from the one-block plan, with the failed block retained.

The later concurrency audit found a BB host limit of 20, no global limit, and one active BB thread. Standalone experimental Codex sessions use a separate three-slot launcher rather than BB thread admission. There were no provider concurrency/rate-limit error notifications in the examined interrupted sessions; the bad threshold reproduces their stop point, and corrected sessions completed beyond that point under the same launcher concurrency. The budget calculation is the best-supported cause of these recorded stops. Audit-time settings do not prove the historical machine never slowed work, and a current limit would not establish the cause of an earlier incident.

The corrected Superpose containers lacked the Bun executable named by their installed commit/push hooks. All six Superpose tasks hit that failure and worked around it without an operator repair hint. Several agents also encountered missing `rg`. These are toolchain problems, not demonstrated reasoning failures. Bypassing client hooks still allowed server-side checks, but it means the intended local hook workflow was not successfully exercised.

The first Superpose evaluation ran when its coding runner exited, while the page and purchase changes were still landing. It inspected an incomplete shared line and failed. The last landing completed at 18:55:12 UTC; independent evaluation at 18:55:33 then passed. The failure and final result remain separate records. Finishing an agent session or submitting a claim is not the shared product being ready for evaluation.

## Resource observations and limits on their interpretation

| Group | Cumulative input tokens | Of those, cached input | Output tokens | Nonzero command results |
| --- | --- | --- | --- | --- |
| Ordinary Git | 1,079,768 | 936,704 | 10,986 | 7 |
| Matched Git | 1,408,197 | 1,218,816 | 14,938 | 15 |
| Superpose | 2,146,198 | 1,923,328 | 17,480 | 26 |

These totals sum the final usage counter from each distinct task session. Input totals accumulate repeated requests; they are not simultaneous context length, unique information, or billed dollars. Cached input is already included in input, not additional input. The old summary's `turns` field counts completed tool items, not conversational/model turns. Nonzero commands include missing tools, push/rebase conflicts and refused operations; their count is not a measured amount of wasted coding work.

Superpose required more actions and elapsed time in this block. Check/landing waits, dependency scheduling, local hook failures, notices and platform interactions contribute. We cannot infer the intrinsic price of routing, a scale bottleneck or a fresh-context saving from these aggregate counts. No stale-context replacement was tested. Actual subscription dollar billing is unavailable and remains null.

## What this changes about the next experiment

The next test starts with disclosed, prepared claims and incident-specific artifacts that materially rely on the contested premise, including a case where the warning is wrong. It explicitly publishes the candidate while holders remain available, binds external evidence to the incident/configuration, follows receipt through behavior, and protects unrelated work. Git gets the same fresh-session capability in one control so a context reset alone cannot be credited to the graph. A no-model end-to-end rehearsal and live phase barriers require proof of the core steps; coordination coverage and product correctness have separate verdicts. Early correct diagnosis is recorded instead of suppressed, and an unexercised subquestion is never represented as success or rerun for a platform win.

Before execution, the machinery needs complete tools/hooks, accurate interruption labels, timely deterministic owner checks, stable request IDs, shared limits across replacement sessions, selective interruption and a final shared-line barrier. This review identifies those requirements; it does not implement them or launch the next pilot.

## Primary records

- Corrected block: `/root/.bb/thread-storage/thr_mzwkfv2wea/superpose-handoff/live-20261014t184404/`, especially `final-results.json`, per-group session transcripts and summaries, owner journals, and Superpose's `settled-snapshot.json` / `settled-result.json`.
- Calibration block: adjacent `live-20261014t183923/`, including `harness-failure.json` and interrupted-session transcripts.
- Review-derived audit: `/root/.bb/thread-storage/superpose-handoff/first-review-audit.json`; no-model reproduction: `first-review-server-qualification.json`. These were generated during the review, not during the original run.
- Original protocol and execution record: [9376](https://graphtask.wafers.live/g/jprk87jdmkrj923a?node=9376). Next design: [9380](https://graphtask.wafers.live/g/jprk87jdmkrj923a?node=9380). The [product canvas](https://superpose.kevinj507.workers.dev/g/obs-20261014t184404-superpose) shows the saved experiment's service state.
