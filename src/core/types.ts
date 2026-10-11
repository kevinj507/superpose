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
  baseSha?: string;
  headSha?: string;
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

export type EventType =
  | 'finding.filed'
  | 'finding.verified'
  | 'finding.refuted'
  | 'finding.hedge_expired'
  | 'assumption.contradicted'
  | 'claim.stale'
  | 'claim.helped'
  | 'claim.replanned'
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
