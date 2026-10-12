# Running agents on Superpose

One command starts N coding agents on a project graph. Each takes a ready claim, works in its own clone of that claim's repository, commits, pushes and finishes. The platform checks every push against the claim's scope, runs the tests on that exact commit, and lands finished claims in dependency order.

## You need

- Node 22.18+ and git.
- For real agents: Claude Code, logged in (`claude`). No API key is needed.
- `SUPERPOSE_AGENT_KEY` to take claims, `SUPERPOSE_ADMIN_TOKEN` to set up a graph: exported, or in a file passed with `--env <file>`.

## Two commands

```sh
# Push a scenario's starter code, create its assumptions and claims
node runner/plan.mjs scenarios/tiny --graph demo-1 --env .env
# Start three agents on it
node runner/run.mjs --graph demo-1 --agents 3 --model sonnet --env .env
```

Watch at `https://superpose.kevinj507.workers.dev/g/demo-1`. Each agent has a live status line (claim, state, pushes, verdict, last step). Ctrl-C ends the agents and hands their claims back. `--agent scripted` tries the plumbing without a model. Other options: `--max-turns`, `--effort`, `--budget <usd>`, `--only <ids>`, `--once`, `--renew-every <s>` (how fast notices arrive); see `--help`. Runners on several machines can share a graph: taking a claim is atomic.

## What an agent gets

`work/<graph>/<claim>/`, a clone of the claim's repo, with:

- `CLAIM.md`: the statement to make true, the scope it may change, the assumptions it rests on, the rules.
- `.superpose/NOTICES.md`: what the platform said at each lease renewal (stale, scope touched, checked, landed).
- Git hooks: `commit-msg` adds the `Superpose-Claim: <id>` trailer; `pre-push` refuses a push while the claim is stale or outside its scope.
- The git token in repo-local config, never in the remote URL, replaced at each renewal.
- For Claude Code: new notices reach the agent right after its next step; an agent that stops without finishing is asked to finish or hand back.

Inside its copy an agent runs:

```sh
node runner/superpose.mjs status
node runner/superpose.mjs assume "<what the work relies on>"
node runner/superpose.mjs finding --contradicts <assumption id> "<what is false, with evidence>"
node runner/superpose.mjs replan --rests-on <ids> [--add-scope <patterns>]
node runner/superpose.mjs done      # push, wait for the tests on that commit, finish
node runner/superpose.mjs release "<why>"
```

When a finding is verified, exactly the claims resting on that assumption go stale; their agents hear it at the next renewal and re-plan. A stale claim nobody holds is taken over by the next free agent, which re-plans it first. Transcripts: `runs/<graph>/<claim>.jsonl`.

## Writing a scenario

`scenarios/<name>/seed/` is the starter code; declare its checks in `superpose.json` (`{"check": "npm test"}`) or a `test` script. `plan.json`:

```json
{
  "assumptions": [{ "key": "ascii", "statement": "Input text is plain ASCII." }],
  "lines": [{ "name": "unicode", "from": "main", "decision": "text", "option": "Unicode" }],
  "claims": [
    { "key": "slugify", "statement": "src/slugify.js exports slugify(text) ...",
      "scope": ["src/slugify.js", "test/slugify.test.js"], "restsOn": ["ascii"] },
    { "key": "unique", "statement": "...", "scope": ["src/unique.js"], "requires": ["slugify"], "line": "main" }
  ]
}
```

`lines` and `line` are optional: one decision built two ways. A claim that `requires` another is ready once that one has landed, so its copy contains that work.

Runner tests: `node --test runner/lib.test.mjs`.
