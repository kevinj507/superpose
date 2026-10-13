// The Superpose graph. Edge purposes match graphtask's five so its canvas can
// render this graph unchanged:
//   assumption --required for--> claim     the claim rests on the assumption
//   claim      --required for--> claim     the second builds on the first, or
//                                          (meta.order) only waits for it because
//                                          their scopes overlap: no grounding
//   finding    --contradicts-->  assumption
//   finding    --supports-->     claim      a helpful finding (a tool, a shortcut)
//   claim      --supersedes-->   claim      an amended claim replaces its old version
// What graphtask has no field for is where a contradiction holds: Superpose
// has many realities, and "false where c2 and c3 are together" is the
// statement it exists to make. That is `where` on a finding, not an edge.

export type EdgePurpose = 'required for' | 'supports' | 'contradicts' | 'related to' | 'supersedes';

export interface Edge {
  source: string;
  target: string;
  purpose: EdgePurpose;
  // order: the source only has to land before the target (overlapping
  // scopes); doubt does not travel along it.
  meta?: { order?: true };
}

export type ClaimStatus =
  | 'open' // written by the planner, not yet claimed
  | 'claimed' // an agent holds the lease
  | 'stale' // something it rests on was contradicted; must re-plan
  | 'done' // the agent finished; awaiting landing
  | 'landed' // part of the served reality
  | 'superseded'; // replaced by an amended version

export interface Lease {
  holder: string;
  token: string;
  expiresAt: number;
  // Highest event sequence this claim's agent has been told about.
  cursor: number;
  // The git write token that lives exactly as long as this lease. Only its id
  // is kept, so it can be revoked; the secret goes to the agent and nowhere else.
  git?: { tokenId: string; expiresAt: number };
  // Tokens it replaced at renewals: left to lapse (a push may be in flight),
  // and revoked with the current one when the lease ends.
  retired?: { tokenId: string; expiresAt: number }[];
  // For a reopened claim: the read token on its line, revoked with the rest.
  lineToken?: { repo: string; tokenId: string; expiresAt: number };
}

// Getting a finished claim into its line: one at a time per line, in
// dependency order, by a real git merge with the checks run on the result.
export interface LandingState {
  status: 'queued' | 'landing' | 'conflict' | 'failed' | 'error';
  at: number;
  attempts?: number; // platform errors are retried, up to three attempts
  log?: string;
  files?: string[]; // the conflicting files, for a conflict
}

// A line is the code of one reality: a repo the claims built on it land into.
// Exactly one line is served.
export interface Line {
  name: string;
  repo?: RepoRef;
  head?: string; // the last landed merge commit
  served: boolean;
  landing?: { id: string; claim: string; sha: string; startedAt: number };
  // Where this line came from: the line it was forked from, and the landed
  // claims whose work it carries from there. A finding against any of them
  // puts this reality at risk too.
  from?: string;
  inherits?: string[];
  // The decision this line is one option of, in plain words.
  decision?: string;
  option?: string;
}

// One reality's exposure to a finding.
export interface RealityImpact {
  line: string;
  served: boolean;
  affected: string[]; // its in-flight claims that would go stale
  landedAtRisk: string[]; // landed work in it (its own or inherited) resting on the finding's target
  safe: boolean; // rests on nothing the finding contradicts: a switch candidate
}

// A repository on the git host (Artifacts in production).
export interface RepoRef {
  name: string;
  remote: string;
}

export interface KeptBranch {
  sha: string;
  reason: string; // why the work was parked, e.g. "finding f3 verified"
  at: number;
}

export interface Claim {
  id: string;
  kind: 'claim';
  cluster: string;
  statement: string;
  scope: string[]; // path patterns the claim promises to stay inside
  line: string; // the line (one reality's code) this claim builds on and lands into
  repo?: RepoRef; // the claim's own fork of its line, made when first claimed
  baseSha?: string;
  forkSha?: string; // the commit the claim's repo was forked at (baseSha moves on a reopen)
  headSha?: string;
  headSeenAt?: number; // when the repo was last seen with headSha as its tip
  finishedAt?: number;
  deliveredSeq?: number; // the last event its previous holder heard, for the next one
  rebase?: boolean; // reopened: its next holder brings it up to date with the line first
  // What the agents that worked on it spent, as their runners reported it.
  spend?: { usd: number; turns: number; runs: number; model?: string };
  landing?: LandingState; // set once the claim is in the landing queue
  landedSha?: string; // the merge commit on the line
  status: ClaimStatus;
  lease?: Lease;
  pushes: number; // progress, used for the cost of an interrupt
  kept: KeptBranch[];
  version: number;
}

export type AssumptionStatus = 'holding' | 'contradicted';

// A statement something rests on. An agent's assumption is rested on by its
// claim, through an edge. An article of the constitution is the owner's, and
// every claim on the line rests on it by rule, with no edges: it says what
// the product keeps whatever is built. An article with a `check` is run by
// the gate on every push merged with the line; one without is judged.
export interface Assumption {
  id: string;
  kind: 'assumption';
  statement: string;
  status: AssumptionStatus;
  constitution?: boolean;
  check?: string; // a command, run at the repo root, e.g. "node --test constitution/see-is-pay.test.js"
}

// resolved: the combination it was about no longer exists (the gate re-ran
// the article on a later commit and it held); kept for the record.
export type FindingStatus = 'unverified' | 'verified' | 'refuted' | 'resolved';

export interface Finding {
  id: string;
  kind: 'finding';
  statement: string;
  effect: 'contradicts' | 'helps';
  status: FindingStatus;
  finder: string; // claim id of the agent that filed it, or 'gate' for one the platform filed
  targets: string[]; // assumption ids (contradicts) or claim ids (helps)
  // Where the contradiction holds: the claims whose combination makes the
  // target false. Doubt reaches only them; the target itself still holds
  // elsewhere. Absent: the target is false everywhere.
  where?: string[];
  fingerprint: string;
  hedgeUntil: number;
}

export type GraphNode = Claim | Assumption | Finding;

// What the platform concluded about one commit of one claim. A verdict
// belongs to the exact SHA: a new commit gets its own row, and the claim's
// current verdict is the row for its head.
export type Verdict =
  | 'unverified' // in scope; no checks have passed on this commit yet
  | 'scope-violation' // the commit changes files outside the declared scope
  | 'checks-passed'
  | 'checks-failed'
  | 'verifier-failed' // the check could not run (not a judgement on the code)
  | 'budget-exhausted';

export interface CheckRun {
  // timeout: the check overran its timebox (verdict budget-exhausted);
  // skipped: the commit declares no checks (the verdict stays unverified).
  status: 'running' | 'passed' | 'failed' | 'error' | 'timeout' | 'skipped';
  command?: string;
  exitCode?: number;
  log?: string; // the tail of the output
  runner?: string; // which run owns it (a Workflow instance)
  startedAt: number;
  finishedAt?: number;
}

// The gate on combinations: the commit merged with the line as it stood, with
// the constitution's checks run on the pair. A verdict on two exact commits.
export interface PairCheck {
  status: 'running' | 'passed' | 'broken' | 'conflict' | 'error' | 'skipped';
  lineHead?: string | null; // the line commit the pair was made on
  merge?: string; // the scratch merge the checks ran on
  broken?: string[]; // article ids that failed on the pair
  partner?: string | null; // the landed claim the commit breaks the article with, when one was found
  files?: string[]; // for a conflict: the files
  log?: string;
  runner?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface PushRecord {
  claim: string;
  sha: string;
  ref: string;
  before: string | null; // the previous tip, as the push reported it
  at: number;
  paths: string[]; // files this commit changes relative to the claim's base (the first 500)
  outside: string[]; // of those, the ones outside the declared scope (the first 500)
  pathCount?: number; // when more were changed than are listed
  outsideCount?: number;
  tooLarge?: boolean; // more files changed than can be checked: it cannot land
  accepted: boolean; // became the claim's head
  reason?: 'stale' | 'not-head' | 'other-branch' | 'not-claimed';
  verdict: Verdict;
  checks?: CheckRun;
  pair?: PairCheck;
  unattributed?: string[]; // commits that do not name the claim in a trailer
}

export type EventType =
  | 'finding.filed'
  | 'finding.verified'
  | 'finding.refuted'
  | 'finding.hedge_expired'
  | 'assumption.contradicted'
  | 'claim.stale'
  | 'claim.helped'
  | 'claim.replanned'
  | 'scope.touched' // another claim's push changed files in this claim's scope
  | 'claim.checked' // checks finished on one of the claim's commits
  | 'claim.pair_checked' // the constitution ran on one of the claim's commits merged with the line
  | 'reality.restored' // a gate finding no longer holds: the combination it was about is gone
  | 'claim.ordered' // planned after an unfinished claim whose scope overlaps it
  | 'claim.landed' // merged into its line, checks passing on the merged result
  | 'claim.landing_failed' // a conflict or failing checks on the merged result: needs a decision
  | 'reality.served' // a different line is now the served reality
  | 'reality.at_risk';

export interface GraphEvent {
  seq: number;
  at: number;
  type: EventType;
  // Claims this event concerns; renewal replies are filtered on it.
  claims: string[];
  data: Record<string, unknown>;
}

export interface Notice {
  seq: number;
  type: EventType;
  data: Record<string, unknown>;
}
