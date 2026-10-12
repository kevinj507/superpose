import type { Store } from './core/store';
import type { Edge, EdgePurpose, GraphEvent, GraphNode, Line, PushRecord } from './core/types';

// The engine's Store on a Durable Object's SQLite database. SQLite calls in a
// Durable Object are synchronous, so the engine runs unchanged.
export class SqlStore implements Store {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, json TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS edges (
      source TEXT NOT NULL, target TEXT NOT NULL, purpose TEXT NOT NULL,
      PRIMARY KEY (source, target, purpose))`);
    sql.exec(`CREATE INDEX IF NOT EXISTS edges_target ON edges (target)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL,
      claims TEXT NOT NULL, data TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS counters (prefix TEXT PRIMARY KEY, n INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS ledger (
      claim TEXT NOT NULL, sha TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY (claim, sha))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS lines (name TEXT PRIMARY KEY, json TEXT NOT NULL)`);
  }

  getNode(id: string): GraphNode | undefined {
    const row = this.sql.exec<{ json: string }>(`SELECT json FROM nodes WHERE id = ?`, id).toArray()[0];
    return row ? (JSON.parse(row.json) as GraphNode) : undefined;
  }

  putNode(node: GraphNode): void {
    this.sql.exec(
      `INSERT INTO nodes (id, kind, json) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, json = excluded.json`,
      node.id,
      node.kind,
      JSON.stringify(node),
    );
  }

  allNodes(): GraphNode[] {
    return this.sql
      .exec<{ json: string }>(`SELECT json FROM nodes ORDER BY rowid`)
      .toArray()
      .map((r) => JSON.parse(r.json) as GraphNode);
  }

  addEdge(edge: Edge): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO edges (source, target, purpose) VALUES (?, ?, ?)`,
      edge.source,
      edge.target,
      edge.purpose,
    );
  }

  removeEdge(edge: Edge): void {
    this.sql.exec(
      `DELETE FROM edges WHERE source = ? AND target = ? AND purpose = ?`,
      edge.source,
      edge.target,
      edge.purpose,
    );
  }

  edgesFrom(id: string, purpose?: EdgePurpose): Edge[] {
    return purpose
      ? this.edgeRows(`SELECT source, target, purpose FROM edges WHERE source = ? AND purpose = ?`, id, purpose)
      : this.edgeRows(`SELECT source, target, purpose FROM edges WHERE source = ?`, id);
  }

  edgesTo(id: string, purpose?: EdgePurpose): Edge[] {
    return purpose
      ? this.edgeRows(`SELECT source, target, purpose FROM edges WHERE target = ? AND purpose = ?`, id, purpose)
      : this.edgeRows(`SELECT source, target, purpose FROM edges WHERE target = ?`, id);
  }

  allEdges(): Edge[] {
    return this.edgeRows(`SELECT source, target, purpose FROM edges ORDER BY rowid`);
  }

  appendEvent(event: Omit<GraphEvent, 'seq'>): GraphEvent {
    const row = this.sql
      .exec<{ seq: number }>(
        `INSERT INTO events (at, type, claims, data) VALUES (?, ?, ?, ?) RETURNING seq`,
        event.at,
        event.type,
        JSON.stringify(event.claims),
        JSON.stringify(event.data),
      )
      .one();
    return { ...event, seq: row.seq };
  }

  eventsSince(seq: number): GraphEvent[] {
    return this.sql
      .exec<{ seq: number; at: number; type: string; claims: string; data: string }>(
        `SELECT seq, at, type, claims, data FROM events WHERE seq > ? ORDER BY seq`,
        seq,
      )
      .toArray()
      .map((r) => ({
        seq: r.seq,
        at: r.at,
        type: r.type as GraphEvent['type'],
        claims: JSON.parse(r.claims) as string[],
        data: JSON.parse(r.data) as Record<string, unknown>,
      }));
  }

  lastSeq(): number {
    return this.sql.exec<{ seq: number }>(`SELECT COALESCE(MAX(seq), 0) AS seq FROM events`).one().seq;
  }

  nextId(prefix: string): string {
    const row = this.sql
      .exec<{ n: number }>(
        `INSERT INTO counters (prefix, n) VALUES (?, 1)
         ON CONFLICT (prefix) DO UPDATE SET n = n + 1 RETURNING n`,
        prefix,
      )
      .one();
    return `${prefix}${row.n}`;
  }

  getPush(claim: string, sha: string): PushRecord | undefined {
    const row = this.sql
      .exec<{ json: string }>(`SELECT json FROM ledger WHERE claim = ? AND sha = ?`, claim, sha)
      .toArray()[0];
    return row ? (JSON.parse(row.json) as PushRecord) : undefined;
  }

  putPush(row: PushRecord): void {
    this.sql.exec(
      `INSERT INTO ledger (claim, sha, at, json) VALUES (?, ?, ?, ?)
       ON CONFLICT (claim, sha) DO UPDATE SET json = excluded.json`,
      row.claim,
      row.sha,
      row.at,
      JSON.stringify(row),
    );
  }

  pushes(claim?: string): PushRecord[] {
    const rows = claim
      ? this.sql.exec<{ json: string }>(`SELECT json FROM ledger WHERE claim = ? ORDER BY at, rowid`, claim)
      : this.sql.exec<{ json: string }>(`SELECT json FROM ledger ORDER BY at, rowid`);
    return rows.toArray().map((r) => JSON.parse(r.json) as PushRecord);
  }

  getLine(name: string): Line | undefined {
    const row = this.sql.exec<{ json: string }>(`SELECT json FROM lines WHERE name = ?`, name).toArray()[0];
    return row ? (JSON.parse(row.json) as Line) : undefined;
  }

  putLine(line: Line): void {
    this.sql.exec(
      `INSERT INTO lines (name, json) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET json = excluded.json`,
      line.name,
      JSON.stringify(line),
    );
  }

  lines(): Line[] {
    return this.sql
      .exec<{ json: string }>(`SELECT json FROM lines ORDER BY rowid`)
      .toArray()
      .map((r) => JSON.parse(r.json) as Line);
  }

  private edgeRows(query: string, ...bindings: string[]): Edge[] {
    return this.sql
      .exec<{ source: string; target: string; purpose: string }>(query, ...bindings)
      .toArray()
      .map((r) => ({ source: r.source, target: r.target, purpose: r.purpose as EdgePurpose }));
  }
}
