# Superpose

Coordination for many concurrent coding agents, built on Cloudflare Workers and Artifacts for the "Build the next Git platform" competition (October 2026).

The unit of work is a **claim**: a frozen statement of what will be true when the work is done, with a declared scope, a base commit and the assumptions it rests on. Commits are evidence for a claim, not the unit of meaning. Claims, decisions and assumptions form a graph; trees, boards and the served build are views over it.

- One Artifacts repo per claim; a write token that lives exactly as long as the claim's lease.
- Each push is checked against the claim's declared scope; overlapping claims are ordered before work starts.
- A finding that contradicts an assumption reaches only the claims that rest on it, at their next lease renewal. Unverified findings run beside the mainline as a hedge until a checker decides.
- Verdicts are keyed to the exact commit and void when it changes.
- Rejected options and stale timelines stay in the graph as data; nothing is deleted, only not selected.

Design record: graphtask main graph, run `graph-of-realities-2026-10-09` (vision 9122, synthesis 9136) and the Superpose graph.

## Status

Project shell created 2026-10-11. Code scaffold pending the concept test.
