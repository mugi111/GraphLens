import { createHash } from 'node:crypto';
import type { AnalysisDiagnostic, AnalysisEvidence } from '../domain/analyzer.js';
import type { GraphEdge, GraphNode } from '../domain/graph.js';
import type { DatabaseSchemaSnapshot, GraphStore, StoredAnalysisDiagnostic } from '../infrastructure/sqlite/graph-store.js';
import { GraphProjectionError } from './unified-graph-projection.js';

export type ArchitectureRoot = 'endpoint' | 'handler' | 'model' | 'table' | 'finding';
export type ArchitectureQuery = { workspace: string; root: ArchitectureRoot; node?: string; namespace?: string; method?: string; path?: string; finding?: 'gap' | 'ambiguous' | 'unresolved' | 'mismatch'; limit: number; depth: number; cursor?: string; includeEvidence: boolean; includeDiagnostics: boolean };
type Cursor = { v: 1; workspace: string; analyzerId: 'builtin.architecture'; generationId: number; projectionSnapshotId: string; filters: string; offset: number };
type Snapshot = DatabaseSchemaSnapshot & { inputGenerations?: Array<{ analyzerId: string; generationId: number }> };
const EDGE_ALLOWLIST = new Set(['implements_contract', 'architecture_contract_finding', 'exposes', 'handled_by', 'depends_on', 'calls', 'references', 'accepts', 'returns', 'uses_schema', 'secured_by', 'uses_scheme', 'maps_to', 'contains', 'accesses_model', 'http_request']);

export class ArchitectureQueryError extends Error {
  constructor(public readonly code: 'WORKSPACE_NOT_FOUND' | 'ARCHITECTURE_ANALYSIS_NOT_FOUND' | 'ARCHITECTURE_NODE_NOT_FOUND' | 'INVALID_CURSOR' | 'CURSOR_QUERY_MISMATCH' | 'ARCHITECTURE_SNAPSHOT_CHANGED' | 'ARCHITECTURE_QUERY_TOO_LARGE', message: string, public readonly status: 404 | 400 | 409 | 422 = 404) { super(message); }
}

export class ArchitectureQueryService {
  constructor(private readonly store: GraphStore) {}
  query(query: ArchitectureQuery) {
    if (!this.store.getWorkspace(query.workspace)) throw new ArchitectureQueryError('WORKSPACE_NOT_FOUND', `Workspace '${query.workspace}' was not found.`);
    const filters = filterKey(query);
    const filterHash = createHash('sha256').update(filters).digest('base64url');
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (cursor && (cursor.workspace !== query.workspace || cursor.analyzerId !== 'builtin.architecture' || cursor.filters !== filterHash)) throw new ArchitectureQueryError('CURSOR_QUERY_MISMATCH', 'Cursor does not belong to this workspace and query.', 400);
    let page: ReturnType<GraphStore['architectureQueryPage']>;
    try { page = this.store.architectureQueryPage({ ...query, includeEvidence: query.includeEvidence || query.includeDiagnostics }, cursor?.offset ?? 0) as ReturnType<GraphStore['architectureQueryPage']>; } catch (error) {
      if (error instanceof GraphProjectionError || (error instanceof Error && error.message === 'UNIFIED_GRAPH_LIMIT_EXCEEDED')) throw tooLarge();
      throw error;
    }
    if (!page) {
      if (cursor) throw new ArchitectureQueryError('ARCHITECTURE_SNAPSHOT_CHANGED', 'The active architecture snapshot changed while paging.', 409);
      throw new ArchitectureQueryError('ARCHITECTURE_ANALYSIS_NOT_FOUND', 'No active architecture analysis exists for this workspace.');
    }
    const snapshot = page.snapshot as Snapshot;
    if (cursor && (cursor.generationId !== snapshot.analysis.generationId || cursor.projectionSnapshotId !== snapshot.projectionSnapshotId)) throw new ArchitectureQueryError('ARCHITECTURE_SNAPSHOT_CHANGED', 'The active architecture snapshot changed while paging.', 409);
    const offset = cursor?.offset ?? 0;
    if (offset >= page.totalRootCount && cursor) throw new ArchitectureQueryError('INVALID_CURSOR', 'Cursor offset is outside the result set.', 400);
    if (query.node !== undefined && page.rootIds.length === 0) throw new ArchitectureQueryError('ARCHITECTURE_NODE_NOT_FOUND', `Node '${query.node}' was not found in the active architecture snapshot.`);
    const roots = page.rootIds;
    const closure = { nodes: snapshot.nodes, edges: snapshot.edges };
    if (closure.nodes.length > 250 || closure.edges.length > 200) throw tooLarge();
    const projection = { nodes: closure.nodes, edges: closure.edges };
    const projectionEvidence = snapshot.evidence;
    const nodeEvidence = new Map<string, AnalysisEvidence[]>(), edgeEvidence = new Map<string, AnalysisEvidence[]>();
    for (const item of projectionEvidence) {
      const target = item.subjectKind === 'node' ? nodeEvidence : edgeEvidence;
      target.set(item.subjectId, [...(target.get(item.subjectId) ?? []), item]);
    }
    const includedCount = query.includeEvidence ? closure.nodes.reduce((n, item) => n + (nodeEvidence.get(item.id)?.length ?? 0), 0) + closure.edges.reduce((n, item) => n + (edgeEvidence.get(item.id)?.length ?? 0), 0) : 0;
    if (includedCount > 5000) throw tooLarge();
    const diagnostics = query.includeDiagnostics ? relevantDiagnostics(snapshot.diagnostics, projection.nodes, projection.edges, projectionEvidence) : undefined;
    if (diagnostics && diagnostics.length > 1000) throw tooLarge();
    const nextOffset = offset + roots.length;
    const nextCursor = nextOffset < page.totalRootCount ? encodeCursor({ v: 1, workspace: query.workspace, analyzerId: 'builtin.architecture', generationId: snapshot.analysis.generationId, projectionSnapshotId: snapshot.projectionSnapshotId!, filters: filterHash, offset: nextOffset }) : undefined;
    const result = {
      workspace: snapshot.workspace,
      analysis: { ...snapshot.analysis, inputGenerations: snapshot.inputGenerations ?? [], diagnostics: diagnosticCounts(snapshot.diagnostics) },
      query: { root: query.root, ...(query.node !== undefined ? { node: query.node } : {}), ...(query.namespace !== undefined ? { namespace: query.namespace } : {}), ...(query.method !== undefined ? { method: query.method } : {}), ...(query.path !== undefined ? { path: query.path } : {}), ...(query.finding !== undefined ? { finding: query.finding } : {}), depth: query.depth },
      page: { limit: query.limit, rootCount: roots.length, totalRootCount: page.totalRootCount, ...(nextCursor ? { nextCursor } : {}) },
      rootIds: roots,
      nodes: projection.nodes.map((node) => projectNode(node, nodeEvidence.get(node.id) ?? [], query.includeEvidence)),
      edges: projection.edges.map((edge) => projectEdge(edge, edgeEvidence.get(edge.id) ?? [], query.includeEvidence)),
      ...(diagnostics ? { diagnostics } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 3 * 1_048_576) throw tooLarge();
    return result;
  }
}

export function parseArchitectureQuery(params: URLSearchParams): { query: ArchitectureQuery } | { error: string; code: 'WORKSPACE_REQUIRED' | 'INVALID_ARCHITECTURE_QUERY' } {
  const fail = (error: string) => ({ error, code: 'INVALID_ARCHITECTURE_QUERY' as const });
  const allowed = new Set(['workspace', 'root', 'node', 'namespace', 'method', 'path', 'finding', 'limit', 'depth', 'cursor', 'include']);
  const values = new Map<string, string>();
  for (const [key, value] of params) { if (!allowed.has(key)) return fail(`Unknown query parameter '${key}'.`); if (values.has(key)) return fail(`Query parameter '${key}' must be supplied at most once.`); values.set(key, value); }
  const workspace = values.get('workspace');
  if (workspace === undefined || workspace.length === 0) return { error: 'workspace is required.', code: 'WORKSPACE_REQUIRED' };
  if (workspace.length > 256) return fail('workspace is invalid.');
  const root = values.get('root') ?? 'endpoint';
  if (!['endpoint', 'handler', 'model', 'table', 'finding'].includes(root)) return fail('root must be endpoint, handler, model, table, or finding.');
  const node = values.get('node'); if (node !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/.test(node)) return fail('node must be a stable node id.');
  const namespace = values.get('namespace'); if (namespace !== undefined && (namespace.length > 256 || namespace.includes('\0'))) return fail('namespace is invalid.');
  const method = values.get('method'); if (method !== undefined && !['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'].includes(method)) return fail('method must be an uppercase HTTP method.');
  const path = values.get('path'); if (path !== undefined && (!path.startsWith('/') || path.length > 2048 || /[\u0000-\u001f\u007f?#]/.test(path))) return fail('path must be an absolute route path without query, fragment, or control characters.');
  const finding = values.get('finding'); if (finding !== undefined && !['gap', 'ambiguous', 'unresolved', 'mismatch'].includes(finding)) return fail('finding must be gap, ambiguous, unresolved, or mismatch.');
  const limitText = values.get('limit') ?? '25'; if (!/^[1-9]\d*$/.test(limitText) || Number(limitText) > 100) return fail('limit must be an integer between 1 and 100.');
  const depthText = values.get('depth') ?? '3'; if (!/^(0|[1-6])$/.test(depthText)) return fail('depth must be an integer between 0 and 6.');
  const includeText = values.get('include'); const include = includeText === undefined ? [] : includeText.split(',');
  if (includeText === '' || include.some((item) => !['evidence', 'diagnostics'].includes(item)) || new Set(include).size !== include.length) return fail('include accepts a comma-separated list of evidence and diagnostics.');
  if (finding !== undefined && root !== 'finding') return fail('finding filter requires root=finding.');
  if ((namespace !== undefined || method !== undefined || path !== undefined) && root !== 'endpoint') return fail('namespace, method, and path filters require root=endpoint.');
  if (node !== undefined && (namespace !== undefined || method !== undefined || path !== undefined || finding !== undefined || values.has('cursor'))) return fail('node cannot be combined with semantic filters or cursor.');
  return { query: { workspace, root: root as ArchitectureRoot, ...(node !== undefined ? { node } : {}), ...(namespace !== undefined ? { namespace } : {}), ...(method !== undefined ? { method } : {}), ...(path !== undefined ? { path } : {}), ...(finding !== undefined ? { finding: finding as ArchitectureQuery['finding'] } : {}), limit: Number(limitText), depth: Number(depthText), ...(values.has('cursor') ? { cursor: values.get('cursor')! } : {}), includeEvidence: include.includes('evidence'), includeDiagnostics: include.includes('diagnostics') } };
}

function selectRoots(snapshot: Snapshot, query: ArchitectureQuery): GraphNode[] {
  if (query.node !== undefined) return snapshot.nodes.filter((node) => node.id === query.node).sort((a, b) => cmp([a.id], [b.id]));
  const handledFunctions = new Set(snapshot.edges.filter((edge) => edge.kind === 'handled_by').map((edge) => edge.targetId));
  const kinds: Record<ArchitectureRoot, string[]> = { endpoint: ['api_endpoint'], handler: ['python_function', 'python_async_function'], model: ['sqlalchemy_model'], table: ['sqlalchemy_table'], finding: ['architecture_contract_gap', 'architecture_contract_ambiguous', 'architecture_contract_unresolved', 'architecture_contract_mismatch'] };
  return snapshot.nodes.filter((node) => {
    if (!kinds[query.root].includes(node.kind) || (query.root === 'handler' && !handledFunctions.has(node.id))) return false;
    const p = node.properties;
    if (query.namespace !== undefined && p.namespace !== query.namespace) return false;
    if (query.method !== undefined && !(p.method === query.method || (Array.isArray(p.methods) && p.methods.includes(query.method)))) return false;
    if (query.path !== undefined && p.path !== query.path) return false;
    if (query.finding !== undefined && node.kind !== `architecture_contract_${query.finding}`) return false;
    return true;
  }).sort((a, b) => cmp(rootSortKey(a), rootSortKey(b)));
}
function rootSortKey(node: GraphNode): Array<string | number> { const p = node.properties; return [String(p.namespace ?? ''), String(p.method ?? (Array.isArray(p.methods) ? [...p.methods].sort()[0] ?? '' : '')), String(p.path ?? ''), String(p.module ?? ''), String(p.qualifiedName ?? ''), String(p.databaseNamespace ?? ''), String(p.schema ?? ''), String(p.tableName ?? ''), node.kind, node.id]; }
function buildClosure(snapshot: Snapshot, roots: GraphNode[], depth: number) {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, Array<{ edge: GraphEdge; id: string }>>();
  for (const edge of snapshot.edges) if (EDGE_ALLOWLIST.has(edge.kind) && byId.has(edge.sourceId) && byId.has(edge.targetId)) {
    adjacency.set(edge.sourceId, [...(adjacency.get(edge.sourceId) ?? []), { edge, id: edge.targetId }]);
    adjacency.set(edge.targetId, [...(adjacency.get(edge.targetId) ?? []), { edge, id: edge.sourceId }]);
  }
  for (const list of adjacency.values()) list.sort((a, b) => cmp([a.id, a.edge.id], [b.id, b.edge.id]));
  const distance = new Map<string, number>(), queue: string[] = [];
  for (const root of roots) if (byId.has(root.id) && !distance.has(root.id)) { distance.set(root.id, 0); queue.push(root.id); }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor]!, d = distance.get(id)!;
    if (d >= depth) continue;
    for (const item of adjacency.get(id) ?? []) if (!distance.has(item.id)) { distance.set(item.id, d + 1); queue.push(item.id); if (queue.length > 250) throw tooLarge(); }
  }
  const selectedEdges = snapshot.edges.filter((edge) => EDGE_ALLOWLIST.has(edge.kind) && distance.has(edge.sourceId) && distance.has(edge.targetId));
  if (selectedEdges.length > 200) throw tooLarge();
  return { nodes: [...distance.keys()].map((id) => byId.get(id)!).sort((a, b) => cmp([a.kind, a.id], [b.kind, b.id])), edges: selectedEdges.sort((a, b) => cmp([a.kind, a.sourceId, a.targetId, a.id], [b.kind, b.sourceId, b.targetId, b.id])) };
}
function projectNode(node: GraphNode, evidence: AnalysisEvidence[], include: boolean) { const { evidence: _evidence, ...base } = node; const sorted = evidence.slice().sort((a, b) => cmp([a.id ?? ''], [b.id ?? ''])); return { ...base, level: node.level ?? dominant(sorted), evidenceCount: node.evidenceCount ?? sorted.length, ...(include ? { evidence: sorted } : {}) }; }
function projectEdge(edge: GraphEdge, evidence: AnalysisEvidence[], include: boolean) { const { evidence: _evidence, ...base } = edge; const sorted = evidence.slice().sort((a, b) => cmp([a.id ?? ''], [b.id ?? ''])); return { ...base, level: edge.level ?? dominant(sorted), evidenceCount: edge.evidenceCount ?? sorted.length, ...(include ? { evidence: sorted } : {}) }; }
function dominant(items: AnalysisEvidence[]): 'DIRECT' | 'DERIVED' | 'INFERRED' { return items.some((x) => x.level === 'DIRECT') ? 'DIRECT' : items.some((x) => x.level === 'DERIVED') ? 'DERIVED' : 'INFERRED'; }
function relevantDiagnostics(items: StoredAnalysisDiagnostic[], nodes: GraphNode[], edges: GraphEdge[], evidence: AnalysisEvidence[]): AnalysisDiagnostic[] {
  const ids = new Set([...nodes.map((n) => n.id), ...edges.map((e) => e.id)]);
  const uris = new Set(evidence.filter((e) => ids.has(e.subjectId) && e.uri).map((e) => e.uri!));
  return items.filter((item) => { const detail = item.detail && typeof item.detail === 'object' ? item.detail as Record<string, unknown> : {}; const related = [detail.endpointId, detail.fastApiEndpointId, detail.openApiEndpointId].some((id) => typeof id === 'string' && ids.has(id)); const hasSubject = [detail.endpointId, detail.fastApiEndpointId, detail.openApiEndpointId].some((id) => typeof id === 'string'); return related || (!item.uri && !hasSubject) || (!!item.uri && uris.has(item.uri)); }).map(({ sequence: _sequence, generationId: _generationId, ...item }) => item);
}
function diagnosticCounts(items: StoredAnalysisDiagnostic[]) { return { total: items.length, info: items.filter((i) => i.severity === 'info').length, warning: items.filter((i) => i.severity === 'warning').length, error: items.filter((i) => i.severity === 'error').length }; }
function filterKey(query: ArchitectureQuery) { return JSON.stringify({ root: query.root, node: query.node ?? null, namespace: query.namespace ?? null, method: query.method ?? null, path: query.path ?? null, finding: query.finding ?? null, limit: query.limit, depth: query.depth, includeEvidence: query.includeEvidence, includeDiagnostics: query.includeDiagnostics }); }
function encodeCursor(cursor: Cursor) { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
function decodeCursor(raw: string): Cursor {
  if (!raw || raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new ArchitectureQueryError('INVALID_CURSOR', 'Cursor is invalid.', 400);
  let value: unknown; try { const bytes = Buffer.from(raw, 'base64url'); if (bytes.toString('base64url') !== raw) throw new Error(); value = JSON.parse(bytes.toString('utf8')); } catch { throw new ArchitectureQueryError('INVALID_CURSOR', 'Cursor is invalid.', 400); }
  if (!record(value) || Object.keys(value).sort().join(',') !== 'analyzerId,filters,generationId,offset,projectionSnapshotId,v,workspace' || value.v !== 1 || value.analyzerId !== 'builtin.architecture' || typeof value.workspace !== 'string' || value.workspace.length < 1 || value.workspace.length > 256 || typeof value.filters !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.filters) || typeof value.projectionSnapshotId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.projectionSnapshotId) || !Number.isSafeInteger(value.generationId) || Number(value.generationId) < 1 || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0) throw new ArchitectureQueryError('INVALID_CURSOR', 'Cursor is invalid.', 400);
  return value as Cursor;
}
function tooLarge() { return new ArchitectureQueryError('ARCHITECTURE_QUERY_TOO_LARGE', 'Architecture query exceeds a hard response limit; no partial result was returned.', 422); }
function cmp(a: Array<string | number>, b: Array<string | number>) { for (let i = 0; i < Math.min(a.length, b.length); i++) { if (a[i]! < b[i]!) return -1; if (a[i]! > b[i]!) return 1; } return a.length - b.length; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
