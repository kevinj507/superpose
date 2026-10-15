# Working with Superpose

Superpose is Kevin Joo’s Cloudflare Workers + Artifacts project. Use Bun. Commit identity: Kevin Joo <kevinj507@gmail.com>.

## Judge quickstart

Read README.md and docs/setup.md. With Bun, Git, a Workers Paid account with Artifacts/Containers access, and CLOUDFLARE_API_TOKEN supplied securely:

1. `bun install --frozen-lockfile`
2. `bun run setup --account-id <the user's account ID> --name <a fresh chosen deployment name>`
3. `bun run smoke`
4. `bun run demo`

Use the account and deployment name supplied by the user. Never print credentials or commit `.superpose/`, `.env` or `.dev.vars`. Setup generates private application credentials and all required resource names. The smoke/demo use actual Cloudflare infrastructure with scripted clients and require no model login, local Docker, BB or private graph. Report the canvas URL, receipt and whether every required check passed. A timeout is not a pass. `bun run cleanup <graph-id>` removes one locally recorded demo; it does not remove the server.

## Development

Run `bun run test` and `bun run typecheck` for engine/Worker changes. Run `bun run build:play` after changing bundled runner files. Local API tests use a fake Git host; real integration is established by smoke/demo on a deployed instance.

`src/core/` holds coordination rules. `src/graph.ts` is the Durable Object. Artifacts push events enter `src/push-flow.ts`; `src/land-flow.ts` integrates checked work; `src/checker.ts` runs Cloudflare containers. `public/` is the canvas, `runner/` the agent clients, and `scripts/` the portable setup/demo commands.

Keep a claim’s own unit checks separate from constitution checks on its combination with the shared line. A pre-existing line failure cannot establish that an unrelated claim caused it. An unverified finding stays unverified when published. Preserve exact code/input identities, prior evidence and unsuccessful experiment results. Do not present scripted behavior as model discovery or rewrite an earlier pilot after a later fix.

Use the word “constitution.” Keep verification, relevance and permission to share separate. Model calls and deployments use the user’s resources; run them only within the requested scope. The general runner’s optional live-agent path and the isolated research launchers are documented separately.
