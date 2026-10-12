# Submission essays (drafts)

## What did you rethink, and why does it matter?

Git and GitHub were built for humans: one tree everyone converges on, work reviewed after it is done, and news that travels by mention. With hundreds of agents, the bottleneck is coordination: who is doing what, what each piece of work assumes, and what happens when an assumption turns out to be wrong.

Superpose replaces the pull request with a claim, opened before the work: a frozen statement of what will be true, the files it may touch, and the assumptions it rests on. Each claim gets its own Artifacts repo and a git token that lives as long as its lease. The platform, not the agent, judges every push: it reads the commit, checks it against the claim's scope, and runs the tests on that exact SHA.

Assumptions are first-class. An agent that finds one false files a finding. Unverified, it stops nobody. Verified, exactly the claims resting on it go stale. Their agents hear at their next renewal, and everyone else keeps going. With 97 live agents, all 9 affected heard within one renewal, none of the other 88 were told anything, and every push from a stale claim was refused.

The mainline becomes a choice among realities. A decision can be built two ways, and switching what is served is a pointer change, with nothing deleted.

In a real run, two Claude agents built a procedural world both ways: one random stream shared by every module, or one stream per module. Working on stable share links, an agent discovered on its own that the shared stream couples modules: forests drawing more numbers moves every town. It filed that as a finding with evidence. Once verified, only the work resting on it stopped and re-planned, and the served world switched to the other reality.

At agent scale the costly failure is not a merge conflict. It is many agents building on a premise one of them has already disproved. Superpose routes that knowledge to exactly the work it affects.

## Describe the Cloudflare products and architecture in your project.

Workers serve the API, the canvas and the served reality: the code of whichever line is live, read from Artifacts, so a reality switch changes the site at once.

Durable Objects with SQLite hold one project graph each: claims, assumptions, findings, leases, the verdict ledger and the lines. The object is the single writer. Every decision runs in one transaction, and slow work on other services happens between transactions, with compensation if it fails. It also runs the landing queue, one landing at a time per line, in dependency order.

Artifacts holds a repo per line and a fork per claim. Write tokens are minted per lease and revoked on finish; the 24-hour tokens that fork() and create() return are revoked at once, so write access only ever comes from a lease. The scope check reads commits and trees through the binding, since push events carry no file list.

Artifacts events start Workflows. A namespace-wide cf.artifacts.repo.pushed trigger starts a PushFlow for every push, even pushes by agents that never call the API. It records the scope verdict, then runs the tests. A LandFlow per landing does the merge.

Containers do the work a Worker cannot. Each check or landing gets a fresh container from a public Node image, owned by a Durable Object and given a short-lived token in its environment. It fetches exactly one commit, runs the tests, or merges into the line, re-runs the tests on the merged result and pushes only if they pass.

A typical push travels like this: git push to the claim's repo, then the event, then a Workflow step that compares trees in the Durable Object, then a container running the tests on that SHA, then the verdict. When the claim finishes, landing follows: a container merges, re-tests and pushes to the line, and a claim waiting on it becomes ready with that code in its fork.
