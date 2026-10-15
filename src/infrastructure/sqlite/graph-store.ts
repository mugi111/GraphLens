import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AnalysisError, type AnalysisDiagnostic, type AnalysisEvidence, type AnalysisInputGeneration, type AnalysisResult, type AnalyzerDescriptor, type ArchitectureInputProvider, type ArchitectureInputSnapshot } from '../../domain/analyzer.js';
import type { Evidence, GraphEdge, GraphNode, GraphSnapshot, Workspace } from '../../domain/graph.js';
import type { GraphLensPluginManifest, PluginInventoryItem } from '../../domain/plugin.js';
import type { CrossWorkspaceSnapshot, WorkspaceArchitectureSnapshot } from '../../domain/federation.js';
import type { SourceCatalogSnapshot } from '../../domain/source-identity.js';
import { normalizeRelativeSourcePath } from '../../core/source-path.js';
import { GraphIdentityFactory } from '../../core/graph-identity.js';
import { projectEdgeContributions, projectNodeContributions } from '../../application/unified-graph-projection.js';
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
  projectionSnapshotId?: string;
  activeGenerations?: Array<{ workspaceId: string; analyzerId: string; generationId: number }>;
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
  activeSourceEvidence(workspaceId: string, analyzerId: string, generationId: number, evidenceId: string) {
    const read = this.db.transaction(() => {
      const exact = `FROM active_analysis_generations a JOIN analysis_generations g ON g.id=a.generation_id AND g.workspace_id=a.workspace_id AND g.analyzer_id=a.analyzer_id
        JOIN analysis_runs r ON r.id=g.run_id AND r.status='succeeded' JOIN workspaces w ON w.id=a.workspace_id
        JOIN evidence e ON e.generation_id=a.generation_id WHERE a.workspace_id=? AND a.analyzer_id=? AND a.generation_id=? AND e.id=?
        AND ((e.subject_kind='node' AND EXISTS (SELECT 1 FROM node_contributions n WHERE n.generation_id=e.generation_id AND n.id=e.subject_id AND n.workspace_id=a.workspace_id))
          OR (e.subject_kind='edge' AND EXISTS (SELECT 1 FROM edge_contributions x WHERE x.generation_id=e.generation_id AND x.id=e.subject_id AND x.workspace_id=a.workspace_id)))`;
      const metadata = this.db.prepare(`SELECT w.id AS workspace_id,w.name,w.path,a.generation_id,e.id,e.subject_kind,e.subject_id,length(CAST(e.payload_json AS BLOB)) AS payload_bytes ${exact}`).get(workspaceId, analyzerId, generationId, evidenceId) as any;
      if (!metadata) return undefined;
      if (Number(metadata.payload_bytes) > 64 * 1024) return { ...metadata, payloadTooLarge: true };
      const payload = this.db.prepare(`SELECT e.payload_json ${exact} AND length(CAST(e.payload_json AS BLOB))<=?`).get(workspaceId, analyzerId, generationId, evidenceId, 64 * 1024) as { payload_json: string } | undefined;
      return payload ? { ...metadata, payload_json: payload.payload_json, payloadTooLarge: false } : undefined;
    });
    return read();
  }
  sourceGenerationIsActive(workspaceId: string, analyzerId: string, generationId: number): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM active_analysis_generations a JOIN analysis_generations g ON g.id=a.generation_id AND g.workspace_id=a.workspace_id AND g.analyzer_id=a.analyzer_id JOIN analysis_runs r ON r.id=g.run_id AND r.status='succeeded' WHERE a.workspace_id=? AND a.analyzer_id=? AND a.generation_id=?`).get(workspaceId, analyzerId, generationId));
  }
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
    const boundedLimit = Math.min(limit, 250);
    const params = workspaceId ? [workspaceId, boundedLimit + 1] : [boundedLimit + 1];
    const where = workspaceId ? 'WHERE a.workspace_id=?' : '';
    const nodes = this.db.prepare(`${projectedNodesSql(where, false)} ORDER BY label,workspace_id,id LIMIT ?`).all(...params) as any[];
    if (nodes.length > boundedLimit) throw new Error('UNIFIED_GRAPH_LIMIT_EXCEEDED');
    const allowed = new Set(nodes.map((n) => `${n.workspace_id}\0${n.id}`));
    const keys = [...allowed].map((key) => key.split('\0'));
    if (!keys.length) return { nodes: [], edges: [] };
    const endpoints = keys.map(() => '(?,?)').join(',');
    const edgeWhere = `${where ? `${where} AND` : 'WHERE'} (e.workspace_id,e.source_id) IN (${endpoints}) AND (e.workspace_id,e.target_id) IN (${endpoints})`;
    const edgeParams = [...(workspaceId ? [workspaceId] : []), ...keys.flat(), ...keys.flat()];
    const edges = this.db.prepare(`${projectedEdgesSql(edgeWhere, false)} ORDER BY workspace_id,id LIMIT 201`).all(...edgeParams) as any[];
    if (edges.length > 200) throw new Error('UNIFIED_GRAPH_LIMIT_EXCEEDED');
    const result = this.unifiedPage(nodes.map((n) => ({ workspaceId: n.workspace_id, id: n.id })), edges.map((e) => ({ workspaceId: e.workspace_id, id: e.id })), true);
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 3 * 1_048_576) throw new Error('UNIFIED_GRAPH_LIMIT_EXCEEDED');
    return result;
  }
  projectGraph(nodes: GraphNode[], edges: GraphEdge[], includeEvidence: boolean) {
    const result = this.unifiedPage(nodes.map((n) => ({ workspaceId: n.workspaceId, id: n.id })), edges.map((e) => ({ workspaceId: e.workspaceId, id: e.id })), includeEvidence);
    return result;
  }
  private unifiedPage(nodeKeys: Array<{ workspaceId: string; id: string }>, edgeKeys: Array<{ workspaceId: string; id: string }>, includeEvidence: boolean) {
    const nodeTuples=nodeKeys.map(()=>'(?,?)').join(',');const edgeTuples=edgeKeys.map(()=>'(?,?)').join(',');
    const nodeArgs=nodeKeys.flatMap((key)=>[key.workspaceId,key.id]);const edgeArgs=edgeKeys.flatMap((key)=>[key.workspaceId,key.id]);
    const nodeMeta=nodeKeys.length?this.db.prepare(`SELECT n.workspace_id,n.id,COUNT(*) owner_count,SUM(length(CAST(n.properties_json AS BLOB))) property_bytes FROM node_contributions n JOIN active_analysis_generations a ON a.generation_id=n.generation_id AND a.workspace_id=n.workspace_id WHERE (n.workspace_id,n.id) IN (${nodeTuples}) GROUP BY n.workspace_id,n.id`).all(...nodeArgs) as any[]:[];
    const edgeMeta=edgeKeys.length?this.db.prepare(`SELECT e.workspace_id,e.id,COUNT(*) owner_count,SUM(length(CAST(e.properties_json AS BLOB))) property_bytes FROM edge_contributions e JOIN active_analysis_generations a ON a.generation_id=e.generation_id AND a.workspace_id=e.workspace_id WHERE (e.workspace_id,e.id) IN (${edgeTuples}) GROUP BY e.workspace_id,e.id`).all(...edgeArgs) as any[]:[];
    const contributionCount=[...nodeMeta,...edgeMeta].reduce((sum,row)=>sum+Number(row.owner_count),0);const propertyBytes=[...nodeMeta,...edgeMeta].reduce((sum,row)=>sum+Number(row.property_bytes),0);
    if(contributionCount>5000||propertyBytes>1_048_576)throw new Error('UNIFIED_GRAPH_LIMIT_EXCEEDED');
    const nodeEvidenceMeta=nodeKeys.length?this.db.prepare(`SELECT n.workspace_id,n.id,COUNT(v.id) evidence_count,COALESCE(SUM(length(CAST(v.payload_json AS BLOB))),0) evidence_bytes FROM node_contributions n JOIN active_analysis_generations a ON a.generation_id=n.generation_id AND a.workspace_id=n.workspace_id LEFT JOIN evidence v ON v.generation_id=n.generation_id AND v.subject_kind='node' AND v.subject_id=n.id WHERE (n.workspace_id,n.id) IN (${nodeTuples}) GROUP BY n.workspace_id,n.id`).all(...nodeArgs) as any[]:[];
    const edgeEvidenceMeta=edgeKeys.length?this.db.prepare(`SELECT e.workspace_id,e.id,COUNT(v.id) evidence_count,COALESCE(SUM(length(CAST(v.payload_json AS BLOB))),0) evidence_bytes FROM edge_contributions e JOIN active_analysis_generations a ON a.generation_id=e.generation_id AND a.workspace_id=e.workspace_id LEFT JOIN evidence v ON v.generation_id=e.generation_id AND v.subject_kind='edge' AND v.subject_id=e.id WHERE (e.workspace_id,e.id) IN (${edgeTuples}) GROUP BY e.workspace_id,e.id`).all(...edgeArgs) as any[]:[];
    const totalEvidence=[...nodeEvidenceMeta,...edgeEvidenceMeta].reduce((sum,row)=>sum+Number(row.evidence_count),0);const evidenceBytes=[...nodeEvidenceMeta,...edgeEvidenceMeta].reduce((sum,row)=>sum+Number(row.evidence_bytes),0);
    if(includeEvidence&&(totalEvidence>1000||evidenceBytes>1_048_576))throw new Error('UNIFIED_GRAPH_LIMIT_EXCEEDED');
    const nodeRows=nodeKeys.length?this.db.prepare(`SELECT n.id,n.workspace_id,n.kind,n.label,n.properties_json,n.generation_id,a.analyzer_id,CASE WHEN EXISTS(SELECT 1 FROM evidence v WHERE v.generation_id=n.generation_id AND v.subject_kind='node' AND v.subject_id=n.id AND v.level='DIRECT') THEN 'DIRECT' WHEN EXISTS(SELECT 1 FROM evidence v WHERE v.generation_id=n.generation_id AND v.subject_kind='node' AND v.subject_id=n.id AND v.level='DERIVED') THEN 'DERIVED' ELSE 'INFERRED' END level FROM node_contributions n JOIN active_analysis_generations a ON a.generation_id=n.generation_id AND a.workspace_id=n.workspace_id WHERE (n.workspace_id,n.id) IN (${nodeTuples}) ORDER BY n.workspace_id,n.id,CASE WHEN a.analyzer_id='builtin.codegraph' THEN 0 ELSE 1 END,CASE level WHEN 'DIRECT' THEN 0 WHEN 'DERIVED' THEN 1 ELSE 2 END,a.analyzer_id,n.generation_id`).all(...nodeArgs) as any[]:[];
    const edgeRows=edgeKeys.length?this.db.prepare(`SELECT e.id,e.workspace_id,e.source_id,e.target_id,e.kind,e.properties_json,e.generation_id,a.analyzer_id,CASE WHEN EXISTS(SELECT 1 FROM evidence v WHERE v.generation_id=e.generation_id AND v.subject_kind='edge' AND v.subject_id=e.id AND v.level='DIRECT') THEN 'DIRECT' WHEN EXISTS(SELECT 1 FROM evidence v WHERE v.generation_id=e.generation_id AND v.subject_kind='edge' AND v.subject_id=e.id AND v.level='DERIVED') THEN 'DERIVED' ELSE 'INFERRED' END level FROM edge_contributions e JOIN active_analysis_generations a ON a.generation_id=e.generation_id AND a.workspace_id=e.workspace_id WHERE (e.workspace_id,e.id) IN (${edgeTuples}) ORDER BY e.workspace_id,e.id,CASE WHEN a.analyzer_id='builtin.codegraph' THEN 0 ELSE 1 END,CASE level WHEN 'DIRECT' THEN 0 WHEN 'DERIVED' THEN 1 ELSE 2 END,a.analyzer_id,e.generation_id`).all(...edgeArgs) as any[]:[];
    const evidenceBySubject=new Map<string,any[]>();
    if(includeEvidence){
      const nodeEvidence=nodeKeys.length?this.db.prepare(`SELECT v.id,v.generation_id,v.subject_id,v.level,v.payload_json,n.workspace_id,a.analyzer_id FROM node_contributions n JOIN active_analysis_generations a ON a.generation_id=n.generation_id AND a.workspace_id=n.workspace_id JOIN evidence v ON v.generation_id=n.generation_id AND v.subject_kind='node' AND v.subject_id=n.id WHERE (n.workspace_id,n.id) IN (${nodeTuples}) ORDER BY n.workspace_id,n.id,a.analyzer_id,n.generation_id,v.id`).all(...nodeArgs) as any[]:[];
      const edgeEvidence=edgeKeys.length?this.db.prepare(`SELECT v.id,v.generation_id,v.subject_id,v.level,v.payload_json,e.workspace_id,a.analyzer_id FROM edge_contributions e JOIN active_analysis_generations a ON a.generation_id=e.generation_id AND a.workspace_id=e.workspace_id JOIN evidence v ON v.generation_id=e.generation_id AND v.subject_kind='edge' AND v.subject_id=e.id WHERE (e.workspace_id,e.id) IN (${edgeTuples}) ORDER BY e.workspace_id,e.id,a.analyzer_id,e.generation_id,v.id`).all(...edgeArgs) as any[]:[];
      for(const [items,subjectKind] of [[nodeEvidence,'node'],[edgeEvidence,'edge']] as const)for(const item of items){const key=`${subjectKind}\0${item.workspace_id}\0${item.subject_id}`;const list=evidenceBySubject.get(key)??[];list.push({...JSON.parse(item.payload_json),id:item.id,subjectId:item.subject_id,subjectKind,level:item.level,analyzerId:item.analyzer_id,generationId:Number(item.generation_id)});evidenceBySubject.set(key,list);}
    }
    const nodesByKey=new Map<string,any[]>();for(const row of nodeRows){const key=`${row.workspace_id}\0${row.id}`;const list=nodesByKey.get(key)??[];list.push({id:row.id,workspaceId:row.workspace_id,kind:row.kind,label:row.label,properties:JSON.parse(row.properties_json),analyzerId:row.analyzer_id,generationId:Number(row.generation_id),level:row.level,evidence:evidenceBySubject.get(`node\0${key}`)??[]});nodesByKey.set(key,list);}
    const edgesByKey=new Map<string,any[]>();for(const row of edgeRows){const key=`${row.workspace_id}\0${row.id}`;const list=edgesByKey.get(key)??[];list.push({id:row.id,workspaceId:row.workspace_id,sourceId:row.source_id,targetId:row.target_id,kind:row.kind,properties:JSON.parse(row.properties_json),analyzerId:row.analyzer_id,generationId:Number(row.generation_id),level:row.level,evidence:evidenceBySubject.get(`edge\0${key}`)??[]});edgesByKey.set(key,list);}
    const nodeEvidenceCounts=new Map(nodeEvidenceMeta.map((row)=>[`${row.workspace_id}\0${row.id}`,Number(row.evidence_count)]));const edgeEvidenceCounts=new Map(edgeEvidenceMeta.map((row)=>[`${row.workspace_id}\0${row.id}`,Number(row.evidence_count)]));
    const nodes=[...nodesByKey].map(([key,items])=>{const projected=projectNodeContributions(items);projected.evidenceCount=nodeEvidenceCounts.get(key)??0;if(!includeEvidence)delete projected.evidence;return projected;});
    const edges=[...edgesByKey].map(([key,items])=>{const projected=projectEdgeContributions(items);projected.evidenceCount=edgeEvidenceCounts.get(key)??0;if(!includeEvidence)delete projected.evidence;return projected;});
    return {nodes,edges};
  }
  workspaceGraphPage(query: import('../../application/workspace-query-service.js').WorkspaceGraphQuery, cursor?: { offset?: number; snapshot?: string }) {
    const read = this.db.transaction((input: typeof query, pageCursor?: typeof cursor) => {
      const ids = input.workspaces; const placeholders = ids.map(() => '?').join(',');
      const workspaceRows = this.db.prepare(`SELECT id,name FROM workspaces WHERE id IN (${placeholders}) ORDER BY id`).all(...ids) as Array<{ id: string; name: string }>;
      const known = new Set(workspaceRows.map((item) => item.id));
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length) throw new Error(`WORKSPACE_NOT_FOUND:${missing.join(',')}`);
      const active = this.db.prepare(`SELECT a.workspace_id,a.analyzer_id,a.generation_id FROM active_analysis_generations a WHERE a.workspace_id IN (${placeholders}) ORDER BY a.workspace_id,a.analyzer_id LIMIT 257`).all(...ids) as Array<{ workspace_id: string; analyzer_id: string; generation_id: number }>;
      if (active.length > 256) throw new Error('UNIFIED_GRAPH_LIMIT_EXCEEDED');
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
      const unified = this.unifiedPage(rows.map((item) => ({ workspaceId: item.workspace_id, id: item.id })), edgeRows.map((item) => ({ workspaceId: item.workspace_id, id: item.id })), input.includeEvidence);
      if (unified.nodes.length > 250 || unified.edges.length > 200 || Buffer.byteLength(JSON.stringify({ snapshotId, workspaces: workspaceRows, generations, nodes: unified.nodes, edges: unified.edges, hasMore }), 'utf8') > 3 * 1_048_576) throw new Error('WORKSPACE_GRAPH_LIMIT_EXCEEDED');
      const nodeKeys = new Set(unified.nodes.map((item) => `${item.workspaceId}\0${item.id}`));
      if (unified.edges.some((edge) => !nodeKeys.has(`${edge.workspaceId}\0${edge.sourceId}`) || !nodeKeys.has(`${edge.workspaceId}\0${edge.targetId}`))) throw new Error('WORKSPACE_GRAPH_DANGLING_EDGE');
      return { snapshotId, workspaces: workspaceRows, generations, rootIds: input.mode === 'roots' || input.mode === 'search' ? unified.nodes.map((node) => node.id) : [input.node!], nodes: unified.nodes, edges: unified.edges, hasMore, cursorValid, ...(nextOffset !== undefined ? { nextOffset } : {}) };
    });
    return read(query, cursor);
  }
  codeGraphPage(query: import('../../application/code-graph-query-service.js').CodeGraphQuery, cursor?: { offset: number; snapshot: string }) {
    const read = this.db.transaction(() => {
      const ids=query.workspaces, ph=ids.map(()=>'?').join(',');
      const workspaces=this.db.prepare(`SELECT id,name FROM workspaces WHERE id IN (${ph}) ORDER BY id`).all(...ids) as Array<{id:string;name:string}>;
      if(workspaces.length!==ids.length)throw new Error('CODE_WORKSPACE_NOT_FOUND');
      const gens=this.db.prepare(`SELECT a.workspace_id,a.analyzer_id,a.generation_id FROM active_analysis_generations a JOIN analysis_generations g ON g.id=a.generation_id AND g.workspace_id=a.workspace_id AND g.analyzer_id=a.analyzer_id JOIN analysis_runs r ON r.id=g.run_id AND r.status='succeeded' WHERE a.workspace_id IN (${ph}) ORDER BY a.workspace_id,a.analyzer_id LIMIT 257`).all(...ids) as any[];
      if(gens.length>256)throw new Error('CODE_LIMIT');const snapshotId=createHash('sha256').update(JSON.stringify({ids,gens})).digest('base64url');if(query.snapshot&&query.snapshot!==snapshotId||cursor&&cursor.snapshot!==snapshotId)throw new Error('CODE_SNAPSHOT_CHANGED');
      const active=gens.filter(g=>ids.includes(g.workspace_id)); if(!active.length) return {snapshotId,workspaces,generations:[],nodes:[],edges:[],hasMore:false};
      const tuples=active.map(()=>'(?,?)').join(',');const ga=active.flatMap(g=>[g.workspace_id,g.generation_id]);
      const classKinds=["'code.class'","'code.interface'","'code.struct'","'code.trait'","'code.union'","'python_class'"];
      const edgeKinds=query.mode==='children'?"('contains')":query.preset==='class'?"('inherits','implements')":query.preset==='calls'?"('calls')":query.preset==='imports'?"('imports')":"('calls','imports','references','extends','inherits','implements','instantiates','type_of','returns','depends_on')";
      const nbase=`WITH contribution_levels AS (SELECT n.id,n.workspace_id,n.kind,n.label,n.generation_id,a.analyzer_id,length(CAST(n.properties_json AS BLOB)) property_bytes,COALESCE((SELECT level FROM evidence e WHERE e.generation_id=n.generation_id AND e.subject_kind='node' AND e.subject_id=n.id ORDER BY CASE level WHEN 'DIRECT' THEN 0 WHEN 'DERIVED' THEN 1 ELSE 2 END LIMIT 1),'INFERRED') level FROM node_contributions n JOIN active_analysis_generations a ON a.generation_id=n.generation_id AND a.workspace_id=n.workspace_id WHERE (n.workspace_id,n.generation_id) IN (${tuples})), ranked AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY workspace_id,id ORDER BY CASE WHEN analyzer_id='builtin.codegraph' THEN 0 ELSE 1 END,CASE level WHEN 'DIRECT' THEN 0 WHEN 'DERIVED' THEN 1 ELSE 2 END,analyzer_id,generation_id) contribution_rank FROM contribution_levels) SELECT * FROM ranked WHERE contribution_rank=1`;
      const ebase=`WITH contribution_levels AS (SELECT e.id,e.workspace_id,e.source_id,e.target_id,e.kind,e.generation_id,a.analyzer_id,length(CAST(e.properties_json AS BLOB)) property_bytes,COALESCE((SELECT level FROM evidence v WHERE v.generation_id=e.generation_id AND v.subject_kind='edge' AND v.subject_id=e.id ORDER BY CASE level WHEN 'DIRECT' THEN 0 WHEN 'DERIVED' THEN 1 ELSE 2 END LIMIT 1),'INFERRED') level FROM edge_contributions e JOIN active_analysis_generations a ON a.generation_id=e.generation_id AND a.workspace_id=e.workspace_id WHERE (e.workspace_id,e.generation_id) IN (${tuples}) AND e.kind IN ${edgeKinds}), ranked AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY workspace_id,id ORDER BY CASE WHEN analyzer_id='builtin.codegraph' THEN 0 ELSE 1 END,CASE level WHEN 'DIRECT' THEN 0 WHEN 'DERIVED' THEN 1 ELSE 2 END,analyzer_id,generation_id) contribution_rank FROM contribution_levels) SELECT * FROM ranked WHERE contribution_rank=1`;
      const offset=cursor?.offset??0;let roots:any[]=[];let edges:any[]=[];let hasMore=false;
      if(query.mode==='neighbors'||query.mode==='children'){
        if(!this.db.prepare(`SELECT 1 FROM (${nbase}) WHERE workspace_id=? AND id=?`).get(...ga,query.nodeWorkspace,query.node))throw new Error('CODE_NODE_NOT_FOUND');
        const filter=query.mode==='children'?"workspace_id=? AND kind='contains' AND source_id=?":query.direction==='incoming'?'workspace_id=? AND target_id=?':query.direction==='outgoing'?'workspace_id=? AND source_id=?':'workspace_id=? AND (source_id=? OR target_id=?)';
        const args=[...ga,query.nodeWorkspace,...(query.direction==='both'&&query.mode==='neighbors'?[query.node,query.node]:[query.node])];edges=this.db.prepare(`SELECT * FROM (${ebase}) WHERE ${filter} ORDER BY workspace_id,id LIMIT ? OFFSET ?`).all(...args,query.limit+1,offset) as any[];hasMore=edges.length>query.limit;edges=edges.slice(0,query.limit);
        const keys=new Set<string>([`${query.nodeWorkspace}\0${query.node}`]);for(const e of edges){keys.add(`${e.workspace_id}\0${e.source_id}`);keys.add(`${e.workspace_id}\0${e.target_id}`)}
        roots=this.db.prepare(`SELECT * FROM (${nbase}) WHERE (workspace_id,id) IN (${[...keys].map(()=>'(?,?)').join(',')}) ORDER BY workspace_id,id LIMIT 251`).all(...ga,...[...keys].flatMap(k=>k.split('\0'))) as any[];
      } else {
        const candidates=query.preset==='class'?classKinds.join(','):query.preset==='calls'?"'code.function','python_function','python_method'":query.preset==='imports'?"'file','code.module','code.package'":"'code.function','python_function','python_method','code.module','code.package','file','code.class','code.interface','code.struct','code.trait','code.union','code.enum','code.type','code.variable','code.constant','code.property','python_class'";
        const conditions:string[]=[`kind IN (${candidates})`];const args:any[]=[...ga];if(query.mode==='search'){conditions.push("label LIKE ? ESCAPE '\\'");args.push(`%${query.q!.replace(/[\\%_]/g,'\\$&')}%`)}if(query.kind){conditions.push('kind=?');args.push(query.kind)}
        const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';roots=this.db.prepare(`SELECT * FROM (${nbase}) ${where} ORDER BY workspace_id,label,id LIMIT ? OFFSET ?`).all(...args,query.limit+1,offset) as any[];hasMore=roots.length>query.limit;roots=roots.slice(0,query.limit);
        const pairs=roots.map(n=>[n.workspace_id,n.id]); if(pairs.length){const qkeys=pairs.map(()=>'(?,?)').join(',');edges=this.db.prepare(`SELECT * FROM (${ebase}) WHERE (workspace_id,source_id) IN (${qkeys}) OR (workspace_id,target_id) IN (${qkeys}) ORDER BY workspace_id,id LIMIT 201`).all(...ga,...pairs.flat(),...pairs.flat()) as any[];}
        const needed=new Set(roots.map(n=>`${n.workspace_id}\0${n.id}`));for(const e of edges){needed.add(`${e.workspace_id}\0${e.source_id}`);needed.add(`${e.workspace_id}\0${e.target_id}`)}if(needed.size>250||edges.length>200)throw new Error('CODE_LIMIT');const hydrated=new Set(roots.map(n=>`${n.workspace_id}\0${n.id}`));if([...needed].some(k=>!hydrated.has(k)))roots=this.db.prepare(`SELECT * FROM (${nbase}) WHERE (workspace_id,id) IN (${[...needed].map(()=>'(?,?)').join(',')}) ORDER BY workspace_id,id LIMIT 251`).all(...ga,...[...needed].flatMap(k=>k.split('\0'))) as any[];
      }
      const nodeKeys=new Set(roots.map((node)=>`${node.workspace_id}\0${node.id}`));
      if(edges.some((edge)=>!nodeKeys.has(`${edge.workspace_id}\0${edge.source_id}`)||!nodeKeys.has(`${edge.workspace_id}\0${edge.target_id}`)))throw new Error('CODE_DANGLING_EDGE');
      if(roots.length>250||edges.length>200)throw new Error('CODE_LIMIT');
      const unified=this.unifiedPage(roots.map((row)=>({workspaceId:row.workspace_id,id:row.id})),edges.map((row)=>({workspaceId:row.workspace_id,id:row.id})),query.includeEvidence);
      const unifiedNodeKeys=new Set(unified.nodes.map((node)=>`${node.workspaceId}\0${node.id}`));
      if(unified.edges.some((edge)=>!unifiedNodeKeys.has(`${edge.workspaceId}\0${edge.sourceId}`)||!unifiedNodeKeys.has(`${edge.workspaceId}\0${edge.targetId}`)))throw new Error('CODE_DANGLING_EDGE');
      if(unified.nodes.length>250||unified.edges.length>200||Buffer.byteLength(JSON.stringify({snapshotId,workspaces,generations:active,nodes:unified.nodes,edges:unified.edges,hasMore}),'utf8')>3*1048576)throw new Error('CODE_LIMIT');
      return {snapshotId,workspaces,generations:active.map(g=>({workspaceId:g.workspace_id,analyzerId:g.analyzer_id,generationId:Number(g.generation_id)})),nodes:unified.nodes,edges:unified.edges,hasMore,nextOffset:hasMore?offset+query.limit:undefined};
    });return read();
  }
  node(nodeId: string, workspaceId?: string): GraphNode | undefined {
    const where = workspaceId ? 'WHERE a.workspace_id=?' : '';
    const args = workspaceId ? [workspaceId, nodeId] : [nodeId];
    const row = this.db.prepare(`${projectedNodesSql(where, false)} AND id=? ORDER BY workspace_id,analyzer_id LIMIT 1`).get(...args) as any;
    if (!row) return undefined;
    const result = this.unifiedPage([{ workspaceId: row.workspace_id, id: row.id }], [], true).nodes[0];
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 3 * 1_048_576) throw new Error('UNIFIED_GRAPH_LIMIT_EXCEEDED');
    return result;
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
      const activeGenerations = this.activeGenerationVector([id]);
      const active = this.db.prepare(`SELECT w.id AS workspace_id,w.name,g.id AS generation_id,g.run_id,r.analyzer_id,r.analyzer_version,r.source_revision,r.completed_at
        FROM active_analysis_generations a
        JOIN workspaces w ON w.id=a.workspace_id
        JOIN analysis_generations g ON g.id=a.generation_id AND g.workspace_id=a.workspace_id AND g.analyzer_id=a.analyzer_id
        JOIN analysis_runs r ON r.id=g.run_id AND r.status='succeeded'
        WHERE a.workspace_id=? AND a.analyzer_id='builtin.sqlalchemy'`).get(id) as any;
      if (!active) return undefined;
      const generationId = Number(active.generation_id);
      const nodes = this.db.prepare(`SELECT n.id,n.workspace_id,n.kind,n.label,n.properties_json FROM node_contributions n WHERE n.generation_id=? AND (n.kind LIKE 'sqlalchemy_%' OR n.kind='python_class') ORDER BY n.id`).all(generationId).map((row: any) => ({ id: row.id, workspaceId: row.workspace_id, kind: row.kind, label: row.label, properties: JSON.parse(row.properties_json), level: 'INFERRED' as const, evidenceCount: 0 }));
      const edges = this.db.prepare('SELECT id,workspace_id,source_id,target_id,kind,properties_json FROM edge_contributions WHERE generation_id=? ORDER BY id').all(generationId).map((row: any) => ({ id: row.id, workspaceId: row.workspace_id, sourceId: row.source_id, targetId: row.target_id, kind: row.kind, properties: JSON.parse(row.properties_json), level: 'INFERRED' as const, evidenceCount: 0 }));
      const evidence: AnalysisEvidence[] = [];
      const projectionSnapshotId = createHash('sha256').update(JSON.stringify(activeGenerations)).digest('base64url');
      const diagnostics = (this.db.prepare('SELECT sequence,generation_id,code,severity,message,uri,line,detail_json FROM diagnostics WHERE run_id=? ORDER BY sequence').all(active.run_id) as any[]).map((row) => ({ sequence: row.sequence, generationId: row.generation_id ?? undefined, code: row.code, severity: row.severity, message: row.message, uri: row.uri ?? undefined, line: row.line ?? undefined, detail: row.detail_json ? JSON.parse(row.detail_json) : undefined } as StoredAnalysisDiagnostic));
      return { workspace: { id: active.workspace_id, name: active.name }, analysis: { analyzerId: active.analyzer_id, analyzerVersion: active.analyzer_version, generationId, runId: active.run_id, sourceRevision: active.source_revision ?? undefined, completedAt: active.completed_at }, nodes, edges, evidence, diagnostics, activeGenerations, projectionSnapshotId } satisfies DatabaseSchemaSnapshot;
    });
    return read(workspaceId);
  }
  architectureSnapshot(workspaceId: string): DatabaseSchemaSnapshot | undefined {
    const read = this.db.transaction((id: string) => {
      const activeGenerations = this.activeGenerationVector([id]);
      const active = this.db.prepare(`SELECT w.id AS workspace_id,w.name,g.id AS generation_id,g.run_id,r.analyzer_id,r.analyzer_version,r.source_revision,r.completed_at
        FROM active_analysis_generations a
        JOIN workspaces w ON w.id=a.workspace_id
        JOIN analysis_generations g ON g.id=a.generation_id AND g.workspace_id=a.workspace_id AND g.analyzer_id=a.analyzer_id
        JOIN analysis_runs r ON r.id=g.run_id AND r.status='succeeded'
        WHERE a.workspace_id=? AND a.analyzer_id='builtin.architecture'`).get(id) as any;
      if (!active) return undefined;
      const generationId = Number(active.generation_id);
      const nodes = this.db.prepare('SELECT id,workspace_id,kind,label,properties_json FROM node_contributions WHERE generation_id=? ORDER BY id').all(generationId).map((row: any) => ({ id: row.id, workspaceId: row.workspace_id, kind: row.kind, label: row.label, properties: JSON.parse(row.properties_json), level: 'INFERRED' as const, evidenceCount: 0 }));
      const edges = this.db.prepare('SELECT id,workspace_id,source_id,target_id,kind,properties_json FROM edge_contributions WHERE generation_id=? ORDER BY id').all(generationId).map((row: any) => ({ id: row.id, workspaceId: row.workspace_id, sourceId: row.source_id, targetId: row.target_id, kind: row.kind, properties: JSON.parse(row.properties_json), level: 'INFERRED' as const, evidenceCount: 0 }));
      const evidence: AnalysisEvidence[] = [];
      const projectionSnapshotId = createHash('sha256').update(JSON.stringify(activeGenerations)).digest('base64url');
      const diagnostics = (this.db.prepare('SELECT sequence,generation_id,code,severity,message,uri,line,detail_json FROM diagnostics WHERE run_id=? ORDER BY sequence').all(active.run_id) as any[])
        .map((row) => ({ sequence: row.sequence, generationId: row.generation_id ?? undefined, code: row.code, severity: row.severity, message: row.message, uri: row.uri ?? undefined, line: row.line ?? undefined, detail: row.detail_json ? JSON.parse(row.detail_json) : undefined } as StoredAnalysisDiagnostic));
      const inputGenerations = (this.db.prepare('SELECT input_analyzer_id AS analyzerId,input_generation_id AS generationId FROM analysis_generation_inputs WHERE generation_id=? ORDER BY input_analyzer_id').all(generationId) as any[]).map((row) => ({ analyzerId: row.analyzerId, generationId: Number(row.generationId) }));
      return { workspace: { id: active.workspace_id, name: active.name }, analysis: { analyzerId: active.analyzer_id, analyzerVersion: active.analyzer_version, generationId, runId: active.run_id, sourceRevision: active.source_revision ?? undefined, completedAt: active.completed_at }, nodes, edges, evidence, diagnostics, inputGenerations, activeGenerations, projectionSnapshotId } satisfies DatabaseSchemaSnapshot & { inputGenerations: Array<{ analyzerId: string; generationId: number }> };
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
      const generationVector = this.activeGenerationVector(requested);
      let projectedOwners = 0; let projectedEvidence = 0; let projectedPropertyBytes = 0; let projectedEvidenceBytes = 0;
      const generations: WorkspaceArchitectureSnapshot[] = activeRows.map((active) => {
        const generationId = Number(active.generation_id);
        const nodeKeys = (this.db.prepare('SELECT workspace_id,id FROM node_contributions WHERE generation_id=? ORDER BY id').all(generationId) as any[]).map((row) => ({ workspaceId: row.workspace_id, id: row.id }));
        const edgeKeys = (this.db.prepare('SELECT workspace_id,id FROM edge_contributions WHERE generation_id=? ORDER BY id').all(generationId) as any[]).map((row) => ({ workspaceId: row.workspace_id, id: row.id }));
        const projection = this.unifiedPage(nodeKeys, edgeKeys, true);
        const nodes = projection.nodes;
        const edges = projection.edges;
        const evidence = [...nodes.flatMap((node) => node.evidence ?? []), ...edges.flatMap((edge) => edge.evidence ?? [])] as AnalysisEvidence[];
        projectedOwners += [...nodes, ...edges].reduce((sum, item) => sum + (item.contributors?.length ?? 1), 0);
        projectedEvidence += evidence.length;
        projectedPropertyBytes += Buffer.byteLength(JSON.stringify([...nodes.map((item) => item.properties), ...edges.map((item) => item.properties)]), 'utf8');
        projectedEvidenceBytes += Buffer.byteLength(JSON.stringify(evidence), 'utf8');
        if (projectedOwners > 5000 || projectedEvidence > 1000 || projectedPropertyBytes > 1_048_576 || projectedEvidenceBytes > 1_048_576) throw new Error('UNIFIED_GRAPH_LIMIT_EXCEEDED');
        const diagnostics = (this.db.prepare('SELECT sequence,code,severity,message,uri,line,detail_json FROM diagnostics WHERE run_id=? ORDER BY sequence').all(active.run_id) as any[])
          .map((row) => ({ code: row.code ?? undefined, severity: row.severity, message: row.message, uri: row.uri ?? undefined, line: row.line ?? undefined, detail: row.detail_json ? JSON.parse(row.detail_json) : undefined } as AnalysisDiagnostic));
        const inputGenerations = (this.db.prepare('SELECT input_analyzer_id AS analyzerId,input_generation_id AS generationId FROM analysis_generation_inputs WHERE generation_id=? ORDER BY input_analyzer_id').all(generationId) as any[])
          .map((row) => ({ analyzerId: row.analyzerId as string, generationId: Number(row.generationId) }));
        return {
          workspace: { id: active.workspace_id, name: active.name },
          generation: { workspaceId: active.workspace_id, analyzerId: 'builtin.architecture', generationId, runId: active.run_id, sourceRevision: active.source_revision ?? undefined, completedAt: active.completed_at },
          inputGenerations,
          activeGenerations: generationVector.filter((item) => item.workspaceId === active.workspace_id).map(({ analyzerId, generationId: activeGenerationId }) => ({ analyzerId, generationId: activeGenerationId })),
          nodes: nodes as WorkspaceArchitectureSnapshot['nodes'],
          edges: edges as WorkspaceArchitectureSnapshot['edges'],
          evidence: evidence as WorkspaceArchitectureSnapshot['evidence'],
          diagnostics: diagnostics as WorkspaceArchitectureSnapshot['diagnostics'],
        };
      });
      const snapshotId = createHash('sha256').update(JSON.stringify({ requested, generationVector })).digest('hex');
      const result = { snapshotId, requestedWorkspaceIds, generations, missingArchitectureWorkspaceIds } satisfies CrossWorkspaceSnapshot;
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 3 * 1_048_576) throw new Error('UNIFIED_GRAPH_LIMIT_EXCEEDED');
      return result;
    });
    return read.deferred(requestedWorkspaceIds);
  }
  private activeGenerationVector(workspaceIds: readonly string[]) {
    if (!workspaceIds.length) return [];
    const placeholders = workspaceIds.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT a.workspace_id,a.analyzer_id,a.generation_id FROM active_analysis_generations a JOIN analysis_generations g ON g.id=a.generation_id AND g.workspace_id=a.workspace_id AND g.analyzer_id=a.analyzer_id JOIN analysis_runs r ON r.id=g.run_id AND r.status='succeeded' WHERE a.workspace_id IN (${placeholders}) ORDER BY a.workspace_id,a.analyzer_id LIMIT 257`).all(...workspaceIds) as any[];
    if (rows.length > 256) throw new Error('UNIFIED_GRAPH_LIMIT_EXCEEDED');
    return rows.map((row) => ({ workspaceId: row.workspace_id as string, analyzerId: row.analyzer_id as string, generationId: Number(row.generation_id) }));
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
  sourceCatalog(workspaceId: string, maxItems = 9000): SourceCatalogSnapshot | undefined {
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 9000) throw new Error('Source catalog limit must be between 1 and 9000.');
    const read = this.db.transaction((workspace: string, limit: number) => {
      if (!this.getWorkspace(workspace)) throw new Error(`Workspace '${workspace}' was not found.`);
      const active = this.db.prepare(`SELECT g.id AS generation_id,r.analyzer_version,r.source_revision FROM active_analysis_generations a JOIN analysis_generations g ON g.id=a.generation_id AND g.workspace_id=a.workspace_id AND g.analyzer_id=a.analyzer_id JOIN analysis_runs r ON r.id=g.run_id AND r.status='succeeded' WHERE a.workspace_id=? AND a.analyzer_id='builtin.codegraph'`).get(workspace) as { generation_id: number; analyzer_version: string; source_revision: string | null } | undefined;
      if (!active || active.analyzer_version !== '1.6.2') return undefined;
      const generationId = Number(active.generation_id);
      const identity = new GraphIdentityFactory();
      const repository = this.db.prepare("SELECT id,properties_json FROM node_contributions WHERE generation_id=? AND workspace_id=? AND kind='repository'").get(generationId, workspace) as { id: string; properties_json: string } | undefined;
      if (!repository || repository.id !== identity.repository(workspace, 'root')) return undefined;
      const repositoryProperties = JSON.parse(repository.properties_json) as Record<string, unknown>;
      if (repositoryProperties.repositoryKey !== 'root' || repositoryProperties.scope !== 'workspace-source-root') return undefined;
      const counts = this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM node_contributions WHERE generation_id=? AND kind='file') files,
        (SELECT COUNT(*) FROM node_contributions WHERE generation_id=? AND json_extract(properties_json,'$.codegraphId') IS NOT NULL AND json_extract(properties_json,'$.filePath') IS NOT NULL) symbols,
        (SELECT COALESCE(SUM(length(CAST(properties_json AS BLOB))),0) FROM node_contributions WHERE generation_id=? AND (kind='file' OR (json_extract(properties_json,'$.codegraphId') IS NOT NULL AND json_extract(properties_json,'$.filePath') IS NOT NULL))) bytes`).get(generationId, generationId, generationId) as { files: number; symbols: number; bytes: number };
      if (Number(counts.files) + Number(counts.symbols) > limit) throw new Error('Source catalog exceeds its item limit.');
      if (Number(counts.bytes) > 16 * 1024 * 1024) throw new Error('Source catalog exceeds its byte limit.');
      const fileRows = this.db.prepare("SELECT id,label,properties_json FROM node_contributions WHERE generation_id=? AND workspace_id=? AND kind='file' ORDER BY id LIMIT ?").all(generationId, workspace, limit + 1) as any[];
      const symbolRows = this.db.prepare("SELECT id,kind,label,properties_json FROM node_contributions WHERE generation_id=? AND workspace_id=? AND json_extract(properties_json,'$.codegraphId') IS NOT NULL AND json_extract(properties_json,'$.filePath') IS NOT NULL ORDER BY id LIMIT ?").all(generationId, workspace, limit + 1) as any[];
      if (fileRows.length !== Number(counts.files) || symbolRows.length !== Number(counts.symbols)) throw new Error('Source catalog changed while reading the snapshot.');
      const files = fileRows.map((row) => {
        const properties = JSON.parse(row.properties_json) as Record<string, unknown>;
        const relativePath = normalizeRelativeSourcePath(String(properties.path ?? row.label));
        const contentHash = properties.contentHash;
        if (row.id !== identity.file(workspace, 'root', relativePath) || typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(contentHash)) throw new Error('CodeGraph source catalog contains an unsupported file identity or digest.');
        return { fileId: row.id, repositoryKey: 'root', relativePath, contentDigest: { algorithm: 'sha256' as const, encoding: 'utf8-text' as const, value: contentHash, providerVersion: active.analyzer_version } };
      });
      const symbols = symbolRows.map((row) => {
        const properties = JSON.parse(row.properties_json) as Record<string, unknown>;
        const upstreamId = properties.codegraphId;
        const relativePath = normalizeRelativeSourcePath(String(properties.filePath));
        if (typeof upstreamId !== 'string' || row.id !== identity.sourceSymbol(workspace, 'root', 'codegraph', upstreamId)) throw new Error('CodeGraph source catalog contains an unsupported symbol identity.');
        const coordinate = (name: string) => { const value = properties[name]; if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`CodeGraph source catalog has an invalid ${name} coordinate.`); return Number(value); };
        return { nodeId: row.id, upstreamId, kind: row.kind, relativePath, name: row.label, startLine: coordinate('startLine'), startColumn: coordinate('startColumn'), endLine: coordinate('endLine'), endColumn: coordinate('endColumn') };
      });
      return deepFreeze({ workspaceId: workspace, input: { analyzerId: 'builtin.codegraph' as const, generationId, ...(active.source_revision ? { sourceRevision: active.source_revision } : {}) }, repositoryKey: 'root', files, symbols });
    }).deferred;
    return read(workspaceId, maxItems);
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
    SELECT *, ROW_NUMBER() OVER (PARTITION BY workspace_id,id ORDER BY CASE WHEN analyzer_id='builtin.codegraph' THEN 0 ELSE 1 END,CASE effective_level WHEN 'DIRECT' THEN 0 WHEN 'DERIVED' THEN 1 ELSE 2 END, analyzer_id) AS contribution_rank
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
    SELECT *, ROW_NUMBER() OVER (PARTITION BY workspace_id,id ORDER BY CASE WHEN analyzer_id='builtin.codegraph' THEN 0 ELSE 1 END,CASE effective_level WHEN 'DIRECT' THEN 0 WHEN 'DERIVED' THEN 1 ELSE 2 END, analyzer_id) AS contribution_rank
    FROM contribution_levels
  ) SELECT * FROM ranked_edges WHERE contribution_rank=1`;
}
