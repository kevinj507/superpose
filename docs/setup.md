# Deploy and run Superpose

Install [Bun](https://bun.sh/docs/installation) and Git. Use a Cloudflare account with Workers Paid and access to Artifacts and Containers. A `workers.dev` subdomain must be enabled for the account. The demo uses a public container image: [Cloudflare does not require local Docker for registry-image deployments](https://developers.cloudflare.com/containers/guides/deploy/).

## Cloudflare credentials

Supply `CLOUDFLARE_API_TOKEN` in the environment, scoped to the account you select. The deployment needs permission to create and edit Workers (including its Durable Objects and Workflows), Containers, and Artifacts namespaces. In token interfaces using the legacy permission names, these are Workers Scripts Edit/Write, Containers Edit/Write, Artifacts Read and Artifacts Edit, plus Account Settings Read for account/subdomain lookup. Current role-based interfaces require Workers Admin to create a new Worker. No custom domain or DNS change is part of this setup.

See Cloudflare’s current [Workers authorization](https://developers.cloudflare.com/workers/authorization/workers/), [Artifacts token prerequisites](https://developers.cloudflare.com/artifacts/get-started/rest-api/), and [permission reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/). The setup has been tested on a working account token; it does not claim to have proven a minimal permission set for every account configuration.

In Bash, this avoids putting the token value in shell history:

```sh
read -rs -p 'Cloudflare API token: ' CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN
```

Then:

```sh
git clone https://github.com/kevinj507/superpose.git
cd superpose
bun install --frozen-lockfile
bun run setup --account-id YOUR_ACCOUNT_ID --name YOUR_UNIQUE_WORKER_NAME
bun run smoke
bun run demo
```

Choose a lowercase deployment name of 3–40 characters, starting with a letter. The account ID is the 32-character value shown in your Cloudflare dashboard. If `CLOUDFLARE_ACCOUNT_ID` is already set, it must agree with the explicit account argument. The setup does not require this repository’s development-machine account helper.

Setup generates matching names for the Worker, Artifacts namespace, push-event target and three Workflows. It creates application admin and agent credentials, uploads them as Worker secrets and writes `.superpose/connection.json`. Everything under `.superpose/` is ignored by Git; connection and secret files are mode 0600. The Cloudflare API token is not saved there. Keep the directory to retain access and safely redeploy the same installation.

## What to expect

`smoke` creates two concurrent scripted claim holders, pushes real commits to their Artifacts forks, waits for cloud checks and lands both features. A qualified run took 67 seconds.

`demo` creates three scoped holders around a job service. It first checks a working service, then publishes a changed runtime snapshot. The platform itself detects a broken constitution article, records the code/input identity and alerts the affected worker/retry claims. CSV stays active. Its commit waits while the shared line is broken; after the scripted worker repair lands, the platform rechecks the same CSV commit and its waiting CLI completes it. A qualified run took 145 seconds and passed all 11 final product checks.

Both commands print a canvas URL and a receipt path. Each run uses a fresh graph. This is a scripted mechanism demonstration; it requires no model login and is not presented as a benchmark of model behavior. Real-agent evidence and limits are recorded separately in `docs/experiments/`.

## Troubleshooting

| Symptom | Action |
|---|---|
| Account mismatch | Use matching account ID and token; clear a stale `CLOUDFLARE_ACCOUNT_ID`. |
| API 403 | Check account scope, product access and token permissions against the failed operation. |
| Existing Worker refused | Choose a fresh name, or rerun from the original checkout with its `.superpose/deployments/<name>/` state. |
| Deployment succeeded, first check waits | First container provisioning can take several minutes. Inspect the printed graph and Cloudflare container status; rerun the demo to get a fresh graph. |
| Check failed or timed out | Read the graph’s commit/check log and local `result.json`; commands never report a missing result as a pass. |
| Private repository clone fails | Access must be granted before cloning; no Cloudflare credential grants GitHub access. |

The deployment uses paid Cloudflare resources. Idle check containers stop; Git repositories and graph state are retained for inspection. A demo failure does not erase its evidence.

## Cleanup

After inspecting a run, remove its cloud graph and Artifacts repositories:

```sh
bun run cleanup demo-THE_ID_PRINTED_BY_THE_DEMO
```

Cleanup accepts only a smoke/demo ID with a local receipt matching the selected deployment. It retains local receipts and the server installation. To remove the whole installation, remove its named Worker, Workflows, container application and Artifacts namespace in the Cloudflare dashboard after saving any wanted evidence. Do not remove the shared production installation when cleaning up your own demo.

## Real agents

The optional general runner uses an existing Claude Code login:

```sh
bun run plan scenarios/tiny --graph my-first-project
bun run agents --graph my-first-project --agents 3 --agent claude --model haiku
```

The wrappers read setup’s connection automatically. Planning uses owner credentials; the runner receives the agent key, and individual coding processes receive their claim-scoped access. Choose a new graph ID for each plan. The model calls cost credits and their behavior is not deterministic. See `runner/README.md` for larger/custom scenarios and direct API/CLI integration.

Superpose is model-independent. Our gpt-6-luna experiments used separate Codex sessions and Linux containers to isolate treatment groups; those research launchers have additional environment requirements. They are retained for reproducibility, while the basic judge quickstart deliberately needs only Bun, Git and Cloudflare credentials.
