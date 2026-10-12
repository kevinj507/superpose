# Submission essays (drafts)

## What did you rethink, and why does it matter?

Git and GitHub were built for humans: one tree everyone converges on, work reviewed after it is done, and news that travels by mention. With hundreds of agents, the bottleneck is not storage or merging but coordination: who is doing what, what each piece of work assumes, and what happens when one of those assumptions turns out to be wrong.

Superpose replaces the pull request with a claim, opened before the work: a frozen statement of what will be true, the files it may touch, and the assumptions it rests on. Commits are evidence for a claim. Each claim gets its own Artifacts repo and a git token that lives exactly as long as its lease. The platform, not the agent, checks every push: it reads the commit, judges it against the claim's scope, runs the tests on that exact SHA and records a verdict keyed to it.

Assumptions are first-class. When an agent discovers that one is false, it files a finding. While unverified, it stops nobody. Once verified, exactly the claims that rest on that assumption go stale, directly or through work built on them. Their agents hear at their next lease renewal, and their pre-finding work is kept. Everyone else keeps going. With 97 live agents, all 9 affected heard within one renewal interval, none of the other 88 were told anything, and every push from a stale claim was refused.

The mainline becomes a choice among realities. A decision can be built two ways. When a finding undermines the served one, the graph shows which reality does not rest on it, and switching is a pointer change, with nothing deleted.

This matters because at agent scale the costly failure is not a merge conflict: it is fifty agents building on a premise one of them has already disproved. Superpose routes that knowledge to exactly the work it affects, as it happens.

## Describe the Cloudflare products and architecture in your project.

Workers serve the API, the canvas and the served reality: the code of whichever line is live, read from Artifacts, so a reality switch changes the site at once.

Durable Objects with SQLite hold one project graph each: claims, assumptions, findings, leases, the verdict ledger and the lines. The object is the single writer. Every decision runs in one transaction, and slow work on other services happens between transactions, with compensation if it fails. It also runs the landing queue, one landing at a time per line, in dependency order.

Artifacts holds a repo per line and a fork per claim. Write tokens are minted per lease and revoked on finish; the 24-hour tokens that fork() and create() return are revoked at once, so write access only ever comes from a lease. The scope check reads commits and trees through the binding, since push events carry no file list.

Artifacts events start Workflows. A namespace-wide cf.artifacts.repo.pushed trigger starts a PushFlow for every push, even pushes by agents that never call the API. It records the scope verdict, then runs the tests. A LandFlow per landing does the merge.

Containers do the work a Worker cannot. Each check or landing gets a fresh container from a public Node image, owned by a Durable Object and given a short-lived token in its environment. It fetches exactly one commit, runs the tests, or merges into the line, re-runs the tests on the merged result and pushes only if they pass.

A typical push travels like this: git push to the claim's repo, then the event, then a Workflow step that compares trees in the Durable Object, then a container running the tests on that SHA, then the verdict. When the claim finishes, landing follows: a container merges, re-tests and pushes to the line, and a claim waiting on it becomes ready with that code in its fork.
