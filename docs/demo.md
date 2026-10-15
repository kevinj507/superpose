# Current Superpose walkthrough

Start with the [root README](../README.md) for the product, architecture, commands and measured results. Kevin handles the video. This guide identifies behavior and evidence that can be shown without inventing an experimental outcome.

## Run the reproducible demonstration

After [setup](setup.md), run `bun run smoke` and `bun run demo`. The demo prints its own canvas URL and writes `.superpose/runs/<graph-id>/result.json`. Every run gets a fresh graph. It uses scripted clients with zero model calls; actual repositories, events, checks and integration run on Cloudflare.

The [fresh production run](https://superpose.kevinj507.workers.dev/g/demo-mv8zz0i6-32e70f) passed all 11 checks in 159 seconds after deploying the qualified fixes. Its [receipt](evidence/production-recovery.json) records the exact commits.

The earlier retained [recovery run](https://superpose-judge-check.kevinj507.workers.dev/g/demo-mv8y1t5b-c23fc9) passed in about 145 seconds. Its sequence was:

| Approximate elapsed time | What to inspect |
|---|---|
| Start | Worker, retry and CSV each hold scoped claims with separate Artifacts repositories. Inspect a claim's statement, scope, assumptions and commit ledger. |
| +38 s | A service update breaks an adopted constitution article. The platform files the finding and identifies affected worker/retry claims. CSV is excluded. |
| +58 s | CSV's own checks pass. Its combined result waits because the same article already fails on the shared line alone; CSV is not blamed. |
| +87 s | The scripted worker has replanned, repaired and completed through the normal CLI. |
| +120 s | The same CSV commit is rechecked after repair and its waiting CLI completes. |
| +142–145 s | Worker and CSV are landed; all 11 integrated product checks pass. The idle retry holder is released. |

These timings describe the retained run, not guaranteed timings for a fresh deployment. A cold container can take longer. The unchanged CSV commit was `67b5253eda67931038c1bc01cbe308b8429fac11`; the worker repair was `d350cd9e22cc2c6150e0f762c044d30cc8a3f9bd`. The demo is a job-service fixture, not the earlier visual world application.

## Show real-agent evidence separately

The [runtime pilot](https://superpose.kevinj507.workers.dev/g/runtime-20261015t003452-g3) shows automatic current-service detection, affected-holder receipt and actual model repair. Its delivered result stays **8/11, 8/11, 10/11**. CSV did not land. The later scripted recovery demonstrates a fix, not a revised pilot score.

The [discovery pilot](https://superpose-judge-check.kevinj507.workers.dev/g/discovery-20261015t030311-g3) shows two findings authored by actual coding agents and shared by the owner's scripted policy while still unverified. Retry acknowledged the first warning. No claim became stale and CSV received no contradiction. Its delivered result stays **11/11, 11/11, 5/11** because completion failed. Native commits passing their own checks and model messages claiming completion did not mean they landed.

The post-run completion qualification is a separate scripted check. Use the [experiment reports](experiments/) for the exact conditions, limitations and fixes. Do not file a finding on camera and describe it as spontaneous discovery. If a fresh run fails, keep its receipt and use the retained run with its date and scripted/model label.

## Explain the platform

Workers serve the API and canvas. Each project's graph and evidence live in a SQLite Durable Object. Artifacts provides real Git repositories and scoped tokens; push events start Workflows. Containers run checks and integration. The constitution tests the combined product, while a claim's own checks test its own work. Findings connect evidence to the claims that depend on it; sharing a suspicion does not verify it.

The [older world storyboard](earlier-world-video.md) and [earlier README](earlier-world-demo.md) are historical. The landing page's older scripted playground uses placeholder edits; it is not the current job-service recovery demonstration and is not evidence of model discovery.
