// The Superpose graph. Edge purposes match graphtask's five so its canvas can
// render this graph unchanged:
//   assumption --required for--> claim     the claim rests on the assumption
//   claim      --required for--> claim     the second builds on the first
//   finding    --contradicts-->  assumption
//   finding    --supports-->     claim      a helpful finding (a tool, a shortcut)
//   claim      --supersedes-->   claim      an amended claim replaces its old version

export type EdgePurpose = 'required for' | 'supports' | 'contradicts' | 'related to' | 'supersedes';

export interface Edge {
  source: string;
  target: string;
  purpose: EdgePurpose;
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
  headSha?: string;
  headSeenAt?: number; // when the repo was last seen with headSha as its tip
  finishedAt?: number;
  deliveredSeq?: number; // the last event its previous holder heard, for the next one
  rebase?: boolean; // reopened: its next holder brings it up to date with the line first
  landing?: LandingState; // set once the claim is in the landing queue
  landedSha?: string; // the merge commit on the line
  status: ClaimStatus;
  lease?: Lease;
  pushes: number; // progress, used for the cost of an interrupt
  kept: KeptBranch[];
  version: number;
}

export type AssumptionStatus = 'holding' | 'contradicted';

export interface Assumption {
  id: string;
  kind: 'assumption';
  statement: string;
  status: AssumptionStatus;
}

export type FindingStatus = 'unverified' | 'verified' | 'refuted';

export interface Finding {
  id: string;
  kind: 'finding';
  statement: string;
  effect: 'contradicts' | 'helps';
  status: FindingStatus;
  finder: string; // claim id of the agent that filed it
  targets: string[]; // assumption ids (contradicts) or claim ids (helps)
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
  startedAt: number;
  finishedAt?: number;
}

export interface PushRecord {
  claim: string;
  sha: string;
  ref: string;
  before: string | null; // the previous tip, as the push reported it
  at: number;
  paths: string[]; // files this commit changes relative to the claim's base
  outside: string[]; // of those, the ones outside the declared scope
  accepted: boolean; // became the claim's head
  reason?: 'stale' | 'not-head' | 'other-branch' | 'not-claimed';
  verdict: Verdict;
  checks?: CheckRun;
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
