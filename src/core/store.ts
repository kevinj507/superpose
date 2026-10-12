import type { Edge, EdgePurpose, GraphEvent, GraphNode, Line, PushRecord } from './types';

// Storage the engine runs on. MemoryStore backs the tests; the Durable Object
// implements the same interface on its SQLite database.
export interface Store {
  getNode(id: string): GraphNode | undefined;
  putNode(node: GraphNode): void;
  allNodes(): GraphNode[];
  addEdge(edge: Edge): void;
  removeEdge(edge: Edge): void;
  edgesFrom(id: string, purpose?: EdgePurpose): Edge[];
  edgesTo(id: string, purpose?: EdgePurpose): Edge[];
  appendEvent(event: Omit<GraphEvent, 'seq'>): GraphEvent;
  eventsSince(seq: number): GraphEvent[];
  lastSeq(): number;
  nextId(prefix: string): string;
  // The verdict ledger: one row per (claim, commit).
  getPush(claim: string, sha: string): PushRecord | undefined;
  putPush(row: PushRecord): void;
  pushes(claim?: string): PushRecord[];
  getLine(name: string): Line | undefined;
  putLine(line: Line): void;
  lines(): Line[];
}

export class MemoryStore implements Store {
  private nodes = new Map<string, GraphNode>();
  private edges: Edge[] = [];
  private events: GraphEvent[] = [];
  private counters = new Map<string, number>();
  private ledger = new Map<string, PushRecord>();
  private lineMap = new Map<string, Line>();

  getNode(id: string) {
    const node = this.nodes.get(id);
    return node ? structuredClone(node) : undefined;
  }

  putNode(node: GraphNode) {
    this.nodes.set(node.id, structuredClone(node));
  }

  allNodes() {
    return [...this.nodes.values()].map((n) => structuredClone(n));
  }

  addEdge(edge: Edge) {
    const exists = this.edges.some(
      (e) => e.source === edge.source && e.target === edge.target && e.purpose === edge.purpose,
    );
    if (!exists) this.edges.push({ ...edge });
  }

  removeEdge(edge: Edge) {
    this.edges = this.edges.filter(
      (e) => !(e.source === edge.source && e.target === edge.target && e.purpose === edge.purpose),
    );
  }

  edgesFrom(id: string, purpose?: EdgePurpose) {
    return this.edges.filter((e) => e.source === id && (!purpose || e.purpose === purpose));
  }

  edgesTo(id: string, purpose?: EdgePurpose) {
    return this.edges.filter((e) => e.target === id && (!purpose || e.purpose === purpose));
  }

  appendEvent(event: Omit<GraphEvent, 'seq'>) {
    const full = { ...event, seq: this.events.length + 1 };
    this.events.push(full);
    return full;
  }

  eventsSince(seq: number) {
    return this.events.filter((e) => e.seq > seq);
  }

  lastSeq() {
    return this.events.length;
  }

  nextId(prefix: string) {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}${n}`;
  }

  getPush(claim: string, sha: string) {
    const row = this.ledger.get(`${claim} ${sha}`);
    return row ? structuredClone(row) : undefined;
  }

  putPush(row: PushRecord) {
    this.ledger.set(`${row.claim} ${row.sha}`, structuredClone(row));
  }

  pushes(claim?: string) {
    return [...this.ledger.values()].filter((r) => !claim || r.claim === claim).map((r) => structuredClone(r));
  }

  getLine(name: string) {
    const line = this.lineMap.get(name);
    return line ? structuredClone(line) : undefined;
  }

  putLine(line: Line) {
    this.lineMap.set(line.name, structuredClone(line));
  }

  lines() {
    return [...this.lineMap.values()].map((l) => structuredClone(l));
  }
}
