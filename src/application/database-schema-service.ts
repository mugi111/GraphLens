import { createHash } from 'node:crypto';
import type { AnalysisDiagnostic, AnalysisEvidence } from '../domain/analyzer.js';
import type { GraphEdge, GraphNode } from '../domain/graph.js';
import type { DatabaseSchemaSnapshot, GraphStore, StoredAnalysisDiagnostic } from '../infrastructure/sqlite/graph-store.js';
import { GraphProjectionError } from './unified-graph-projection.js';

export type DatabaseSchemaQuery = {
  workspace: string;
  root: 'table' | 'model';
  namespace?: string;
  schema?: string;
  table?: string;
  model?: string;
  limit: number;
  cursor?: string;
  includeEvidence: boolean;
  includeDiagnostics: boolean;
};

type CursorPayload = { v: 1; workspace: string; analyzerId: 'builtin.sqlalchemy'; generationId: number; projectionSnapshotId: string; filters: string; offset: number };
type SchemaQueryFilter = Pick<DatabaseSchemaQuery, 'root' | 'namespace' | 'schema' | 'table' | 'model' | 'includeEvidence' | 'includeDiagnostics'>;
type SchemaNode = GraphNode & { evidenceCount: number };
type SchemaEdge = GraphEdge & { evidenceCount: number };

export class DatabaseSchemaError extends Error {
  constructor(public readonly code: 'WORKSPACE_NOT_FOUND' | 'DATABASE_ANALYSIS_NOT_FOUND' | 'INVALID_CURSOR' | 'CURSOR_QUERY_MISMATCH' | 'DATABASE_SNAPSHOT_CHANGED' | 'DATABASE_QUERY_FAILED' | 'DATABASE_QUERY_TOO_LARGE', message: string, public readonly status: 400 | 404 | 409 | 422 | 500 = 404) { super(message); }
}

export class DatabaseSchemaService {
  constructor(private readonly store: GraphStore) {}

  query(query: DatabaseSchemaQuery) {
    const workspace = this.store.getWorkspace(query.workspace);
    if (!workspace) throw new DatabaseSchemaError('WORKSPACE_NOT_FOUND', `Workspace '${query.workspace}' was not found.`);
    const filters = filterKey(query);
    const filterHash = createHash('sha256').update(filters).digest('base64url');
    const cursor = query.cursor !== undefined ? this.decodeCursor(query.cursor) : undefined;
    if (cursor && (cursor.workspace !== query.workspace || cursor.analyzerId !== 'builtin.sqlalchemy' || cursor.filters !== filterHash)) {
      throw new DatabaseSchemaError('CURSOR_QUERY_MISMATCH', 'Cursor does not belong to this workspace and query.', 400);
    }
    let snapshot: DatabaseSchemaSnapshot | undefined;
    try { snapshot = this.store.databaseSchemaSnapshot(query.workspace); } catch (error) {
      if (error instanceof GraphProjectionError || (error instanceof Error && error.message === 'UNIFIED_GRAPH_LIMIT_EXCEEDED')) throw new DatabaseSchemaError('DATABASE_QUERY_TOO_LARGE', error.message, 422);
      throw error;
    }
    if (!snapshot) {
      if (cursor) throw new DatabaseSchemaError('DATABASE_SNAPSHOT_CHANGED', 'The active SQLAlchemy snapshot changed while paging.', 409);
      throw new DatabaseSchemaError('DATABASE_ANALYSIS_NOT_FOUND', 'No active SQLAlchemy analysis exists for this workspace.');
    }
    if (cursor && (cursor.generationId !== snapshot.analysis.generationId || cursor.projectionSnapshotId !== snapshot.projectionSnapshotId)) throw new DatabaseSchemaError('DATABASE_SNAPSHOT_CHANGED', 'The active SQLAlchemy snapshot changed while paging.', 409);
    const roots = selectRoots(snapshot, query);
    const offset = cursor?.offset ?? 0;
    if (offset > roots.length) throw new DatabaseSchemaError('INVALID_CURSOR', 'Cursor offset is outside the result set.', 400);
    const pageRoots = roots.slice(offset, offset + query.limit);
    const closure = buildClosure(snapshot, pageRoots, query.root);
    const nextOffset = offset + pageRoots.length;
    const nextCursor = nextOffset < roots.length ? this.encodeCursor({ v: 1, workspace: query.workspace, analyzerId: 'builtin.sqlalchemy', generationId: snapshot.analysis.generationId, projectionSnapshotId: snapshot.projectionSnapshotId!, filters: filterHash, offset: nextOffset }) : undefined;
    const diagnostics = snapshot.diagnostics;
    const result = {
      workspace: snapshot.workspace,
      analysis: {
        ...snapshot.analysis,
        diagnostics: diagnosticCounts(diagnostics),
      },
      query: queryEcho(query),
      page: { limit: query.limit, rootCount: pageRoots.length, totalRootCount: roots.length, ...(nextCursor ? { nextCursor } : {}) },
      rootIds: pageRoots.map((node) => node.id),
      nodes: projectNodes(closure.nodes, snapshot.evidence, query.includeEvidence),
      edges: projectEdges(closure.edges, snapshot.evidence, query.includeEvidence),
      ...(query.includeDiagnostics ? { diagnostics: relevantDiagnostics(diagnostics, closure.nodes, closure.edges, snapshot.evidence) } : {}),
    };
    return result;
  }

  private encodeCursor(payload: CursorPayload) {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  private decodeCursor(value: string): CursorPayload {
    if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new DatabaseSchemaError('INVALID_CURSOR', 'Cursor is invalid.', 400);
    let parsed: unknown;
    try {
      const decoded = Buffer.from(value, 'base64url');
      if (decoded.toString('base64url') !== value) throw new Error('Non-canonical base64url.');
      parsed = JSON.parse(decoded.toString('utf8'));
    } catch { throw new DatabaseSchemaError('INVALID_CURSOR', 'Cursor is invalid.', 400); }
    if (!isCursor(parsed)) throw new DatabaseSchemaError('INVALID_CURSOR', 'Cursor is invalid.', 400);
    return parsed;
  }
}

function isCursor(value: unknown): value is CursorPayload {
  if (!isRecord(value)) return false;
  const fields = ['analyzerId', 'filters', 'generationId', 'offset', 'projectionSnapshotId', 'v', 'workspace'];
  return Object.keys(value).sort().join(',') === fields.join(',') && value.v === 1 && typeof value.workspace === 'string' && value.workspace.length > 0 && value.workspace.length <= 256 && typeof value.analyzerId === 'string' && value.analyzerId.length > 0 && value.analyzerId.length <= 128 && Number.isSafeInteger(value.generationId) && Number(value.generationId) > 0 && typeof value.filters === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.filters) && typeof value.projectionSnapshotId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.projectionSnapshotId) && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0;
}
function filterKey(query: DatabaseSchemaQuery) {
  return JSON.stringify({ root: query.root, namespace: query.namespace ?? null, schema: query.schema === undefined ? null : query.schema, table: query.table ?? null, model: query.model ?? null, includeEvidence: query.includeEvidence, includeDiagnostics: query.includeDiagnostics });
}
function queryEcho(query: DatabaseSchemaQuery) {
  return { root: query.root, ...(query.namespace !== undefined ? { namespace: query.namespace } : {}), ...(query.schema !== undefined ? { schema: query.schema } : {}), ...(query.table !== undefined ? { table: query.table } : {}), ...(query.model !== undefined ? { model: query.model } : {}) };
}
function selectRoots(snapshot: DatabaseSchemaSnapshot, query: DatabaseSchemaQuery) {
  const kind = query.root === 'table' ? 'sqlalchemy_table' : 'sqlalchemy_model';
  const modelOwners = new Map<string, Set<string>>();
  if (query.root === 'table' && query.model !== undefined) for (const edge of snapshot.edges) {
    if (edge.kind !== 'contains') continue;
    const owners = modelOwners.get(edge.targetId) ?? new Set<string>();
    owners.add(edge.sourceId);
    modelOwners.set(edge.targetId, owners);
  }
  return snapshot.nodes.filter((node) => {
    if (node.kind !== kind) return false;
    const p = node.properties;
    if (query.namespace !== undefined && p.databaseNamespace !== query.namespace) return false;
    if (query.schema !== undefined && (query.schema === '' ? p.schema !== null && p.schema !== undefined : p.schema !== query.schema)) return false;
    if (query.table !== undefined && p.tableName !== query.table) return false;
    if (query.model !== undefined) {
      const candidate = (owner: GraphNode) => owner.kind === 'sqlalchemy_model' && (owner.properties.qualifiedName === query.model || `${String(owner.properties.module)}.${String(owner.properties.qualifiedName)}` === query.model);
      if (query.root === 'model') { if (!candidate(node)) return false; }
      else {
        const ownerIds = modelOwners.get(node.id) ?? new Set<string>();
        if (!snapshot.nodes.some((owner) => ownerIds.has(owner.id) && candidate(owner))) return false;
      }
    }
    return true;
  }).sort((a, b) => compare(rootSortKey(a, query.root), rootSortKey(b, query.root)));
}
function rootSortKey(node: GraphNode, root: 'table' | 'model') {
  const p = node.properties;
  return root === 'table'
    ? [String(p.databaseNamespace ?? ''), p.schema === null || p.schema === undefined ? 0 : 1, String(p.schema ?? ''), String(p.tableName ?? ''), node.id]
    : [String(p.databaseNamespace ?? ''), String(p.module ?? ''), String(p.qualifiedName ?? ''), node.id];
}
function buildClosure(snapshot: DatabaseSchemaSnapshot, roots: GraphNode[], rootKind: 'table' | 'model') {
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of snapshot.edges) {
    outgoing.set(edge.sourceId, [...(outgoing.get(edge.sourceId) ?? []), edge]);
    incoming.set(edge.targetId, [...(incoming.get(edge.targetId) ?? []), edge]);
  }
  const selectedNodes = new Map<string, GraphNode>();
  const selectedEdges = new Map<string, GraphEdge>();
  const addNode = (id: string) => { const node = nodeById.get(id); if (node) selectedNodes.set(id, node); return node; };
  const addEdge = (edge: GraphEdge) => { selectedEdges.set(edge.id, edge); addNode(edge.sourceId); addNode(edge.targetId); };
  const outgoingByKind = (id: string, kinds: string[]) => (outgoing.get(id) ?? []).filter((edge) => kinds.includes(edge.kind));
  const incomingByKind = (id: string, kinds: string[]) => (incoming.get(id) ?? []).filter((edge) => kinds.includes(edge.kind));

  for (const root of roots) {
    addNode(root.id);
    if (rootKind === 'table') {
      for (const edge of outgoingByKind(root.id, ['contains'])) addEdge(edge);
      for (const edge of incomingByKind(root.id, ['contains'])) if (nodeById.get(edge.sourceId)?.kind === 'sqlalchemy_model') addEdge(edge);
    }
  }
  const initialModels = [...selectedNodes.values()].filter((node) => node.kind === 'sqlalchemy_model');
  for (const model of initialModels) {
    for (const edge of incomingByKind(model.id, ['maps_to'])) addEdge(edge);
    for (const edge of outgoingByKind(model.id, ['contains'])) addEdge(edge);
  }
  for (const table of [...selectedNodes.values()].filter((node) => node.kind === 'sqlalchemy_table')) {
    for (const edge of outgoingByKind(table.id, ['contains'])) addEdge(edge);
    for (const edge of incomingByKind(table.id, ['contains'])) if (nodeById.get(edge.sourceId)?.kind === 'sqlalchemy_model') addEdge(edge);
  }
  for (const constraint of [...selectedNodes.values()].filter((node) => node.kind === 'sqlalchemy_constraint')) {
    for (const edge of outgoingByKind(constraint.id, ['constrains'])) addEdge(edge);
  }
  for (const relation of [...selectedNodes.values()].filter((node) => node.kind === 'sqlalchemy_relationship')) {
    for (const edge of outgoingByKind(relation.id, ['relationship'])) {
      addEdge(edge);
      const target = nodeById.get(edge.targetId);
      if (target?.kind === 'sqlalchemy_model') addCompactModelContext(target, nodeById, incoming, outgoing, addNode, addEdge);
    }
  }
  for (const column of [...selectedNodes.values()].filter((node) => node.kind === 'sqlalchemy_column')) {
    for (const edge of outgoingByKind(column.id, ['foreign_key'])) {
      addEdge(edge);
      const target = nodeById.get(edge.targetId);
      if (target?.kind === 'sqlalchemy_column') {
        for (const owner of incomingByKind(target.id, ['contains'])) if (nodeById.get(owner.sourceId)?.kind === 'sqlalchemy_table') {
          addEdge(owner);
          for (const model of incomingByKind(owner.sourceId, ['contains'])) if (nodeById.get(model.sourceId)?.kind === 'sqlalchemy_model') addEdge(model);
        }
      }
    }
  }
  if (selectedNodes.size + selectedEdges.size > 9000) throw new DatabaseSchemaError('DATABASE_QUERY_FAILED', 'Schema closure exceeds the bounded snapshot size.', 500);
  return { nodes: [...selectedNodes.values()].sort((a, b) => compare([a.kind, a.id], [b.kind, b.id])), edges: [...selectedEdges.values()].sort((a, b) => compare([a.kind, a.sourceId, a.targetId, a.id], [b.kind, b.sourceId, b.targetId, b.id])) };
}
function addCompactModelContext(model: GraphNode, nodeById: Map<string, GraphNode>, incoming: Map<string, GraphEdge[]>, outgoing: Map<string, GraphEdge[]>, addNode: (id: string) => GraphNode | undefined, addEdge: (edge: GraphEdge) => void) {
  addNode(model.id);
  for (const edge of incoming.get(model.id) ?? []) if (edge.kind === 'maps_to') addEdge(edge);
  for (const edge of outgoing.get(model.id) ?? []) if (edge.kind === 'contains' && nodeById.get(edge.targetId)?.kind === 'sqlalchemy_table') addEdge(edge);
}
function projectNodes(nodes: GraphNode[], evidence: AnalysisEvidence[], include: boolean): SchemaNode[] {
  const bySubject = new Map<string, AnalysisEvidence[]>();
  for (const item of evidence) if (item.subjectKind === 'node') bySubject.set(item.subjectId, [...(bySubject.get(item.subjectId) ?? []), item]);
  return nodes.map((node) => {
    const items = (bySubject.get(node.id) ?? []).sort((a, b) => compare([a.id], [b.id]));
    return { ...node, level: dominantLevel(items), evidenceCount: items.length, ...(include ? { evidence: items } : { evidence: undefined }) };
  });
}
function projectEdges(edges: GraphEdge[], evidence: AnalysisEvidence[], include: boolean): SchemaEdge[] {
  const bySubject = new Map<string, AnalysisEvidence[]>();
  for (const item of evidence) if (item.subjectKind === 'edge') bySubject.set(item.subjectId, [...(bySubject.get(item.subjectId) ?? []), item]);
  return edges.map((edge) => {
    const items = (bySubject.get(edge.id) ?? []).sort((a, b) => compare([a.id], [b.id]));
    return { ...edge, level: dominantLevel(items), evidenceCount: items.length, ...(include ? { evidence: items } : { evidence: undefined }) };
  });
}
function dominantLevel(evidence: AnalysisEvidence[]): 'DIRECT' | 'DERIVED' | 'INFERRED' { return evidence.some((item) => item.level === 'DIRECT') ? 'DIRECT' : evidence.some((item) => item.level === 'DERIVED') ? 'DERIVED' : 'INFERRED'; }
function diagnosticCounts(items: StoredAnalysisDiagnostic[]) { return { total: items.length, info: items.filter((item) => item.severity === 'info').length, warning: items.filter((item) => item.severity === 'warning').length, error: items.filter((item) => item.severity === 'error').length }; }
function relevantDiagnostics(items: StoredAnalysisDiagnostic[], nodes: GraphNode[], edges: GraphEdge[], evidence: AnalysisEvidence[]): AnalysisDiagnostic[] {
  const subjects = new Set([...nodes.map((node) => `node:${node.id}`), ...edges.map((edge) => `edge:${edge.id}`)]);
  const uris = new Set(evidence.filter((item) => subjects.has(`${item.subjectKind}:${item.subjectId}`) && item.uri).map((item) => item.uri!));
  return items.filter((item) => !item.uri || uris.has(item.uri)).map(({ sequence: _sequence, generationId: _generationId, ...item }) => item);
}
function compare(a: Array<string | number>, b: Array<string | number>) { for (let index = 0; index < Math.min(a.length, b.length); index++) { if (a[index]! < b[index]!) return -1; if (a[index]! > b[index]!) return 1; } return a.length - b.length; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
