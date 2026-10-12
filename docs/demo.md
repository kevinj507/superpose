# Recording the demo

A runbook for the 5–10 minute video. Every scene below has been run live with real agents (graph `world-rehearsal-0212`), so there is a recorded fallback for each.

## Before you record

- Use a 1920×1080 screen with the browser full-screen; press `E` on the canvas to hide the event panel if the cards get small.
- Use agents that can run 3–5 at once. This development box sustains 2. Use a second machine with Claude Code logged in, running another `run.mjs` against the same graph; taking a claim is atomic.
- Keep secrets off screen. Paste the admin token into the canvas off camera, and never show `.env` or a terminal with tokens. No GitHub logos.
- Plan a fresh graph (about 10 s):

```sh
node runner/plan.mjs scenarios/world --graph demo --env /data/workspace/.wafer/session.env
```

## Scenes

1. **The screen that makes many agents legible (0:00–1:00).** Open `https://superpose.kevinj507.workers.dev/g/demo`. Start agents on screen:

   ```sh
   node runner/run.mjs --graph demo --agents 3 --model sonnet --renew-every 10 --env <file>
   ```

   Claims turn orange as agents take them, lease countdowns tick, and verdicts appear as pushes are checked in containers.
2. **A claim instead of a pull request.** Click a claim. The inspector shows its statement, scope, the assumptions it rests on, its repo, and the ledger: each commit, the files it changed, and the verdict on that exact SHA. Point out that the agent only used git.
3. **Landing.** Watch a claim go done, then landed, and a claim that builds on it become ready. Its fork already contains the work. Open `/served/demo/` and the world fills in module by module.
4. **The finding.** On line `main`, the agent building stable world links discovers that the shared random stream couples modules, and files a finding with evidence. In the rehearsal it came about 15 minutes in. To force it at a chosen moment, file it yourself from that agent's working copy with `node runner/superpose.mjs finding --contradicts a1 "<text>"`.
   - Click the finding. It is dashed, a hedge that stops nobody. As admin, choose **Verify**: the inline step shows the cost first, which claims would stop and which reality is safe.
   - Confirm. The pulse runs down from the assumption, and only the claims resting on it turn stale. Cards say "learns at renewal", then "agent told".
   - In the terminal, that agent prints `STALE` and re-plans; everyone else keeps going.
5. **The numbers.** Cut to `sim/report-2026-10-12.json`, or say: with 97 live agents, every affected agent heard within one renewal interval (at most 14 s), none of the other 88 heard anything, and every push from a stale claim was refused.
6. **Realities.** The strip at the top shows the decision, "How do modules get their randomness?", with both options built. As admin, choose **Serve this reality** on `own-streams`. Reload `/served/demo/`: the world for the same seed is now built with a stream per module. The old reality is still there.
7. **How it is built (8:00–9:00).** One sentence per product, using the table in the README: Workers, Durable Objects, Artifacts, Artifacts events to Workflows, and Containers.
8. **Ease of use.** Two commands, `plan.mjs` and `run.mjs`. Agents need nothing but git, and anyone can watch at the hosted URL.

## If something goes wrong on camera

- **The finding does not come by itself:** file it from the agent's copy as in scene 4.
- **A landing sticks** (the line shows a landing for minutes): as admin, choose **Give up on this landing** on the line. It is retried at once.
- **Fallback footage:** `world-rehearsal-0212` holds a complete run. Its canvas shows the verified finding, the stale and re-planned claims, both lines fully landed and `own-streams` served. Screenshots are in `.research/superpose-build/rehearsal-world-2026-10-12/`.
