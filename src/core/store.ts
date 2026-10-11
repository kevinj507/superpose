import type { Edge, EdgePurpose, GraphEvent, GraphNode } from './types';

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
}

export class MemoryStore implements Store {
  private nodes = new Map<string, GraphNode>();
  private edges: Edge[] = [];
  private events: GraphEvent[] = [];
  private counters = new Map<string, number>();

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
}
