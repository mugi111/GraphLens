import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AnalysisDiagnostic, AnalysisEvidence, AnalysisResult, AnalyzerDescriptor } from '../../domain/analyzer.js';
import type { Evidence, GraphNode, GraphSnapshot, Workspace } from '../../domain/graph.js';
import type { GraphLensPluginManifest, PluginInventoryItem } from '../../domain/plugin.js';
import { analyzerOwnedGenerationsMigration, analyzerRunLifecycleMigration, legacySchemaMigration, pluginInstallationIdentityMigration, pluginPackageOwnershipMigration, runMigrations } from './migrations.js';
export type SyncRun = { id: string; workspaceId?: string; status: 'running' | 'succeeded' | 'failed'; message: string; startedAt: string; completedAt?: string };
export type AnalysisRun = { id: string; workspaceId: string; analyzerId: string; analyzerVersion: string; apiVersion: string; status: 'running' | 'succeeded' | 'failed'; sourceRevision?: string; config: Record<string, unknown>; startedAt: string; completedAt?: string; errorCode?: string; errorMessage?: string; diagnosticCount: number };
export type StoredAnalysisDiagnostic = AnalysisDiagnostic & { sequence: number; generationId?: number };
export type StoredPlugin = GraphLensPluginManifest & { packageName: string; packagePath: string; enabled: boolean; analyzerIds: string[]; installedAt: string; installationId?: string; lockHash?: string; errorCode?: string };

export class GraphStore {
  private db: Database.Database;
  constructor(file: string, options: { recoverInterruptedRuns?: boolean } = {}) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    runMigrations(this.db, [legacySchemaMigration, analyzerOwnedGenerationsMigration, analyzerRunLifecycleMigration, pluginPackageOwnershipMigration, pluginInstallationIdentityMigration]);
    if (options.recoverInterruptedRuns !== false) this.interruptResidualAnalysisRuns();
  }
  close() { this.db.close(); }
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
      const activate = this.db.prepare('INSERT INTO active_analysis_generations(workspace_id,analyzer_id,generation_id) VALUES(?,?,?) ON CONFLICT(workspace_id,analyzer_id) DO UPDATE SET generation_id=excluded.generation_id');
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
        activate.run(snapshot.workspace.id, analyzerId, generationId);
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
  plugins(): PluginInventoryItem[] {
    return this.enabledPlugins(true).map((plugin) => ({ id: plugin.id, version: plugin.version, enabled: plugin.enabled, analyzers: plugin.analyzerIds, installedAt: plugin.installedAt, errorCode: plugin.errorCode }));
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
  completeAnalysisRun(id: string, descriptor: AnalyzerDescriptor, result: AnalysisResult): void {
    const run = this.analysisRun(id); if (!run || run.status !== 'running') throw new Error(`Analysis run '${id}' is not running.`);
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const runIdentity = this.db.prepare('SELECT analyzer_id,plugin_installation_id FROM analysis_runs WHERE id=? AND status=\'running\'').get(id) as { analyzer_id: string; plugin_installation_id: string | null } | undefined;
      if (!runIdentity || runIdentity.analyzer_id !== descriptor.id || runIdentity.plugin_installation_id !== this.assertAnalyzerEnabled(descriptor.id)) throw new Error(`Analyzer '${descriptor.id}' no longer owns the installation identity for run '${id}'.`);
      const generation = this.db.prepare('INSERT INTO analysis_generations(run_id,workspace_id,analyzer_id,created_at,node_count,edge_count) VALUES(?,?,?,?,?,?)').run(id, run.workspaceId, descriptor.id, now, result.nodes.length, result.edges.length);
      const generationId = Number(generation.lastInsertRowid);
      const node = this.db.prepare('INSERT INTO node_contributions(generation_id,id,workspace_id,kind,label,properties_json) VALUES(?,?,?,?,?,?)');
      const edge = this.db.prepare('INSERT INTO edge_contributions(generation_id,id,workspace_id,source_id,target_id,kind,properties_json) VALUES(?,?,?,?,?,?,?)');
      const evidence = this.db.prepare('INSERT INTO evidence(id,generation_id,subject_kind,subject_id,level,payload_json) VALUES(?,?,?,?,?,?)');
      const diagnostic = this.db.prepare('INSERT INTO diagnostics(run_id,generation_id,sequence,code,severity,message,uri,line,detail_json) VALUES(?,?,?,?,?,?,?,?,?)');
      result.nodes.forEach((value) => node.run(generationId, value.id, value.workspaceId, value.kind, value.label, JSON.stringify(value.properties)));
      result.edges.forEach((value) => edge.run(generationId, value.id, value.workspaceId, value.sourceId, value.targetId, value.kind, JSON.stringify(value.properties)));
      result.evidence.forEach((value) => evidence.run(value.id, generationId, value.subjectKind, value.subjectId, value.level, JSON.stringify(value)));
      result.diagnostics.forEach((value, sequence) => diagnostic.run(id, generationId, sequence, value.code ?? 'ANALYZER_DIAGNOSTIC', value.severity, value.message, value.uri ?? null, value.line ?? null, value.detail ? JSON.stringify(value.detail) : null));
      this.db.prepare('INSERT INTO active_analysis_generations(workspace_id,analyzer_id,generation_id) VALUES(?,?,?) ON CONFLICT(workspace_id,analyzer_id) DO UPDATE SET generation_id=excluded.generation_id').run(run.workspaceId, descriptor.id, generationId);
      this.db.prepare("UPDATE analysis_runs SET status='succeeded',completed_at=?,diagnostic_count=? WHERE id=?").run(now, result.diagnostics.length, id);
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

function projectedNodesSql(where: string) {
  return `WITH contribution_levels AS (
    SELECT n.*, a.analyzer_id,
      CASE WHEN EXISTS (SELECT 1 FROM evidence ev WHERE ev.generation_id=n.generation_id AND ev.subject_kind='node' AND ev.subject_id=n.id AND ev.level='DIRECT') THEN 'DIRECT'
           WHEN EXISTS (SELECT 1 FROM evidence ev WHERE ev.generation_id=n.generation_id AND ev.subject_kind='node' AND ev.subject_id=n.id AND ev.level='DERIVED') THEN 'DERIVED'
           ELSE 'INFERRED' END AS effective_level
    FROM active_analysis_generations a JOIN node_contributions n ON n.generation_id=a.generation_id ${where}
  ), ranked_nodes AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY workspace_id,id ORDER BY CASE effective_level WHEN 'DIRECT' THEN 0 WHEN 'DERIVED' THEN 1 ELSE 2 END, analyzer_id) AS contribution_rank
    FROM contribution_levels
  ) SELECT * FROM ranked_nodes WHERE contribution_rank=1`;
}

function projectedEdgesSql(where: string) {
  return `WITH contribution_levels AS (
    SELECT e.*, a.analyzer_id,
      CASE WHEN EXISTS (SELECT 1 FROM evidence ev WHERE ev.generation_id=e.generation_id AND ev.subject_kind='edge' AND ev.subject_id=e.id AND ev.level='DIRECT') THEN 'DIRECT'
           WHEN EXISTS (SELECT 1 FROM evidence ev WHERE ev.generation_id=e.generation_id AND ev.subject_kind='edge' AND ev.subject_id=e.id AND ev.level='DERIVED') THEN 'DERIVED'
           ELSE 'INFERRED' END AS effective_level
    FROM active_analysis_generations a JOIN edge_contributions e ON e.generation_id=a.generation_id ${where}
  ), ranked_edges AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY workspace_id,id ORDER BY CASE effective_level WHEN 'DIRECT' THEN 0 WHEN 'DERIVED' THEN 1 ELSE 2 END, analyzer_id) AS contribution_rank
    FROM contribution_levels
  ) SELECT * FROM ranked_edges WHERE contribution_rank=1`;
}
