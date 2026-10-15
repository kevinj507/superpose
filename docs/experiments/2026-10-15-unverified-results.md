# Agents discovered and shared uncertain findings; delivery exposed two gaps

The follow-up exercised the intended discovery path. With an ordinary bug-fix task and no instruction to file findings, two Superpose agents independently recorded contradictions against the old service contract. The owner’s scripted sharing policy published them while still unverified. The retry agent acknowledged the first warning and inspected its evidence. CSV received no contradiction, and no claim became stale. This demonstrates discovery, uncertain sharing and relevant receipt in this case. It does not demonstrate a performance advantage or successful end-to-end delivery.

Both controls passed all 11 independent product checks. Superpose’s recorded shared product passed 5/11 because none of its three submitted claims finished and landed before evaluation and shutdown. Its pushed code and findings remain on the record. The agents’ completion messages were not evidence of backend completion; in particular, CSV reported its claim complete while its `done` command was still running.

| Group | Final checks | Coding through evaluation | Tool actions | Configured usage estimate |
|---|---:|---:|---:|---:|
| Vanilla Codex | 11/11 | 45.546 s | 26 | $0.05438 |
| Optional notes | 11/11 | 41.639 s | 37 | $0.04598 |
| Superpose | 5/11 delivered | 157.329 s | 49 | $0.11119 |

These are assertions on one small workload, not independent samples. Estimates use the runner’s token rates, not actual billing, and exclude Cloudflare usage. Nine isolated gpt-6-luna / medium / default-tier sessions ran in three sequential groups with three coding slots. All groups received the same 11 public files and service-28 evidence. There were no provider errors, observer errors, reported stalls or budget cutoffs. The block from first coding task until every group closed took 354.432 seconds. The notes directory remained empty.

## What happened

The worker task was a normal customer bug report: an affordable `pressure` job was being stopped. It did not supply the diagnosis, a finding format or coordination instructions. Retry and CSV received ordinary feature tasks. Both control worker/retry pairs read the current diagnostics and recognized that a temporary refusal used the legacy `budget_limit` code. They edited the shared working tree and passed final evaluation. This differs from the earlier pilot, where no task directly asked anyone to investigate the service regression.

Superpose’s worker filed f1 approximately 12.9 seconds after its group started. It cited service-28, the affordable cost and budget, HTTP429, a retry delay and the capacity admission result. The owner policy published it to `main` without verifying it. The retry agent explicitly said it saw the published doubt and checked the cited diagnostics; it then filed f2 at approximately26.8seconds. Both findings remained unverified. No automated checker or operator supplied their wording or diagnosis. No finding was published across experimental groups.

The product correctly kept uncertainty separate from invalidation. There were zero `claim.stale` events. Worker/retry added replacement assumptions and attempted to stop relying on the old one. Both were refused with `not_stale: ... only a stale claim re-plans`. This is a product inconsistency: the CLI advises a holder to revise its own assumptions after finding contrary evidence, but the engine required the claim to be globally invalidated first.

All three native commits passed their own Cloudflare checks. There were no executable constitution articles in this pilot, so the backend correctly created no combination-check job. The CLI nevertheless waited for a pair result for up to150seconds. Codex returned its final messages while those asynchronous `done` processes were still active. The harness treated model-turn completion as task completion and checked only queued landings; no claim had reached `done`, so it evaluated the unchanged seed and closed the executors. A read after closure confirmed zero finish/landing events and all three released claims open with their pushed heads retained.

This is both a product completion bug and a harness settlement gap. The no-model preflight proved uncertain publication and receipt, but did not complete a submitted claim with a prose-only constitution. The earlier runtime demo had an executable article and therefore did not expose this case. The5/11 result is preserved; it must not be described as proof that native agents wrote worse code. Nor may a later repair or manual integration be credited to this live run.

## Harness defaults matter

Control agents repeatedly said they did not run tests; one explicitly attributed that to its instructions. An audit found the installed gpt-6-luna metadata’s default instruction: “Do not add or run tests unless the user asks you to test or verify implementation.” No custom `developer_instructions` or model-instruction file was configured in the inspected host config. Superpose’s normal brief supplies test/submission workflow context, and its agents ran tests. This comparison includes those harness/context differences. It does not show that raw model reasoning alone determined whether tests ran. Future manifests should preserve the default model-instruction hash as well as application prompts. The metadata audit occurred after the run; full serialized model requests were not captured.

## Changes prompted by the run

The post-pilot product revision allows a live holder to revise its own assumptions while retaining its frozen statement/scope and a superseding history record. That action does not verify the finding or invalidate other work. The CLI recognizes when no executable articles apply and does not wait for a nonexistent job. The research session wrapper now tracks running commands beyond model-turn completion, and the launcher waits for already-started commands within the same role budget before evaluating. These are post-run changes, not features credited to the frozen run.

A separate no-model full lifecycle qualification passed **20/20 checks** on the real test deployment, version `9565012c-b3ae-42aa-a0f8-5cae0934e0b6`. It took 119.275 seconds and verified isolation, unverified publication and refutation, active assumption revision, ordinary CLI completion and all three actual landings under a prose-only constitution. The scoped qualification commits contain comments, so this proves the delivery mechanism, not new model-generated functionality. [Receipt](../evidence/prose-completion-qualification.json) · [Canvas](https://superpose-judge-check.kevinj507.workers.dev/g/discovery-qual-mv8zqmlj).

The preceding sandbox attempt failed during local executor initialization after three uncertainty checks; its [failed receipt](../evidence/prose-completion-startup-failure.json) is retained. The provider-command settlement change has unit coverage; the scripted lifecycle qualification does not test a new model turn completing with a pending command. No additional coding-agent rerun is claimed here. The useful learning is that agents can produce and consume uncertain context, but platform bookkeeping and completion must support their next actions. The controls’ success also shows that an ordinary bug report and accessible evidence can be enough for these small tasks.

Frozen source: `9dffc73`. [Protocol](2026-10-15-unverified-discovery.md). [Native graph](https://superpose-judge-check.kevinj507.workers.dev/g/discovery-20261015t030311-g3). Evidence: `/root/.bb/thread-storage/superpose-handoff/discovery-live-20261015t0304`, including manifests, provider/tool transcripts, scoped transport, local products, committed heads, final snapshots and post-close snapshot. Qualification: `discovery-qual-mv8y98nf`. The prior runtime pilot and its separate recovery demonstration remain unchanged.

The [public pilot summary](../evidence/discovery-pilot.json) preserves the original check results and source-result checksum for inspection without the private research directory.
