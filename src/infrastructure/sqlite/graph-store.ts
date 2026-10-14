import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GraphNode, GraphSnapshot, Workspace } from '../../domain/graph.js';
export type SyncRun = { id: string; workspaceId?: string; status: 'running' | 'succeeded' | 'failed'; message: string; startedAt: string; completedAt?: string };

export class GraphStore {
  private db: Database.Database;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS generations (id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, node_count INTEGER NOT NULL, edge_count INTEGER NOT NULL, FOREIGN KEY(workspace_id) REFERENCES workspaces(id));
      CREATE TABLE IF NOT EXISTS active_generations (workspace_id TEXT PRIMARY KEY, generation_id INTEGER NOT NULL, FOREIGN KEY(generation_id) REFERENCES generations(id));
      CREATE TABLE IF NOT EXISTS nodes (generation_id INTEGER NOT NULL, id TEXT NOT NULL, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, properties_json TEXT NOT NULL, evidence_json TEXT NOT NULL, PRIMARY KEY(generation_id, id));
      CREATE TABLE IF NOT EXISTS edges (generation_id INTEGER NOT NULL, id TEXT NOT NULL, workspace_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL, kind TEXT NOT NULL, properties_json TEXT NOT NULL, PRIMARY KEY(generation_id, id));
      CREATE TABLE IF NOT EXISTS sync_runs (id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT NOT NULL, message TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT);
    `);
  }
  close() { this.db.close(); }
  private workspace(row: any): Workspace { return { id: row.id, path: row.path, name: row.name }; }
  workspaces(): Workspace[] { return (this.db.prepare('SELECT id,path,name FROM workspaces ORDER BY name').all() as any[]).map((r) => this.workspace(r)); }
  activeWorkspacePaths() { return this.workspaces().map((w) => w.path); }
  getWorkspace(id: string) { const r = this.db.prepare('SELECT id,path,name FROM workspaces WHERE id=?').get(id) as any; return r ? this.workspace(r) : undefined; }
  startRun(id: string, workspaceId?: string) { this.db.prepare('INSERT INTO sync_runs(id,workspace_id,status,message,started_at) VALUES(?,?,\'running\',\'Sync started\',?)').run(id, workspaceId ?? null, new Date().toISOString()); }
  finishRun(id: string, status: 'succeeded' | 'failed', message: string) { this.db.prepare('UPDATE sync_runs SET status=?,message=?,completed_at=? WHERE id=?').run(status, message, new Date().toISOString(), id); }
  run(id: string): SyncRun | undefined { return this.db.prepare('SELECT id,workspace_id as workspaceId,status,message,started_at as startedAt,completed_at as completedAt FROM sync_runs WHERE id=?').get(id) as SyncRun | undefined; }
  activate(snapshot: GraphSnapshot) {
    this.activateAll([snapshot]);
  }
  activateAll(snapshots: GraphSnapshot[]) {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const insertNode = this.db.prepare('INSERT INTO nodes(generation_id,id,workspace_id,kind,label,properties_json,evidence_json) VALUES(?,?,?,?,?,?,?)');
      const insertEdge = this.db.prepare('INSERT INTO edges(generation_id,id,workspace_id,source_id,target_id,kind,properties_json) VALUES(?,?,?,?,?,?,?)');
      const activate = this.db.prepare('INSERT INTO active_generations(workspace_id,generation_id) VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET generation_id=excluded.generation_id');
      for (const snapshot of snapshots) {
        this.db.prepare('INSERT INTO workspaces(id,path,name,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,name=excluded.name').run(snapshot.workspace.id, snapshot.workspace.path, snapshot.workspace.name, now);
        const result = this.db.prepare('INSERT INTO generations(workspace_id,source,created_at,node_count,edge_count) VALUES(?,?,?,?,?)').run(snapshot.workspace.id, snapshot.source, now, snapshot.nodes.length, snapshot.edges.length);
        const generation = Number(result.lastInsertRowid);
        for (const n of snapshot.nodes) insertNode.run(generation, n.id, n.workspaceId, n.kind, n.label, JSON.stringify(n.properties), JSON.stringify(n.evidence ?? []));
        for (const e of snapshot.edges) insertEdge.run(generation, e.id, e.workspaceId, e.sourceId, e.targetId, e.kind, JSON.stringify(e.properties));
        activate.run(snapshot.workspace.id, generation);
      }
    });
    tx();
  }
  graph(workspaceId?: string, limit = 500) {
    const params = workspaceId ? [workspaceId, limit] : [limit];
    const where = workspaceId ? 'WHERE a.workspace_id=?' : '';
    const nodes = this.db.prepare(`SELECT n.* FROM active_generations a JOIN nodes n ON n.generation_id=a.generation_id ${where} ORDER BY n.label LIMIT ?`).all(...params) as any[];
    const allowed = new Set(nodes.map((n) => n.id));
    const edgeParams = workspaceId ? [workspaceId] : [];
    const edges = (this.db.prepare(`SELECT e.* FROM active_generations a JOIN edges e ON e.generation_id=a.generation_id ${where}`).all(...edgeParams) as any[]).filter((e) => allowed.has(e.source_id) && allowed.has(e.target_id));
    return { nodes: nodes.map(parseNode), edges: edges.map(parseEdge) };
  }
  node(nodeId: string): GraphNode | undefined {
    const row = this.db.prepare('SELECT n.* FROM active_generations a JOIN nodes n ON n.generation_id=a.generation_id WHERE n.id=? LIMIT 1').get(nodeId) as any;
    return row ? parseNode(row) : undefined;
  }
  status() { return this.db.prepare('SELECT COUNT(*) as workspaces, COALESCE(SUM(g.node_count),0) as nodes, COALESCE(SUM(g.edge_count),0) as edges FROM active_generations a JOIN generations g ON g.id=a.generation_id').get(); }
}
function parseNode(r: any): GraphNode { return { id:r.id, workspaceId:r.workspace_id, kind:r.kind, label:r.label, properties:JSON.parse(r.properties_json), evidence:JSON.parse(r.evidence_json) }; }
function parseEdge(r: any) { return { id:r.id, workspaceId:r.workspace_id, sourceId:r.source_id, targetId:r.target_id, kind:r.kind, properties:JSON.parse(r.properties_json) }; }
