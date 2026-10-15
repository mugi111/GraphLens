import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AnalysisError, type AnalysisDiagnostic, type AnalysisEvidence, type AnalysisInputGeneration, type AnalysisResult, type AnalyzerDescriptor, type ArchitectureInputProvider, type ArchitectureInputSnapshot } from '../../domain/analyzer.js';
import type { Evidence, GraphEdge, GraphNode, GraphSnapshot, Workspace } from '../../domain/graph.js';
import type { GraphLensPluginManifest, PluginInventoryItem } from '../../domain/plugin.js';
import type { CrossWorkspaceSnapshot, WorkspaceArchitectureSnapshot } from '../../domain/federation.js';
import { analysisGenerationInputsMigration, analyzerOwnedGenerationsMigration, analyzerRunLifecycleMigration, legacySchemaMigration, pluginInstallationIdentityMigration, pluginPackageOwnershipMigration, runMigrations } from './migrations.js';
export type SyncRun = { id: string; workspaceId?: string; status: 'running' | 'succeeded' | 'failed'; message: string; startedAt: string; completedAt?: string };
export type AnalysisRun = { id: string; workspaceId: string; analyzerId: string; analyzerVersion: string; apiVersion: string; status: 'running' | 'succeeded' | 'failed'; sourceRevision?: string; config: Record<string, unknown>; startedAt: string; completedAt?: string; errorCode?: string; errorMessage?: string; diagnosticCount: number };
export type StoredAnalysisDiagnostic = AnalysisDiagnostic & { sequence: number; generationId?: number };
export type DatabaseSchemaSnapshot = {
  workspace: { id: string; name: string };
  analysis: { analyzerId: string; analyzerVersion: string; generationId: number; runId: string; sourceRevision?: string; completedAt: string };
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: AnalysisEvidence[];
  diagnostics: StoredAnalysisDiagnostic[];
};
export type StoredPlugin = GraphLensPluginManifest & { packageName: string; packagePath: string; enabled: boolean; analyzerIds: string[]; installedAt: string; installationId?: string; lockHash?: string; errorCode?: string };

export class GraphStore implements ArchitectureInputProvider {
  private db: Database.Database;
  constructor(file: string, options: { recoverInterruptedRuns?: boolean; readOnly?: boolean } = {}) {
    if (options.readOnly) {
      this.db = new Database(file, { readonly: true, fileMustExist: true });
      try { this.assertReadOnlySchema(); }
      catch (error) { this.db.close(); throw error; }
    } else {
      mkdirSync(dirname(file), { recursive: true });
      this.db = new Database(file);
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('journal_mode = WAL');
      runMigrations(this.db, [legacySchemaMigration, analyzerOwnedGenerationsMigration, analyzerRunLifecycleMigration, pluginPackageOwnershipMigration, pluginInstallationIdentityMigration, analysisGenerationInputsMigration]);
      if (options.recoverInterruptedRuns !== false) this.interruptResidualAnalysisRuns();
    }
  }
  close() { this.db.close(); }
  private assertReadOnlySchema(): void {
    const versions = this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    const applied = new Set(versions.map(({ version }) => version));
    if (versions.some(({ version }) => version > 6) || [1, 2, 3, 4, 5, 6].some((version) => !applied.has(version))) {
      throw new Error('Database schema is not initialized or is incompatible with this GraphLens version.');
    }
    const required: Record<string, string[]> = {
      workspaces: ['id', 'path', 'name'],
      active_analysis_generations: ['workspace_id', 'analyzer_id', 'generation_id'],
      analysis_generations: ['id', 'run_id', 'workspace_id', 'analyzer_id'],
      analysis_runs: ['id', 'workspace_id', 'analyzer_id', 'source_revision', 'completed_at'],
      node_contributions: ['generation_id', 'id', 'workspace_id', 'kind', 'label', 'properties_json'],
      edge_contributions: ['generation_id', 'id', 'workspace_id', 'source_id', 'target_id', 'kind', 'properties_json'],
      evidence: ['generation_id', 'id', 'subject_kind', 'subject_id', 'level', 'payload_json'],
      diagnostics: ['run_id', 'generation_id', 'sequence', 'code', 'severity', 'message', 'uri', 'line', 'detail_json'],
      analysis_generation_inputs: ['generation_id', 'input_analyzer_id', 'input_generation_id'],
    };
    for (const [table, columns] of Object.entries(required)) {
      const actual = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name));
      if (columns.some((column) => !actual.has(column))) throw new Error('Database schema is not initialized or is incompatible with this GraphLens version.');
    }
  }
  private workspace(row: any): Workspace { return { id: row.id, path: row.path, name: row.name }; }
  workspaces(): Workspace[] { return (this.db.prepare('SELECT id,path,name FROM workspaces ORDER BY name').all() as any[]).map((r) => this.workspace(r)); }
  activeWorkspacePaths() { return this.workspaces().map((w) => w.path); }
  getWorkspace(id: string) { const r = this.db.prepare('SELECT id,path,name FROM workspaces WHERE id=?').get(id) as any; return r ? this.workspace(r) : undefined; }
  ensureWorkspaces(workspaces: Workspace[]) { const now = new Date().toISOString(); const insert = this.db.prepare('INSERT INTO workspaces(id,path,name,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,name=excluded.name'); const tx = this.db.transaction(() => workspaces.forEach((workspace) => insert.run(workspace.id, workspace.path, workspace.name, now))); tx(); }
  startRun(id: string, workspaceId?: string) { this.db.prepare('INSERT INTO sync_runs(id,workspace_id,status,message,started_at) VALUES(?,?,\'running\',\'Sync started\',?)').run(id, workspaceId ?? null, new Date().toISOString()); }
  finishRun(id: string, status: 'succeeded' | 'failed', message: string) { this.db.prepare('UPDATE sync_runs SET status=?,message=?,completed_at=? WHERE id=?').run(status, message, new Date().toISOString(), id); }
  run(id: string): SyncRun | undefined { return this.db.prepare('SELECT id,workspace_id as workspaceId,status,message,started_at as startedAt,completed_at as completedAt FROM sync_runs WHERE id=?').get(id) as SyncRun | undefined; }
  activate(snapshot: GraphSnapshot) {
    this.activateAll([snapshot]);
  }
  activateAll(snapshots: GraphSnapshot[]) {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const start = this.db.prepare('INSERT INTO analysis_runs(id,workspace_id,analyzer_id,analyzer_version,status,source_revision,config_json,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?)');
      const generation = this.db.prepare('INSERT INTO analysis_generations(run_id,workspace_id,analyzer_id,created_at,node_count,edge_count) VALUES(?,?,?,?,?,?)');
      const insertNode = this.db.prepare('INSERT INTO node_contributions(generation_id,id,workspace_id,kind,label,properties_json) VALUES(?,?,?,?,?,?)');
      const insertEdge = this.db.prepare('INSERT INTO edge_contributions(generation_id,id,workspace_id,source_id,target_id,kind,properties_json) VALUES(?,?,?,?,?,?,?)');
      const insertEvidence = this.db.prepare('INSERT INTO evidence(id,generation_id,subject_kind,subject_id,level,payload_json) VALUES(?,?,?,?,?,?)');
      for (const snapshot of snapshots) {
        this.db.prepare('INSERT INTO workspaces(id,path,name,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,name=excluded.name').run(snapshot.workspace.id, snapshot.workspace.path, snapshot.workspace.name, now);
        const analyzerId = snapshot.source === 'demo' ? 'builtin.demo' : 'builtin.codegraph';
        const runId = randomUUID();
        start.run(runId, snapshot.workspace.id, analyzerId, '1.0.0', 'succeeded', null, '{}', now, now);
        const result = generation.run(runId, snapshot.workspace.id, analyzerId, now, snapshot.nodes.length, snapshot.edges.length);
        const generationId = Number(result.lastInsertRowid);
        for (const n of snapshot.nodes) {
          insertNode.run(generationId, n.id, n.workspaceId, n.kind, n.label, JSON.stringify(n.properties));
          for (const [index, evidence] of (n.evidence ?? []).entries()) {
            assertEvidence(evidence);
            insertEvidence.run(evidenceId(snapshot.workspace.id, analyzerId, 'node', n.id, evidence, index), generationId, 'node', n.id, evidence.level ?? 'DIRECT', JSON.stringify(evidence));
          }
        }
        for (const e of snapshot.edges) {
          insertEdge.run(generationId, e.id, e.workspaceId, e.sourceId, e.targetId, e.kind, JSON.stringify(e.properties));
          for (const [index, evidence] of (e.evidence ?? []).entries()) {
            assertEvidence(evidence);
            insertEvidence.run(evidenceId(snapshot.workspace.id, analyzerId, 'edge', e.id, evidence, index), generationId, 'edge', e.id, evidence.level ?? 'DIRECT', JSON.stringify(evidence));
          }
        }
        this.activateAnalysisGeneration(snapshot.workspace.id, analyzerId, generationId);
      }
    });
    tx();
  }
  graph(workspaceId?: string, limit = 500) {
    const params = workspaceId ? [workspaceId, limit] : [limit];
    const where = workspaceId ? 'WHERE a.workspace_id=?' : '';
    const nodes = this.db.prepare(`${projectedNodesSql(where)} ORDER BY label LIMIT ?`).all(...params) as any[];
    const allowed = new Set(nodes.map((n) => n.id));
    const edgeParams = workspaceId ? [workspaceId] : [];
    const edges = (this.db.prepare(`${projectedEdgesSql(where)}`).all(...edgeParams) as any[]).filter((e) => allowed.has(e.source_id) && allowed.has(e.target_id));
    return { nodes: nodes.map((node) => this.parseContributionNode(node)), edges: edges.map((edge) => this.parseContributionEdge(edge)) };
  }
  workspaceGraphPage(query: import('../../application/workspace-query-service.js').WorkspaceGraphQuery, cursor?: { offset?: number; snapshot?: string }) {
    const read = this.db.transaction((input: typeof query, pageCursor?: typeof cursor) => {
      const ids = input.workspaces; const placeholders = ids.map(() => '?').join(',');
      const workspaceRows = this.db.prepare(`SELECT id,name FROM workspaces WHERE id IN (${placeholders}) ORDER BY id`).all(...ids) as Array<{ id: string; name: string }>;
      const known = new Set(workspaceRows.map((item) => item.id));
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length) throw new Error(`WORKSPACE_NOT_FOUND:${missing.join(',')}`);
      const active = this.db.prepare(`SELECT a.workspace_id,a.analyzer_id,a.generation_id FROM active_analysis_generations a WHERE a.workspace_id IN (${placeholders}) ORDER BY a.workspace_id,a.analyzer_id`).all(...ids) as Array<{ workspace_id: string; analyzer_id: string; generation_id: number }>;
      const generations = active.map((item) => ({ workspaceId: item.workspace_id, analyzerId: item.analyzer_id, generationId: Number(item.generation_id) }));
      const snapshotId = createHash('sha256').update(JSON.stringify({ workspaces: workspaceRows.map(({ id }) => id), generations })).digest('base64url');
      if ((input.snapshot !== undefined && input.snapshot !== snapshotId) || (pageCursor?.snapshot !== undefined && pageCursor.snapshot !== snapshotId)) throw new Error('WORKSPACE_GRAPH_SNAPSHOT_CHANGED');
      const whereNode = `WHERE a.workspace_id IN (${placeholders})`;
      const nodeQueryBase = projectedNodesSql(whereNode, false);
      const edgeQueryBase = projectedEdgesSql(whereNode, false);
      let rows: any[] = []; let edgeRows: any[] = []; let hasMore = false; let nextOffset: number | undefined; let cursorValid = true;
      const offset = pageCursor?.offset ?? 0;
      if (input.mode === 'roots' || input.mode === 'search') {
        const filters: string[] = [];
        const args: unknown[] = [...ids];
        if (input.kind) { filters.push('p.kind=?'); args.push(input.kind); }
        if (input.mode === 'search') { filters.push("p.label LIKE ? ESCAPE '\\'"); args.push(`%${escapeLike(input.q!)}%`); }
        if (input.mode === 'roots') {
          filters.push(`NOT EXISTS (SELECT 1 FROM (${edgeQueryBase}) pe JOIN (${nodeQueryBase}) src ON src.workspace_id=pe.workspace_id AND src.id=pe.source_id WHERE pe.workspace_id=p.workspace_id AND pe.kind='contains' AND pe.target_id=p.id)`);
          args.push(...ids, ...ids);
        }
        const filtered = `SELECT * FROM (${nodeQueryBase}) p ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}`;
        rows = this.db.prepare(`${filtered} ORDER BY p.workspace_id,p.label,p.id LIMIT ? OFFSET ?`).all(...args, input.limit + 1, offset) as any[];
        hasMore = rows.length > input.limit; rows = rows.slice(0, input.limit);
        cursorValid = offset === 0 || rows.length > 0;
        if (hasMore) nextOffset = offset + rows.length;
      } else {
        const targetNode = this.db.prepare(`SELECT * FROM (${nodeQueryBase}) p WHERE p.id=? LIMIT 1`).get(...ids, input.node) as any;
        if (!targetNode) throw new Error('WORKSPACE_GRAPH_NODE_NOT_FOUND');
        const clauses = input.mode === 'children' ? "e.source_id=? AND e.kind='contains'" : input.direction === 'outgoing' ? 'e.source_id=?' : input.direction === 'incoming' ? 'e.target_id=?' : '(e.source_id=? OR e.target_id=?)';
        const edgeArgs: unknown[] = [...ids, ...(input.direction === 'both' && input.mode === 'neighbors' ? [input.node, input.node] : [input.node])];
        const edgeQuery = `SELECT * FROM (${edgeQueryBase}) p WHERE ${clauses.replaceAll('e.', 'p.')}`;
        edgeRows = this.db.prepare(`${edgeQuery} ORDER BY p.id LIMIT ? OFFSET ?`).all(...edgeArgs, input.limit + 1, offset) as any[];
        hasMore = edgeRows.length > input.limit; edgeRows = edgeRows.slice(0, input.limit); cursorValid = offset === 0 || edgeRows.length > 0; if (hasMore) nextOffset = offset + edgeRows.length;
        const endpointIds = [...new Set([input.node, ...edgeRows.flatMap((edge) => [edge.source_id, edge.target_id])])];
        if (endpointIds.length > 250) throw new Error('WORKSPACE_GRAPH_LIMIT_EXCEEDED');
        const ep = endpointIds.map(() => '?').join(',');
        rows = endpointIds.length ? this.db.prepare(`SELECT * FROM (${nodeQueryBase}) p WHERE p.id IN (${ep}) ORDER BY p.workspace_id,p.label,p.id LIMIT 251`).all(...ids, ...endpointIds) as any[] : [targetNode];
      }
      if (rows.length > 250 || edgeRows.length > 200) throw new Error('WORKSPACE_GRAPH_LIMIT_EXCEEDED');
      const nodeIds = rows.map((item) => item.id); const edgeIds = edgeRows.map((item) => item.id);
      const subjectTerms = [...nodeIds.map((id) => ['node', id] as const), ...edgeIds.map((id) => ['edge', id] as const)];
      const evidenceItems: any[] = [];
      const evidenceCounts = new Map<string, number>();
      let evidenceBytes = 0;
      if (subjectTerms.length) {
        for (const [subjectKind, subjectId] of subjectTerms) {
          const node = subjectKind === 'node' ? rows.find((row) => row.id === subjectId) : undefined;
          const edge = subjectKind === 'edge' ? edgeRows.find((row) => row.id === subjectId) : undefined;
          const contribution = node ?? edge;
          if (input.includeEvidence) {
            const found = this.db.prepare('SELECT id,generation_id,subject_kind,subject_id,level,length(CAST(payload_json AS BLOB)) AS payload_bytes FROM evidence WHERE generation_id=? AND subject_kind=? AND subject_id=? ORDER BY id LIMIT 1001').all(contribution.generation_id, subjectKind, subjectId) as any[];
            evidenceCounts.set(`${subjectKind}:${subjectId}`, found.length);
            evidenceBytes += found.reduce((sum, item) => sum + Number(item.payload_bytes), 0);
            if (evidenceBytes > 1_048_576) throw new Error('WORKSPACE_GRAPH_LIMIT_EXCEEDED');
            evidenceItems.push(...found.map((item) => {
              const payloadRow = this.db.prepare('SELECT payload_json FROM evidence WHERE generation_id=? AND id=? AND subject_kind=? AND subject_id=? AND level=?').get(item.generation_id, item.id, item.subject_kind, item.subject_id, item.level) as { payload_json: string } | undefined;
              if (!payloadRow) throw new Error('WORKSPACE_GRAPH_EVIDENCE_CHANGED');
              const payload = payloadRow.payload_json;
              return { ...JSON.parse(payload), id: item.id, subjectKind: item.subject_kind, subjectId: item.subject_id, level: item.level, analyzerId: contribution.analyzer_id, generationId: Number(item.generation_id) };
            }));
            if (evidenceItems.length > 1000) throw new Error('WORKSPACE_GRAPH_LIMIT_EXCEEDED');
          } else {
            const count = this.db.prepare('SELECT COUNT(*) AS count FROM evidence WHERE generation_id=? AND subject_kind=? AND subject_id=?').get(contribution.generation_id, subjectKind, subjectId) as { count: number };
            evidenceCounts.set(`${subjectKind}:${subjectId}`, Number(count.count));
          }
        }
      }
      const propertyBytes = [...rows, ...edgeRows].reduce((sum, item) => sum + Number(item.property_bytes), 0);
      if (propertyBytes > 1_048_576) throw new Error('WORKSPACE_GRAPH_LIMIT_EXCEEDED');
      for (const item of rows) item.properties_json = (this.db.prepare('SELECT properties_json FROM node_contributions WHERE generation_id=? AND id=?').get(item.generation_id, item.id) as { properties_json: string }).properties_json;
      for (const item of edgeRows) item.properties_json = (this.db.prepare('SELECT properties_json FROM edge_contributions WHERE generation_id=? AND id=?').get(item.generation_id, item.id) as { properties_json: string }).properties_json;
      const evBy = new Map<string, any[]>(); for (const item of evidenceItems) evBy.set(`${item.subjectKind}:${item.subjectId}`, [...(evBy.get(`${item.subjectKind}:${item.subjectId}`) ?? []), item]);
      const project = (item: any, subjectKind: string) => { const ev = evBy.get(`${subjectKind}:${item.id}`) ?? []; return { id: item.id, workspaceId: item.workspace_id, ...(subjectKind === 'node' ? { kind: item.kind, label: item.label } : { sourceId: item.source_id, targetId: item.target_id, kind: item.kind }), properties: JSON.parse(item.properties_json), analyzerId: item.analyzer_id, generationId: Number(item.generation_id), level: item.effective_level, evidenceCount: evidenceCounts.get(`${subjectKind}:${item.id}`) ?? 0, ...(input.includeEvidence ? { evidence: ev } : {}) }; };
      const nodes = rows.map((item) => project(item, 'node'));
      const edges = edgeRows.map((item) => project(item, 'edge'));
      return { snapshotId, workspaces: workspaceRows, generations, rootIds: input.mode === 'roots' || input.mode === 'search' ? nodes.map((node) => node.id) : [input.node!], nodes, edges, hasMore, cursorValid, ...(nextOffset !== undefined ? { nextOffset } : {}) };
    });
    return read(query, cursor);
  }
  node(nodeId: string): GraphNode | undefined {
    const row = this.db.prepare(`${projectedNodesSql('')} AND id=? ORDER BY analyzer_id LIMIT 1`).get(nodeId) as any;
    return row ? this.parseContributionNode(row) : undefined;
  }
  status() {
    return this.db.prepare(`SELECT
      (SELECT COUNT(DISTINCT workspace_id) FROM active_analysis_generations) as workspaces,
      (SELECT COUNT(*) FROM (${projectedNodesSql('')})) as nodes,
      (SELECT COUNT(*) FROM (${projectedEdgesSql('')})) as edges
    `).get();
  }
  analysisRuns(workspaceId?: string, limit = 50): AnalysisRun[] { const sql = `SELECT * FROM analysis_runs ${workspaceId ? 'WHERE workspace_id=?' : ''} ORDER BY started_at DESC LIMIT ?`; const params = workspaceId ? [workspaceId, limit] : [limit]; return (this.db.prepare(sql).all(...params) as any[]).map((row) => this.parseAnalysisRun(row)); }
  analysisRun(id: string): AnalysisRun | undefined { const row = this.db.prepare('SELECT * FROM analysis_runs WHERE id=?').get(id) as any; return row ? this.parseAnalysisRun(row) : undefined; }
  databaseSchemaSnapshot(workspaceId: string): DatabaseSchemaSnapshot | undefined {
    const read = this.db.transaction((id: string) => {
      const active = this.db.prepare(`SELECT w.id AS workspace_id,w.name,g.id AS generation_id,g.run_id,r.analyzer_id,r.analyzer_version,r.source_revision,r.completed_at
        FROM active_analysis_generations a
        JOIN workspaces w ON w.id=a.workspace_id
        JOIN analysis_generations g ON g.id=a.generation_id AND g.workspace_id=a.workspace_id AND g.analyzer_id=a.analyzer_id
        JOIN analysis_runs r ON r.id=g.run_id AND r.status='succeeded'
        WHERE a.workspace_id=? AND a.analyzer_id='builtin.sqlalchemy'`).get(id) as any;
      if (!active) return undefined;
      const generationId = Number(active.generation_id);
      const nodes = (this.db.prepare(`SELECT id,workspace_id,kind,label,properties_json FROM node_contributions
        WHERE generation_id=? AND (kind LIKE 'sqlalchemy_%' OR kind='python_class') ORDER BY id`).all(generationId) as any[]).map((row) => ({ id: row.id, workspaceId: row.workspace_id, kind: row.kind, label: row.label, properties: JSON.parse(row.properties_json), analyzerId: active.analyzer_id, generationId } satisfies GraphNode));
      const edges = (this.db.prepare(`SELECT id,workspace_id,source_id,target_id,kind,properties_json FROM edge_contributions
        WHERE generation_id=? ORDER BY id`).all(generationId) as any[]).map((row) => ({ id: row.id, workspaceId: row.workspace_id, sourceId: row.source_id, targetId: row.target_id, kind: row.kind, properties: JSON.parse(row.properties_json), analyzerId: active.analyzer_id, generationId } satisfies GraphEdge));
      const evidence = (this.db.prepare('SELECT id,subject_kind,subject_id,level,payload_json FROM evidence WHERE generation_id=? ORDER BY id').all(generationId) as any[]).map((row) => ({ ...JSON.parse(row.payload_json), id: row.id, subjectKind: row.subject_kind, subjectId: row.subject_id, level: row.level, analyzerId: active.analyzer_id, generationId } as AnalysisEvidence));
      const diagnostics = (this.db.prepare('SELECT sequence,generation_id,code,severity,message,uri,line,detail_json FROM diagnostics WHERE run_id=? ORDER BY sequence').all(active.run_id) as any[]).map((row) => ({ sequence: row.sequence, generationId: row.generation_id ?? undefined, code: row.code, severity: row.severity, message: row.message, uri: row.uri ?? undefined, line: row.line ?? undefined, detail: row.detail_json ? JSON.parse(row.detail_json) : undefined } as StoredAnalysisDiagnostic));
      return { workspace: { id: active.workspace_id, name: active.name }, analysis: { analyzerId: active.analyzer_id, analyzerVersion: active.analyzer_version, generationId, runId: active.run_id, sourceRevision: active.source_revision ?? undefined, completedAt: active.completed_at }, nodes, edges, evidence, diagnostics } satisfies DatabaseSchemaSnapshot;
    });
    return read(workspaceId);
  }
  architectureSnapshot(workspaceId: string): DatabaseSchemaSnapshot | undefined {
    const read = this.db.transaction((id: string) => {
      const active = this.db.prepare(`SELECT w.id AS workspace_id,w.name,g.id AS generation_id,g.run_id,r.analyzer_id,r.analyzer_version,r.source_revision,r.completed_at
        FROM active_analysis_generations a
        JOIN workspaces w ON w.id=a.workspace_id
        JOIN analysis_generations g ON g.id=a.generation_id AND g.workspace_id=a.workspace_id AND g.analyzer_id=a.analyzer_id
        JOIN analysis_runs r ON r.id=g.run_id AND r.status='succeeded'
        WHERE a.workspace_id=? AND a.analyzer_id='builtin.architecture'`).get(id) as any;
      if (!active) return undefined;
      const generationId = Number(active.generation_id);
      const nodes = (this.db.prepare('SELECT id,workspace_id,kind,label,properties_json FROM node_contributions WHERE generation_id=? ORDER BY id').all(generationId) as any[])
        .map((row) => ({ id: row.id, workspaceId: row.workspace_id, kind: row.kind, label: row.label, properties: JSON.parse(row.properties_json), analyzerId: active.analyzer_id, generationId } satisfies GraphNode));
      const edges = (this.db.prepare('SELECT id,workspace_id,source_id,target_id,kind,properties_json FROM edge_contributions WHERE generation_id=? ORDER BY id').all(generationId) as any[])
        .map((row) => ({ id: row.id, workspaceId: row.workspace_id, sourceId: row.source_id, targetId: row.target_id, kind: row.kind, properties: JSON.parse(row.properties_json), analyzerId: active.analyzer_id, generationId } satisfies GraphEdge));
      const evidence = (this.db.prepare('SELECT id,subject_kind,subject_id,level,payload_json FROM evidence WHERE generation_id=? ORDER BY id').all(generationId) as any[])
        .map((row) => ({ ...JSON.parse(row.payload_json), id: row.id, subjectKind: row.subject_kind, subjectId: row.subject_id, level: row.level, analyzerId: active.analyzer_id, generationId } as AnalysisEvidence));
      const diagnostics = (this.db.prepare('SELECT sequence,generation_id,code,severity,message,uri,line,detail_json FROM diagnostics WHERE run_id=? ORDER BY sequence').all(active.run_id) as any[])
        .map((row) => ({ sequence: row.sequence, generationId: row.generation_id ?? undefined, code: row.code, severity: row.severity, message: row.message, uri: row.uri ?? undefined, line: row.line ?? undefined, detail: row.detail_json ? JSON.parse(row.detail_json) : undefined } as StoredAnalysisDiagnostic));
      const inputGenerations = (this.db.prepare('SELECT input_analyzer_id AS analyzerId,input_generation_id AS generationId FROM analysis_generation_inputs WHERE generation_id=? ORDER BY input_analyzer_id').all(generationId) as any[]).map((row) => ({ analyzerId: row.analyzerId, generationId: Number(row.generationId) }));
      return { workspace: { id: active.workspace_id, name: active.name }, analysis: { analyzerId: active.analyzer_id, analyzerVersion: active.analyzer_version, generationId, runId: active.run_id, sourceRevision: active.source_revision ?? undefined, completedAt: active.completed_at }, nodes, edges, evidence, diagnostics, inputGenerations } satisfies DatabaseSchemaSnapshot & { inputGenerations: Array<{ analyzerId: string; generationId: number }> };
    });
    return read(workspaceId);
  }
  crossWorkspaceArchitectureSnapshot(workspaceIds: readonly string[]): CrossWorkspaceSnapshot {
    if (!Array.isArray(workspaceIds) || workspaceIds.length < 2 || workspaceIds.length > 16 || new Set(workspaceIds).size !== workspaceIds.length || workspaceIds.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 256)) {
      throw new Error('Cross-workspace snapshot requires 2–16 unique workspace IDs.');
    }
    const requestedWorkspaceIds = [...workspaceIds].sort();
    const read = this.db.transaction((requested: string[]) => {
      const placeholders = requested.map(() => '?').join(',');
      const workspaceRows = this.db.prepare(`SELECT id,name FROM workspaces WHERE id IN (${placeholders}) ORDER BY id`).all(...requested) as Array<{ id: string; name: string }>;
      const knownIds = new Set(workspaceRows.map((workspace) => workspace.id));
      const unknown = requested.filter((id) => !knownIds.has(id));
      if (unknown.length) throw new Error(`Workspace not found: ${unknown.join(', ')}.`);

      const activeRows = this.db.prepare(`SELECT a.workspace_id,w.name,g.id AS generation_id,g.run_id,r.analyzer_id,r.analyzer_version,r.source_revision,r.completed_at
        FROM active_analysis_generations a
        JOIN workspaces w ON w.id=a.workspace_id
        JOIN analysis_generations g ON g.id=a.generation_id AND g.workspace_id=a.workspace_id AND g.analyzer_id=a.analyzer_id
        JOIN analysis_runs r ON r.id=g.run_id AND r.status='succeeded'
        WHERE a.workspace_id IN (${placeholders}) AND a.analyzer_id='builtin.architecture'
        ORDER BY a.workspace_id`).all(...requested) as any[];
      const activeIds = new Set(activeRows.map((row) => row.workspace_id as string));
      const missingArchitectureWorkspaceIds = requested.filter((id) => !activeIds.has(id));
      const generations: WorkspaceArchitectureSnapshot[] = activeRows.map((active) => {
        const generationId = Number(active.generation_id);
        const nodes = (this.db.prepare('SELECT id,workspace_id,kind,label,properties_json FROM node_contributions WHERE generation_id=? ORDER BY id').all(generationId) as any[])
          .map((row) => ({ id: row.id, workspaceId: row.workspace_id, kind: row.kind, label: row.label, properties: JSON.parse(row.properties_json), analyzerId: active.analyzer_id, generationId } satisfies GraphNode));
        const edges = (this.db.prepare('SELECT id,workspace_id,source_id,target_id,kind,properties_json FROM edge_contributions WHERE generation_id=? ORDER BY id').all(generationId) as any[])
          .map((row) => ({ id: row.id, workspaceId: row.workspace_id, sourceId: row.source_id, targetId: row.target_id, kind: row.kind, properties: JSON.parse(row.properties_json), analyzerId: active.analyzer_id, generationId } satisfies GraphEdge));
        const evidence = (this.db.prepare('SELECT id,subject_kind,subject_id,level,payload_json FROM evidence WHERE generation_id=? ORDER BY id').all(generationId) as any[])
          .map((row) => ({ ...JSON.parse(row.payload_json), id: row.id, subjectKind: row.subject_kind, subjectId: row.subject_id, level: row.level, analyzerId: active.analyzer_id, generationId } as AnalysisEvidence));
        const diagnostics = (this.db.prepare('SELECT sequence,code,severity,message,uri,line,detail_json FROM diagnostics WHERE run_id=? ORDER BY sequence').all(active.run_id) as any[])
          .map((row) => ({ code: row.code ?? undefined, severity: row.severity, message: row.message, uri: row.uri ?? undefined, line: row.line ?? undefined, detail: row.detail_json ? JSON.parse(row.detail_json) : undefined } as AnalysisDiagnostic));
        const inputGenerations = (this.db.prepare('SELECT input_analyzer_id AS analyzerId,input_generation_id AS generationId FROM analysis_generation_inputs WHERE generation_id=? ORDER BY input_analyzer_id').all(generationId) as any[])
          .map((row) => ({ analyzerId: row.analyzerId as string, generationId: Number(row.generationId) }));
        return {
          workspace: { id: active.workspace_id, name: active.name },
          generation: { workspaceId: active.workspace_id, analyzerId: 'builtin.architecture', generationId, runId: active.run_id, sourceRevision: active.source_revision ?? undefined, completedAt: active.completed_at },
          inputGenerations,
          nodes: nodes as WorkspaceArchitectureSnapshot['nodes'],
          edges: edges as WorkspaceArchitectureSnapshot['edges'],
          evidence: evidence as WorkspaceArchitectureSnapshot['evidence'],
          diagnostics: diagnostics as WorkspaceArchitectureSnapshot['diagnostics'],
        };
      });
      const vector = generations.map(({ generation }) => `${generation.workspaceId}\t${generation.generationId}`).join('\n');
      const snapshotId = createHash('sha256').update(`graphlens-cross-workspace-v1\n${vector}`).digest('hex');
      return { snapshotId, requestedWorkspaceIds, generations, missingArchitectureWorkspaceIds } satisfies CrossWorkspaceSnapshot;
    });
    return read.deferred(requestedWorkspaceIds);
  }
  snapshot(workspaceId: string, analyzerIds: readonly string[]): ArchitectureInputSnapshot {
    if (!Array.isArray(analyzerIds) || analyzerIds.length > 32 || new Set(analyzerIds).size !== analyzerIds.length || analyzerIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))) throw new Error('Architecture input analyzer scope is invalid.');
    const read = this.db.transaction((workspace: string, requested: readonly string[]) => {
      if (!this.getWorkspace(workspace)) throw new Error(`Workspace '${workspace}' was not found.`);
      if (!requested.length) return { workspaceId: workspace, generations: [], missingAnalyzerIds: [] } satisfies ArchitectureInputSnapshot;
      const placeholders = requested.map(() => '?').join(',');
      const active = this.db.prepare(`SELECT a.analyzer_id,g.id AS generation_id,r.source_revision
        FROM active_analysis_generations a
        JOIN analysis_generations g ON g.id=a.generation_id AND g.workspace_id=a.workspace_id AND g.analyzer_id=a.analyzer_id
        JOIN analysis_runs r ON r.id=g.run_id AND r.status='succeeded'
        WHERE a.workspace_id=? AND a.analyzer_id IN (${placeholders})
        ORDER BY a.analyzer_id`).all(workspace, ...requested) as Array<{ analyzer_id: string; generation_id: number; source_revision: string | null }>;
      const byAnalyzer = new Map(active.map((item) => [item.analyzer_id, item]));
      const missing = requested.filter((id) => !byAnalyzer.has(id));
      const generations = active.map((item) => {
        const generationId = Number(item.generation_id);
        const nodes = (this.db.prepare('SELECT id,workspace_id,kind,label,properties_json FROM node_contributions WHERE generation_id=? ORDER BY id').all(generationId) as any[]).map((row) => ({ id: row.id, workspaceId: row.workspace_id, kind: row.kind, label: row.label, properties: JSON.parse(row.properties_json), analyzerId: item.analyzer_id, generationId } satisfies GraphNode));
        const edges = (this.db.prepare('SELECT id,workspace_id,source_id,target_id,kind,properties_json FROM edge_contributions WHERE generation_id=? ORDER BY id').all(generationId) as any[]).map((row) => ({ id: row.id, workspaceId: row.workspace_id, sourceId: row.source_id, targetId: row.target_id, kind: row.kind, properties: JSON.parse(row.properties_json), analyzerId: item.analyzer_id, generationId } satisfies GraphEdge));
        const evidence = (this.db.prepare('SELECT id,subject_kind,subject_id,level,payload_json FROM evidence WHERE generation_id=? ORDER BY id').all(generationId) as any[]).map((row) => ({ ...JSON.parse(row.payload_json), id: row.id, subjectKind: row.subject_kind, subjectId: row.subject_id, level: row.level, analyzerId: item.analyzer_id, generationId } as AnalysisEvidence));
        const diagnostics = (this.db.prepare('SELECT sequence,code,severity,message,uri,line,detail_json FROM diagnostics WHERE generation_id=? ORDER BY sequence').all(generationId) as any[]).map((row) => ({ sequence: row.sequence, generationId, code: row.code, severity: row.severity, message: row.message, uri: row.uri ?? undefined, line: row.line ?? undefined, detail: row.detail_json ? JSON.parse(row.detail_json) : undefined } as StoredAnalysisDiagnostic));
        return { analyzerId: item.analyzer_id, generationId, sourceRevision: item.source_revision ?? undefined, nodes, edges, evidence, diagnostics };
      });
      return deepFreeze({ workspaceId: workspace, generations, missingAnalyzerIds: missing });
    }).deferred;
    return read(workspaceId, analyzerIds);
  }
  pluginInventory(): PluginInventoryItem[] {
    return this.enabledPlugins(true).map((plugin) => ({ id: plugin.id, packageName: plugin.packageName, version: plugin.version, apiVersion: plugin.apiVersion, enabled: plugin.enabled, analyzers: plugin.analyzerIds, installedAt: plugin.installedAt, errorCode: plugin.errorCode })).sort((a, b) => a.id.localeCompare(b.id));
  }
  enabledPlugins(includeDisabled = false): StoredPlugin[] {
    const rows = this.db.prepare(`SELECT * FROM plugins ${includeDisabled ? '' : 'WHERE enabled=1'} ORDER BY id`).all() as any[];
    return rows.map((row) => ({ ...JSON.parse(row.manifest_json), packageName: row.package_name, packagePath: row.package_path, enabled: row.enabled === 1, analyzerIds: (this.db.prepare('SELECT analyzer_id FROM plugin_analyzers WHERE plugin_id=? ORDER BY analyzer_id').all(row.id) as Array<{ analyzer_id: string }>).map((item) => item.analyzer_id), installedAt: row.installed_at, installationId: row.installation_id ?? undefined, lockHash: row.lock_hash ?? undefined, errorCode: row.error_code ?? undefined }));
  }
  pluginAnalyzerOwner(analyzerId: string): string | undefined {
    const row = this.db.prepare('SELECT plugin_id FROM plugin_analyzers WHERE analyzer_id=?').get(analyzerId) as { plugin_id: string } | undefined;
    return row?.plugin_id;
  }
  registerPlugin(manifest: GraphLensPluginManifest, packageName: string, packagePath: string, analyzerIds: string[], lockHash: string, installationId: string, activate: () => void): void {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const prior = this.db.prepare('SELECT enabled FROM plugins WHERE id=?').get(manifest.id) as { enabled: number } | undefined;
      if (prior?.enabled === 1) throw new Error(`Plugin '${manifest.id}' is already enabled.`);
      this.db.prepare('INSERT INTO plugins(id,version,api_version,package_name,package_path,manifest_json,enabled,installed_at,installation_id,lock_hash,error_code) VALUES(?,?,?,?,?,?,1,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET version=excluded.version,api_version=excluded.api_version,package_name=excluded.package_name,package_path=excluded.package_path,manifest_json=excluded.manifest_json,enabled=1,installed_at=excluded.installed_at,installation_id=excluded.installation_id,lock_hash=excluded.lock_hash,error_code=NULL').run(manifest.id, manifest.version, manifest.apiVersion, packageName, packagePath, JSON.stringify(manifest), now, installationId, lockHash);
      this.db.prepare('DELETE FROM plugin_analyzers WHERE plugin_id=?').run(manifest.id);
      const addAnalyzer = this.db.prepare('INSERT INTO plugin_analyzers(plugin_id,analyzer_id) VALUES(?,?)');
      for (const id of analyzerIds) addAnalyzer.run(manifest.id, id);
      activate();
    });
    tx();
  }
  disablePlugin(pluginId: string, errorCode?: string): StoredPlugin | undefined {
    const plugin = this.enabledPlugins(true).find((item) => item.id === pluginId);
    if (!plugin) return undefined;
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE plugins SET enabled=0,error_code=? WHERE id=?').run(errorCode ?? null, pluginId);
      const active = this.db.prepare('SELECT workspace_id,generation_id FROM active_analysis_generations WHERE analyzer_id IN (SELECT analyzer_id FROM plugin_analyzers WHERE plugin_id=?)').all(pluginId) as Array<{ workspace_id: string; generation_id: number }>;
      for (const item of active) this.invalidateDependents(item.workspace_id, Number(item.generation_id));
      this.db.prepare('DELETE FROM active_analysis_generations WHERE analyzer_id IN (SELECT analyzer_id FROM plugin_analyzers WHERE plugin_id=?)').run(pluginId);
    });
    tx();
    return { ...plugin, enabled: false, errorCode };
  }
  analysisDiagnostics(runId: string): StoredAnalysisDiagnostic[] { return (this.db.prepare('SELECT sequence,generation_id,code,severity,message,uri,line,detail_json FROM diagnostics WHERE run_id=? ORDER BY sequence').all(runId) as any[]).map((row) => ({ sequence: row.sequence, generationId: row.generation_id ?? undefined, code: row.code, severity: row.severity, message: row.message, uri: row.uri ?? undefined, line: row.line ?? undefined, detail: row.detail_json ? JSON.parse(row.detail_json) : undefined })); }
  startAnalysisRun(id: string, workspaceId: string, descriptor: AnalyzerDescriptor, sourceRevision: string | undefined, config: Record<string, unknown>): AnalysisRun {
    const tx = this.db.transaction(() => {
      const installationId = this.assertAnalyzerEnabled(descriptor.id);
      this.db.prepare('INSERT INTO analysis_runs(id,workspace_id,analyzer_id,analyzer_version,api_version,status,source_revision,config_json,started_at,plugin_installation_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, workspaceId, descriptor.id, descriptor.version, descriptor.apiVersion, 'running', sourceRevision ?? null, JSON.stringify(config), new Date().toISOString(), installationId);
    });
    tx();
    return this.analysisRun(id)!;
  }
  activeGraphIds(workspaceId: string, excludingAnalyzerId?: string) {
    const excluded = excludingAnalyzerId ? ' AND a.analyzer_id<>?' : '';
    const params = excludingAnalyzerId ? [workspaceId, excludingAnalyzerId] : [workspaceId];
    return {
      nodes: new Set((this.db.prepare(`SELECT n.id FROM active_analysis_generations a JOIN node_contributions n ON n.generation_id=a.generation_id WHERE a.workspace_id=?${excluded}`).all(...params) as Array<{ id: string }>).map((row) => row.id)),
      edges: new Set((this.db.prepare(`SELECT e.id FROM active_analysis_generations a JOIN edge_contributions e ON e.generation_id=a.generation_id WHERE a.workspace_id=?${excluded}`).all(...params) as Array<{ id: string }>).map((row) => row.id)),
    };
  }
  inputGraphIds(workspaceId: string, inputs: unknown) {
    if (!Array.isArray(inputs)) return { nodes: new Set<string>(), edges: new Set<string>() };
    const valid = inputs.filter((item): item is AnalysisInputGeneration => !!item && typeof item === 'object' && typeof (item as AnalysisInputGeneration).analyzerId === 'string' && Number.isSafeInteger((item as AnalysisInputGeneration).generationId));
    if (valid.length !== inputs.length) return { nodes: new Set<string>(), edges: new Set<string>() };
    const nodes = new Set<string>();
    for (const input of valid) {
      const active = this.db.prepare(`SELECT 1 FROM active_analysis_generations a
        JOIN analysis_generations g ON g.id=a.generation_id AND g.workspace_id=a.workspace_id AND g.analyzer_id=a.analyzer_id
        JOIN analysis_runs r ON r.id=g.run_id AND r.status='succeeded'
        WHERE a.workspace_id=? AND a.analyzer_id=? AND a.generation_id=?`).get(workspaceId, input.analyzerId, input.generationId);
      if (!active) throw new AnalysisError('INPUT_GENERATION_CHANGED', `Input generation '${input.analyzerId}:${input.generationId}' is no longer active for workspace '${workspaceId}'.`);
      for (const row of this.db.prepare('SELECT id FROM node_contributions WHERE generation_id=? ORDER BY id').all(input.generationId) as Array<{ id: string }>) nodes.add(row.id);
    }
    return { nodes, edges: new Set<string>() };
  }
  completeAnalysisRun(id: string, descriptor: AnalyzerDescriptor, result: AnalysisResult): void {
    const run = this.analysisRun(id); if (!run || run.status !== 'running') throw new Error(`Analysis run '${id}' is not running.`);
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const runIdentity = this.db.prepare('SELECT analyzer_id,plugin_installation_id FROM analysis_runs WHERE id=? AND status=\'running\'').get(id) as { analyzer_id: string; plugin_installation_id: string | null } | undefined;
      if (!runIdentity || runIdentity.analyzer_id !== descriptor.id || runIdentity.plugin_installation_id !== this.assertAnalyzerEnabled(descriptor.id)) throw new Error(`Analyzer '${descriptor.id}' no longer owns the installation identity for run '${id}'.`);
      const inputs = validateStoredInputGenerations(result.inputGenerations, descriptor.id);
      for (const input of inputs) {
        const active = this.db.prepare(`SELECT a.generation_id FROM active_analysis_generations a
          JOIN analysis_generations g ON g.id=a.generation_id AND g.workspace_id=a.workspace_id AND g.analyzer_id=a.analyzer_id
          JOIN analysis_runs r ON r.id=g.run_id AND r.status='succeeded'
          WHERE a.workspace_id=? AND a.analyzer_id=?`).get(run.workspaceId, input.analyzerId) as { generation_id: number } | undefined;
        if (!active) throw new AnalysisError('INPUT_GENERATION_UNAVAILABLE', `Input generation '${input.analyzerId}:${input.generationId}' is unavailable for workspace '${run.workspaceId}'.`);
        if (Number(active.generation_id) !== input.generationId) throw new AnalysisError('INPUT_GENERATION_CHANGED', `Input generation '${input.analyzerId}:${input.generationId}' changed during analysis.`);
      }
      const generation = this.db.prepare('INSERT INTO analysis_generations(run_id,workspace_id,analyzer_id,created_at,node_count,edge_count) VALUES(?,?,?,?,?,?)').run(id, run.workspaceId, descriptor.id, now, result.nodes.length, result.edges.length);
      const generationId = Number(generation.lastInsertRowid);
      const insertInput = this.db.prepare('INSERT INTO analysis_generation_inputs(generation_id,input_generation_id,input_analyzer_id) VALUES(?,?,?)');
      for (const input of inputs) insertInput.run(generationId, input.generationId, input.analyzerId);
      const repeatedAnalyzer = this.db.prepare(`WITH RECURSIVE ancestors(generation_id) AS (
        SELECT input_generation_id FROM analysis_generation_inputs WHERE generation_id=?
        UNION
        SELECT i.input_generation_id FROM analysis_generation_inputs i
        JOIN ancestors a ON i.generation_id=a.generation_id
      ) SELECT 1 FROM ancestors a JOIN analysis_generations g ON g.id=a.generation_id
        WHERE g.analyzer_id=? LIMIT 1`).get(generationId, descriptor.id);
      if (repeatedAnalyzer) throw new AnalysisError('INPUT_GENERATION_CYCLE', `Input ancestry repeats analyzer '${descriptor.id}'.`);
      const node = this.db.prepare('INSERT INTO node_contributions(generation_id,id,workspace_id,kind,label,properties_json) VALUES(?,?,?,?,?,?)');
      const edge = this.db.prepare('INSERT INTO edge_contributions(generation_id,id,workspace_id,source_id,target_id,kind,properties_json) VALUES(?,?,?,?,?,?,?)');
      const evidence = this.db.prepare('INSERT INTO evidence(id,generation_id,subject_kind,subject_id,level,payload_json) VALUES(?,?,?,?,?,?)');
      const diagnostic = this.db.prepare('INSERT INTO diagnostics(run_id,generation_id,sequence,code,severity,message,uri,line,detail_json) VALUES(?,?,?,?,?,?,?,?,?)');
      result.nodes.forEach((value) => node.run(generationId, value.id, value.workspaceId, value.kind, value.label, JSON.stringify(value.properties)));
      result.edges.forEach((value) => edge.run(generationId, value.id, value.workspaceId, value.sourceId, value.targetId, value.kind, JSON.stringify(value.properties)));
      result.evidence.forEach((value) => evidence.run(value.id, generationId, value.subjectKind, value.subjectId, value.level, JSON.stringify(value)));
      result.diagnostics.forEach((value, sequence) => diagnostic.run(id, generationId, sequence, value.code ?? 'ANALYZER_DIAGNOSTIC', value.severity, value.message, value.uri ?? null, value.line ?? null, value.detail ? JSON.stringify(value.detail) : null));
      this.activateAnalysisGeneration(run.workspaceId, descriptor.id, generationId);
      this.db.prepare("UPDATE analysis_runs SET status='succeeded',completed_at=?,diagnostic_count=?,source_revision=COALESCE(?,source_revision) WHERE id=?").run(now, result.diagnostics.length, result.sourceRevision ?? null, id);
    });
    tx();
  }
  failAnalysisRun(id: string, code: string, message: string, diagnostics: AnalysisDiagnostic[] = []): void {
    const tx = this.db.transaction(() => { const now = new Date().toISOString(); const diagnostic = this.db.prepare('INSERT INTO diagnostics(run_id,generation_id,sequence,code,severity,message,uri,line,detail_json) VALUES(?,NULL,?,?,?,?,?,?,?)'); diagnostics.forEach((value, sequence) => diagnostic.run(id, sequence, value.code ?? code, value.severity, value.message, value.uri ?? null, value.line ?? null, value.detail ? JSON.stringify(value.detail) : null)); this.db.prepare("UPDATE analysis_runs SET status='failed',completed_at=?,error_code=?,error_message=?,diagnostic_count=? WHERE id=? AND status='running'").run(now, code, message, diagnostics.length, id); }); tx();
  }
  private interruptResidualAnalysisRuns() { const now = new Date().toISOString(); this.db.prepare("UPDATE analysis_runs SET status='failed',completed_at=?,error_code='PROCESS_INTERRUPTED',error_message='The GraphLens process stopped before this analysis run completed.' WHERE status='running'").run(now); }
  private assertAnalyzerEnabled(analyzerId: string) {
    const row = this.db.prepare('SELECT p.enabled,p.installation_id FROM plugin_analyzers a JOIN plugins p ON p.id=a.plugin_id WHERE a.analyzer_id=?').get(analyzerId) as { enabled: number; installation_id: string | null } | undefined;
    if (row && row.enabled !== 1) throw new Error(`Analyzer '${analyzerId}' belongs to a disabled plugin.`);
    return row?.installation_id ?? null;
  }
  private activateAnalysisGeneration(workspaceId: string, analyzerId: string, generationId: number) {
    const previous = this.db.prepare('SELECT generation_id FROM active_analysis_generations WHERE workspace_id=? AND analyzer_id=?').get(workspaceId, analyzerId) as { generation_id: number } | undefined;
    if (previous && Number(previous.generation_id) !== generationId) this.invalidateDependents(workspaceId, Number(previous.generation_id));
    this.db.prepare('INSERT INTO active_analysis_generations(workspace_id,analyzer_id,generation_id) VALUES(?,?,?) ON CONFLICT(workspace_id,analyzer_id) DO UPDATE SET generation_id=excluded.generation_id').run(workspaceId, analyzerId, generationId);
  }
  private invalidateDependents(workspaceId: string, generationId: number) {
    this.db.prepare(`WITH RECURSIVE stale(generation_id) AS (
      SELECT generation_id FROM analysis_generation_inputs WHERE input_generation_id=?
      UNION
      SELECT i.generation_id FROM analysis_generation_inputs i JOIN stale s ON i.input_generation_id=s.generation_id
    ) DELETE FROM active_analysis_generations
      WHERE workspace_id=? AND generation_id IN (SELECT generation_id FROM stale)`).run(generationId, workspaceId);
  }
  private parseAnalysisRun(row: any): AnalysisRun { return { id: row.id, workspaceId: row.workspace_id, analyzerId: row.analyzer_id, analyzerVersion: row.analyzer_version, apiVersion: row.api_version, status: row.status, sourceRevision: row.source_revision ?? undefined, config: JSON.parse(row.config_json), startedAt: row.started_at, completedAt: row.completed_at ?? undefined, errorCode: row.error_code ?? undefined, errorMessage: row.error_message ?? undefined, diagnosticCount: row.diagnostic_count }; }
  private parseContributionNode(row: any): GraphNode {
    return { ...parseNode(row), evidence: this.evidenceFor(row, 'node') };
  }
  private parseContributionEdge(row: any) {
    return { ...parseEdge(row), evidence: this.evidenceFor(row, 'edge') };
  }
  private evidenceFor(row: any, subjectKind: 'node' | 'edge') {
    const evidence = this.db.prepare('SELECT id,generation_id,subject_kind,subject_id,level,payload_json FROM evidence WHERE generation_id=? AND subject_kind=? AND subject_id=? ORDER BY id').all(row.generation_id, subjectKind, row.id) as Array<{ id: string; generation_id: number; subject_kind: 'node' | 'edge'; subject_id: string; level: 'DIRECT' | 'DERIVED' | 'INFERRED'; payload_json: string }>;
    return evidence.map((item) => ({ ...JSON.parse(item.payload_json), id: item.id, subjectKind: item.subject_kind, subjectId: item.subject_id, level: item.level, analyzerId: row.analyzer_id, generationId: item.generation_id }));
  }
}
function validateStoredInputGenerations(value: unknown, analyzerId: string): AnalysisInputGeneration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error('Analysis inputGenerations must contain at most 32 entries.');
  const analyzers = new Set<string>(), generations = new Set<number>();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'analyzerId,generationId') throw new Error('Analysis input generation has invalid fields.');
    const input = item as AnalysisInputGeneration;
    if (typeof input.analyzerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.analyzerId) || !Number.isSafeInteger(input.generationId) || input.generationId < 1 || input.analyzerId === analyzerId || analyzers.has(input.analyzerId) || generations.has(input.generationId)) throw new Error('Analysis input generation identity is invalid, duplicate, or self-referential.');
    analyzers.add(input.analyzerId); generations.add(input.generationId);
    return { analyzerId: input.analyzerId, generationId: input.generationId };
  });
}
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
function parseNode(r: any): GraphNode { return { id:r.id, workspaceId:r.workspace_id, kind:r.kind, label:r.label, properties:JSON.parse(r.properties_json), analyzerId:r.analyzer_id, generationId:r.generation_id, level:r.effective_level }; }
function parseEdge(r: any) { return { id:r.id, workspaceId:r.workspace_id, sourceId:r.source_id, targetId:r.target_id, kind:r.kind, properties:JSON.parse(r.properties_json), analyzerId:r.analyzer_id, generationId:r.generation_id, level:r.effective_level }; }

function assertEvidence(evidence: Evidence) {
  if (evidence.confidence !== undefined && evidence.level !== 'INFERRED') {
    throw new Error('Evidence confidence is only valid for INFERRED evidence.');
  }
}

function evidenceId(workspaceId: string, analyzerId: string, subjectKind: 'node' | 'edge', subjectId: string, evidence: Evidence, index: number) {
  return evidence.id ?? createHash('sha256').update(JSON.stringify([workspaceId, analyzerId, subjectKind, subjectId, evidence, index])).digest('hex').slice(0, 32);
}
function escapeLike(value: string) { return value.replace(/[\\%_]/g, (character) => `\\${character}`); }

function projectedNodesSql(where: string, includeProperties = true) {
  return `WITH contribution_levels AS (
      SELECT n.id,n.workspace_id,n.kind,n.label,n.generation_id,${includeProperties ? 'n.properties_json,' : 'length(CAST(n.properties_json AS BLOB)) AS property_bytes,'} a.analyzer_id,
      CASE WHEN EXISTS (SELECT 1 FROM evidence ev WHERE ev.generation_id=n.generation_id AND ev.subject_kind='node' AND ev.subject_id=n.id AND ev.level='DIRECT') THEN 'DIRECT'
           WHEN EXISTS (SELECT 1 FROM evidence ev WHERE ev.generation_id=n.generation_id AND ev.subject_kind='node' AND ev.subject_id=n.id AND ev.level='DERIVED') THEN 'DERIVED'
           ELSE 'INFERRED' END AS effective_level
    FROM active_analysis_generations a JOIN node_contributions n ON n.generation_id=a.generation_id ${where}
  ), ranked_nodes AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY workspace_id,id ORDER BY CASE effective_level WHEN 'DIRECT' THEN 0 WHEN 'DERIVED' THEN 1 ELSE 2 END, analyzer_id) AS contribution_rank
    FROM contribution_levels
  ) SELECT * FROM ranked_nodes WHERE contribution_rank=1`;
}

function projectedEdgesSql(where: string, includeProperties = true) {
  return `WITH contribution_levels AS (
      SELECT e.id,e.workspace_id,e.source_id,e.target_id,e.kind,e.generation_id,${includeProperties ? 'e.properties_json,' : 'length(CAST(e.properties_json AS BLOB)) AS property_bytes,'} a.analyzer_id,
      CASE WHEN EXISTS (SELECT 1 FROM evidence ev WHERE ev.generation_id=e.generation_id AND ev.subject_kind='edge' AND ev.subject_id=e.id AND ev.level='DIRECT') THEN 'DIRECT'
           WHEN EXISTS (SELECT 1 FROM evidence ev WHERE ev.generation_id=e.generation_id AND ev.subject_kind='edge' AND ev.subject_id=e.id AND ev.level='DERIVED') THEN 'DERIVED'
           ELSE 'INFERRED' END AS effective_level
    FROM active_analysis_generations a JOIN edge_contributions e ON e.generation_id=a.generation_id ${where}
  ), ranked_edges AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY workspace_id,id ORDER BY CASE effective_level WHEN 'DIRECT' THEN 0 WHEN 'DERIVED' THEN 1 ELSE 2 END, analyzer_id) AS contribution_rank
    FROM contribution_levels
  ) SELECT * FROM ranked_edges WHERE contribution_rank=1`;
}
