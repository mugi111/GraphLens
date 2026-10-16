import { createHash } from 'node:crypto';
import type { AnalysisDiagnostic, AnalysisEvidence } from '../domain/analyzer.js';
import type { ArchitectureEdgeKind, CrossWorkspaceEvidence, CrossWorkspaceResolution, CrossWorkspaceSnapshot, SystemEdge, SystemNode, WorkspaceArchitectureSnapshot } from '../domain/federation.js';
import type { GraphEdge, GraphNode } from '../domain/graph.js';
import { CrossWorkspaceResolutionError, resolveCrossWorkspace } from './cross-workspace-resolver.js';
import type { GraphStore } from '../infrastructure/sqlite/graph-store.js';
import { GraphProjectionError } from './unified-graph-projection.js';

export type CrossWorkspaceRoot = 'contract' | 'endpoint';
export type CrossWorkspaceArchitectureQuery = {
  workspaces: string[];
  root: CrossWorkspaceRoot;
  namespace?: string;
  method?: string;
  path?: string;
  workspace?: string;
  depth: number;
  limit: number;
  cursor?: string;
  includeEvidence: boolean;
  includeDiagnostics: boolean;
};

type Cursor = { v: 1; workspaces: string[]; filters: string; snapshotId: string; offset: number };
const edgeAllowlist = new Set<ArchitectureEdgeKind>(['implements_contract', 'architecture_contract_finding', 'exposes', 'handled_by', 'depends_on', 'calls', 'references', 'accepts', 'returns', 'uses_schema', 'secured_by', 'uses_scheme', 'maps_to', 'contains', 'accesses_model', 'http_request']);
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH']);

export class CrossWorkspaceQueryError extends Error {
  constructor(public readonly code: 'WORKSPACES_REQUIRED' | 'INVALID_CROSS_WORKSPACE_QUERY' | 'INVALID_CURSOR' | 'CURSOR_QUERY_MISMATCH' | 'WORKSPACE_NOT_FOUND' | 'INSUFFICIENT_ACTIVE_ARCHITECTURE_WORKSPACES' | 'CROSS_WORKSPACE_SNAPSHOT_CHANGED' | 'CROSS_WORKSPACE_QUERY_TOO_LARGE' | 'CROSS_WORKSPACE_QUERY_FAILED', message: string, public readonly status: 400 | 404 | 409 | 422 | 500) { super(message); }
}

export class CrossWorkspaceQueryService {
  constructor(private readonly store: GraphStore) {}

  query(query: CrossWorkspaceArchitectureQuery) {
    const workspaceIds = [...query.workspaces].sort();
    const filters = filterKey(query);
    const filterHash = createHash('sha256').update(filters).digest('base64url');
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (cursor && (JSON.stringify(cursor.workspaces) !== JSON.stringify(workspaceIds) || cursor.filters !== filterHash)) throw new CrossWorkspaceQueryError('CURSOR_QUERY_MISMATCH', 'Cursor does not belong to this workspace set and query.', 400);

    const snapshot = this.readSnapshot(workspaceIds);
    if (cursor && cursor.snapshotId !== snapshot.snapshotId) throw new CrossWorkspaceQueryError('CROSS_WORKSPACE_SNAPSHOT_CHANGED', 'An active architecture generation changed while paging.', 409);
    if (snapshot.generations.length < 2) throw new CrossWorkspaceQueryError('INSUFFICIENT_ACTIVE_ARCHITECTURE_WORKSPACES', 'At least two selected workspaces need an active architecture generation.', 409);

    let resolution: CrossWorkspaceResolution;
    try { resolution = resolveCrossWorkspace(snapshot); }
    catch (error) {
      if (error instanceof CrossWorkspaceResolutionError && error.code === 'CROSS_WORKSPACE_LIMIT_EXCEEDED') throw tooLarge();
      throw new CrossWorkspaceQueryError('CROSS_WORKSPACE_QUERY_FAILED', 'Could not resolve the cross-workspace architecture graph.', 500);
    }
    const graph = buildSystemGraph(snapshot, resolution, false);
    const workspaceNames = new Map(snapshot.generations.map((item) => [item.workspace.id, item.workspace.name]));
    const roots = selectRoots(graph.nodes, graph.edges, query, workspaceIds, workspaceNames);
    const offset = cursor?.offset ?? 0;
    if (cursor && offset >= roots.length) throw new CrossWorkspaceQueryError('INVALID_CURSOR', 'Cursor offset is outside the result set.', 400);
    const pageRoots = roots.slice(offset, offset + query.limit);
    const closure = buildClosure(graph.nodes, graph.edges, pageRoots, query.depth);
    if (closure.nodes.length > 250 || closure.edges.length > 200) throw tooLarge();
    const selectedNodeKeys=new Set(closure.nodes.filter((node)=>node.scope==='workspace').map((node)=>systemNodeKey(node.workspaceId,node.id)));
    const selectedEdgeKeys=new Set(closure.edges.filter((edge)=>edge.scope==='workspace').map((edge)=>edge.id));
    const sourceNodes=snapshot.generations.flatMap((item)=>item.nodes.filter((node)=>selectedNodeKeys.has(systemNodeKey(item.workspace.id,node.id))));
    const sourceEdges=snapshot.generations.flatMap((item)=>item.edges.filter((edge)=>selectedEdgeKeys.has(systemEdgeKey(item.workspace.id,edge.id))));
    let hydrated;
    try { hydrated=this.store.projectGraphAtSnapshot(sourceNodes,sourceEdges,[...snapshot.activeGenerationVector],query.includeEvidence); }
    catch(error){if(error instanceof Error&&error.message==='UNIFIED_GRAPH_SNAPSHOT_CHANGED')throw new CrossWorkspaceQueryError('CROSS_WORKSPACE_SNAPSHOT_CHANGED','An active architecture generation changed while paging.',409);if(error instanceof GraphProjectionError||(error instanceof Error&&error.message==='UNIFIED_GRAPH_LIMIT_EXCEEDED'))throw tooLarge();throw error;}
    const hydratedNodes=new Map(hydrated.nodes.map((node)=>[systemNodeKey(node.workspaceId,node.id),node]));
    const hydratedEdges=new Map(hydrated.edges.map((edge)=>[systemEdgeKey(edge.workspaceId,edge.id),edge]));
    let selectedCrossEdges=new Map<string,SystemEdge>();
    if(query.includeEvidence){try{const evidenceSnapshot=withHydratedEvidence(snapshot,hydrated.nodes,hydrated.edges);selectedCrossEdges=new Map(resolveCrossWorkspace(evidenceSnapshot).edges.filter((edge)=>edge.scope==='cross-workspace').map((edge)=>[edge.id,edge]));}catch(error){if(error instanceof CrossWorkspaceResolutionError&&error.code==='CROSS_WORKSPACE_LIMIT_EXCEEDED')throw tooLarge();throw new CrossWorkspaceQueryError('CROSS_WORKSPACE_QUERY_FAILED','Could not resolve selected evidence provenance.',500);}}
    const outputNodes=closure.nodes.map((node)=>{if(node.scope!=='workspace')return node;const source=hydratedNodes.get(systemNodeKey(node.workspaceId,node.id));return source?{...node,properties:source.properties,level:source.level??node.level,contributors:source.contributors,propertySources:source.propertySources,propertyConflicts:source.propertyConflicts}:node;});
    const workspaceById=new Map(snapshot.generations.map((item)=>[item.workspace.id,item]));
    const outputEdges=closure.edges.map((edge)=>{if(edge.scope==='cross-workspace')return selectedCrossEdges.get(edge.id)??edge;const original=sourceEdges.find((item)=>systemEdgeKey(item.workspaceId,item.id)===edge.id);const source=original?hydratedEdges.get(systemEdgeKey(original.workspaceId,original.id)):undefined;if(!original||!source)return edge;const workspace=workspaceById.get(original.workspaceId)!;return {...edge,properties:source.properties,level:source.level??edge.level,contributors:source.contributors,propertySources:source.propertySources,propertyConflicts:source.propertyConflicts,evidence:query.includeEvidence?[toCrossEvidence(workspace,original.sourceId,edge.id,'edge',source.evidence??[])]:[]};});
    const evidenceCost=outputEdges.reduce((total,edge)=>total+edge.evidence.reduce((sum,item)=>sum+1+item.sources.reduce((sourceCount,source)=>sourceCount+source.evidenceIds.length,0),0),0);
    if(query.includeEvidence&&evidenceCost>5000)throw tooLarge();
    const diagnostics = query.includeDiagnostics ? relevantDiagnostics(resolution.diagnostics, closure.nodes) : undefined;
    if (diagnostics && diagnostics.length > 1000) throw tooLarge();
    const nextOffset = offset + pageRoots.length;
    const nextCursor = nextOffset < roots.length ? encodeCursor({ v: 1, workspaces: workspaceIds, filters: filterHash, snapshotId: snapshot.snapshotId, offset: nextOffset }) : undefined;
    const workspaceMetadata = workspaceIds.map((id) => {
      const active = snapshot.generations.find((item) => item.workspace.id === id);
      const workspace = active?.workspace ?? this.store.getWorkspace(id);
      if (!workspace) throw new CrossWorkspaceQueryError('WORKSPACE_NOT_FOUND', `Workspace '${id}' was not found.`, 404);
      return { id: workspace.id, name: workspace.name };
    });
    const response = {
      scope: { workspaceIds, workspaces: workspaceMetadata, missingArchitectureWorkspaceIds: [...snapshot.missingArchitectureWorkspaceIds] },
      snapshot: {
        id: snapshot.snapshotId,
        generations: snapshot.generations.map((item) => item.generation),
        activeGenerations: snapshot.activeGenerationVector,
        inputGenerations: snapshot.generations.flatMap((item) => item.inputGenerations.map((input) => ({ workspaceId: item.workspace.id, ...input }))).sort((a, b) => cmp([a.workspaceId, a.analyzerId, a.generationId], [b.workspaceId, b.analyzerId, b.generationId])),
      },
      query: { root: query.root, ...(query.namespace !== undefined ? { namespace: query.namespace } : {}), ...(query.method !== undefined ? { method: query.method } : {}), ...(query.path !== undefined ? { path: query.path } : {}), ...(query.workspace !== undefined ? { workspace: query.workspace } : {}), depth: query.depth },
      page: { limit: query.limit, rootCount: pageRoots.length, totalRootCount: roots.length, ...(nextCursor ? { nextCursor } : {}) },
      rootIds: pageRoots.map((node) => node.id),
      nodes: outputNodes,
      edges: outputEdges,
      ...(diagnostics ? { diagnostics } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 3 * 1_048_576) throw tooLarge();
    return response;
  }

  private readSnapshot(workspaceIds: string[]): CrossWorkspaceSnapshot {
    try { return this.store.crossWorkspaceArchitectureSnapshot(workspaceIds, false); }
    catch (error) {
      if (error instanceof GraphProjectionError || (error instanceof Error && error.message === 'UNIFIED_GRAPH_LIMIT_EXCEEDED')) throw tooLarge();
      const message = error instanceof Error ? error.message : String(error);
      if (/^Workspace not found:/.test(message)) throw new CrossWorkspaceQueryError('WORKSPACE_NOT_FOUND', message, 404);
      throw new CrossWorkspaceQueryError('CROSS_WORKSPACE_QUERY_FAILED', 'Could not read the cross-workspace architecture snapshot.', 500);
    }
  }
}

export function parseCrossWorkspaceArchitectureQuery(params: URLSearchParams): { query: CrossWorkspaceArchitectureQuery } | { error: string; code: 'WORKSPACES_REQUIRED' | 'INVALID_CROSS_WORKSPACE_QUERY' } {
  const fail = (error: string) => ({ error, code: 'INVALID_CROSS_WORKSPACE_QUERY' as const });
  const allowed = new Set(['workspaces', 'root', 'namespace', 'method', 'path', 'workspace', 'depth', 'limit', 'cursor', 'include']);
  const values = new Map<string, string>();
  for (const [key, value] of params) {
    if (!allowed.has(key)) return fail(`Unknown query parameter '${key}'.`);
    if (values.has(key)) return fail(`Query parameter '${key}' must be supplied at most once.`);
    values.set(key, value);
  }
  const rawWorkspaces = values.get('workspaces');
  if (rawWorkspaces === undefined || rawWorkspaces.length === 0) return { error: 'workspaces is required.', code: 'WORKSPACES_REQUIRED' };
  const workspaces = rawWorkspaces.split(',');
  if (workspaces.length < 2 || workspaces.length > 16 || workspaces.some((id) => !id || id.length > 256) || new Set(workspaces).size !== workspaces.length) return fail('workspaces must contain 2–16 unique workspace IDs.');
  const root = values.get('root') ?? 'contract';
  if (root !== 'contract' && root !== 'endpoint') return fail("root must be 'contract' or 'endpoint'.");
  const namespace = values.get('namespace');
  if (namespace !== undefined && (!namespace || namespace.length > 256 || namespace.includes('\0'))) return fail('namespace is invalid.');
  const method = values.get('method');
  if (method !== undefined && !methods.has(method)) return fail('method must be an uppercase HTTP method.');
  const path = values.get('path');
  if (path !== undefined && (!path.startsWith('/') || path.length > 2048 || /[\u0000-\u001f\u007f?#]/.test(path))) return fail('path must be an absolute route path without query, fragment, or control characters.');
  const workspace = values.get('workspace');
  if (workspace !== undefined && (!workspace || workspace.length > 256 || !workspaces.includes(workspace))) return fail('workspace must be one of the selected workspace IDs.');
  const depthText = values.get('depth') ?? '4';
  if (!/^(0|[1-8])$/.test(depthText)) return fail('depth must be an integer between 0 and 8.');
  const limitText = values.get('limit') ?? '25';
  if (!/^[1-9]\d*$/.test(limitText) || !Number.isSafeInteger(Number(limitText)) || Number(limitText) > 100) return fail('limit must be an integer between 1 and 100.');
  const includeText = values.get('include');
  const include = includeText === undefined ? [] : includeText.split(',');
  if (includeText === '' || include.some((item) => !['evidence', 'diagnostics'].includes(item)) || new Set(include).size !== include.length) return fail('include accepts a comma-separated list of evidence and diagnostics.');
  return { query: { workspaces, root, ...(namespace !== undefined ? { namespace } : {}), ...(method !== undefined ? { method } : {}), ...(path !== undefined ? { path } : {}), ...(workspace !== undefined ? { workspace } : {}), depth: Number(depthText), limit: Number(limitText), ...(values.has('cursor') ? { cursor: values.get('cursor')! } : {}), includeEvidence: include.includes('evidence'), includeDiagnostics: include.includes('diagnostics') } };
}

function buildSystemGraph(snapshot: CrossWorkspaceSnapshot, resolution: CrossWorkspaceResolution, includeEvidence: boolean) {
  const nodes = new Map<string, SystemNode>();
  const edges = new Map<string, SystemEdge>();
  const sourceEvidence = new Map<string, AnalysisEvidence[]>();
  for (const workspace of snapshot.generations) {
    for (const item of workspace.evidence) sourceEvidence.set(`${workspace.workspace.id}\0${item.subjectKind}\0${item.subjectId}`, [...(sourceEvidence.get(`${workspace.workspace.id}\0${item.subjectKind}\0${item.subjectId}`) ?? []), item]);
    for (const node of workspace.nodes) nodes.set(systemNodeKey(workspace.workspace.id, node.id), projectSystemNode(workspace, node, sourceEvidence.get(`${workspace.workspace.id}\0node\0${node.id}`) ?? []));
  }
  for (const workspace of snapshot.generations) for (const edge of workspace.edges) {
    if (!edgeAllowlist.has(edge.kind as ArchitectureEdgeKind)) continue;
    const items = sourceEvidence.get(`${workspace.workspace.id}\0edge\0${edge.id}`) ?? [];
    const id = systemEdgeKey(workspace.workspace.id, edge.id);
    edges.set(id, { id, scope: 'workspace', sourceId: edge.sourceId, targetId: edge.targetId, sourceWorkspaceId: workspace.workspace.id, targetWorkspaceId: workspace.workspace.id, kind: edge.kind as ArchitectureEdgeKind, level: edge.level ?? dominant(items), properties: edge.properties, contributors: edge.contributors, propertySources: edge.propertySources, propertyConflicts: edge.propertyConflicts, evidence: includeEvidence ? [toCrossEvidence(workspace, edge.sourceId, id, 'edge', items)] : [] });
  }
  for (const node of resolution.nodes) nodes.set(node.scope === 'global' ? `global\0${node.id}` : systemNodeKey(node.workspaceId, node.id), node);
  for (const edge of resolution.edges) {
    if (edge.scope !== 'cross-workspace') continue;
    edges.set(`cross\0${edge.id}`, includeEvidence ? edge : { ...edge, evidence: [] });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function projectSystemNode(workspace: WorkspaceArchitectureSnapshot, node: GraphNode, items: readonly AnalysisEvidence[]): SystemNode {
  return { scope: 'workspace', workspaceId: workspace.workspace.id, id: node.id, kind: node.kind, label: node.label, properties: node.properties, level: node.level ?? dominant(items), contributors: node.contributors, propertySources: node.propertySources, propertyConflicts: node.propertyConflicts };
}
function toCrossEvidence(workspace: WorkspaceArchitectureSnapshot, nodeId: string, subjectId: string, subjectKind: 'node' | 'edge', items: readonly AnalysisEvidence[]): CrossWorkspaceEvidence {
  const grouped = new Map<string, { workspaceId: string; analyzerId: string; generationId: number; nodeId: string; evidenceIds: Set<string> }>();
  const references = new Map<string, { workspaceId: string; analyzerId: string; generationId: number; evidenceIds: Set<string> }>();
  let sourceLocationsUnavailable = false;
  const addReference = (analyzerId: unknown, generationId: unknown, evidenceId: unknown, hasUri: boolean, requireInput: boolean) => {
    if (!hasUri || typeof analyzerId !== 'string' || typeof generationId !== 'number' || !Number.isSafeInteger(generationId) || typeof evidenceId !== 'string' || !evidenceId) { sourceLocationsUnavailable = true; return; }
    if (!workspace.activeGenerations.some((active) => active.analyzerId === analyzerId && active.generationId === generationId)) { sourceLocationsUnavailable = true; return; }
    if (requireInput && !workspace.inputGenerations.some((input) => input.analyzerId === analyzerId && input.generationId === generationId)) { sourceLocationsUnavailable = true; return; }
    const key = `${analyzerId}\0${generationId}`;
    const entry = references.get(key) ?? { workspaceId: workspace.workspace.id, analyzerId, generationId, evidenceIds: new Set<string>() };
    entry.evidenceIds.add(evidenceId); references.set(key, entry);
  };
  for (const item of items) {
    const analyzerId = item.analyzerId ?? workspace.generation.analyzerId;
    const generationId = item.generationId ?? workspace.generation.generationId;
    const key = `${analyzerId}\0${generationId}`;
    const source = grouped.get(key) ?? { workspaceId: workspace.workspace.id, analyzerId, generationId, nodeId, evidenceIds: new Set<string>() };
    source.evidenceIds.add(item.id); grouped.set(key, source);
    const provenance = item.provenance;
    if (typeof item.uri === 'string' && analyzerId !== workspace.generation.analyzerId) addReference(analyzerId, generationId, item.id, true, false);
    else if (provenance && typeof provenance === 'object') {
      if (typeof provenance.analyzerId === 'string' && typeof provenance.generationId === 'number' && typeof provenance.sourceEvidenceId === 'string') addReference(provenance.analyzerId, provenance.generationId, provenance.sourceEvidenceId, typeof item.uri === 'string', true);
      else if (Array.isArray(provenance.sources)) {
        if (!provenance.sources.length) sourceLocationsUnavailable = true;
        for (const value of provenance.sources) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) { sourceLocationsUnavailable = true; continue; }
          const candidate = value as Record<string, unknown>;
          const input = workspace.inputGenerations.find((entry) => entry.analyzerId === candidate.analyzerId);
          addReference(candidate.analyzerId, input?.generationId, candidate.evidenceId, typeof candidate.uri === 'string', true);
        }
      } else sourceLocationsUnavailable = true;
    } else if (typeof item.uri === 'string') addReference(analyzerId, generationId, item.id, true, false);
    else sourceLocationsUnavailable = true;
  }
  if (!grouped.size) grouped.set(`${workspace.generation.analyzerId}\0${workspace.generation.generationId}`, { workspaceId: workspace.workspace.id, analyzerId: workspace.generation.analyzerId, generationId: workspace.generation.generationId, nodeId, evidenceIds: new Set() });
  return { id: `cross-evidence://${workspace.workspace.id}/${subjectKind}/${encodeURIComponent(subjectId)}`, subjectKind, subjectId, level: 'DERIVED', type: 'architecture.source_evidence', sources: [...grouped.values()].map((source) => ({ ...source, evidenceIds: [...source.evidenceIds].sort() })).sort((a, b) => cmp([a.workspaceId, a.analyzerId, a.generationId, a.nodeId], [b.workspaceId, b.analyzerId, b.generationId, b.nodeId])), sourceReferences: [...references.values()].map((source) => ({ workspaceId: source.workspaceId, analyzerId: source.analyzerId, generationId: source.generationId, evidenceIds: [...source.evidenceIds].sort() })).sort((a, b) => cmp([a.workspaceId, a.analyzerId, a.generationId], [b.workspaceId, b.analyzerId, b.generationId))), sourceLocationsUnavailable };
}

function selectRoots(nodes: SystemNode[], edges: SystemEdge[], query: CrossWorkspaceArchitectureQuery, workspaceIds: string[], workspaceNames: Map<string, string>) {
  const globalWorkspaceOwners = new Map<string, Set<string>>();
  for (const edge of edges) if (edge.scope === 'cross-workspace') {
    if (edge.sourceId.startsWith('api-contract://')) globalWorkspaceOwners.set(edge.sourceId, new Set([...(globalWorkspaceOwners.get(edge.sourceId) ?? []), edge.targetWorkspaceId ?? edge.sourceWorkspaceId ?? '']));
    else if (edge.targetId.startsWith('api-contract://')) globalWorkspaceOwners.set(edge.targetId, new Set([...(globalWorkspaceOwners.get(edge.targetId) ?? []), edge.sourceWorkspaceId ?? edge.targetWorkspaceId ?? '']));
  }
  return nodes.filter((node) => {
    if (query.root === 'contract' ? node.scope !== 'global' || node.kind !== 'api_contract' : node.scope !== 'workspace' || node.kind !== 'api_endpoint') return false;
    const properties = node.properties;
    if (query.namespace !== undefined && properties.namespace !== query.namespace) return false;
    if (query.method !== undefined && properties.method !== query.method) return false;
    if (query.path !== undefined && properties.path !== query.path) return false;
    if (query.workspace !== undefined) {
      if (node.scope === 'workspace' && node.workspaceId !== query.workspace) return false;
      if (node.scope === 'global' && !globalWorkspaceOwners.get(node.id)?.has(query.workspace)) return false;
    }
    if (node.scope === 'workspace' && !workspaceIds.includes(node.workspaceId)) return false;
    return true;
  }).sort((a, b) => query.root === 'contract'
    ? cmp([String(a.properties.namespace), String(a.properties.method), String(a.properties.path), a.id], [String(b.properties.namespace), String(b.properties.method), String(b.properties.path), b.id])
    : cmp([a.scope === 'workspace' ? a.workspaceId : '', a.scope === 'workspace' ? workspaceNames.get(a.workspaceId) ?? '' : '', String(a.properties.namespace ?? ''), String(a.properties.method ?? ''), String(a.properties.path ?? ''), a.id], [b.scope === 'workspace' ? b.workspaceId : '', b.scope === 'workspace' ? workspaceNames.get(b.workspaceId) ?? '' : '', String(b.properties.namespace ?? ''), String(b.properties.method ?? ''), String(b.properties.path ?? ''), b.id]));
}
function buildClosure(allNodes: SystemNode[], allEdges: SystemEdge[], roots: SystemNode[], maxDepth: number) {
  const byId = new Map(allNodes.map((node) => [systemNodeKey(node.scope === 'workspace' ? node.workspaceId : 'global', node.id), node]));
  const findNodeKey = (id: string, workspaceId?: string) => workspaceId !== undefined ? systemNodeKey(workspaceId, id) : byId.has(systemNodeKey('global', id)) ? systemNodeKey('global', id) : undefined;
  const adjacency = new Map<string, Array<{ edge: SystemEdge; next: string }>>();
  const edgeRecords: Array<{ edge: SystemEdge; source: string; target: string }> = [];
  for (const edge of allEdges) {
    const source = findNodeKey(edge.sourceId, edge.sourceWorkspaceId);
    const target = findNodeKey(edge.targetId, edge.targetWorkspaceId);
    if (!source || !target) continue;
    edgeRecords.push({ edge, source, target });
    adjacency.set(source, [...(adjacency.get(source) ?? []), { edge, next: target }]);
    adjacency.set(target, [...(adjacency.get(target) ?? []), { edge, next: source }]);
  }
  for (const list of adjacency.values()) list.sort((a, b) => cmp([a.next, a.edge.kind, a.edge.id], [b.next, b.edge.kind, b.edge.id]));
  const rootKeys = roots.map((node) => systemNodeKey(node.scope === 'workspace' ? node.workspaceId : 'global', node.id));
  const distances = new Map<string, number>();
  const queue: string[] = [];
  for (const key of rootKeys) if (byId.has(key) && !distances.has(key)) { distances.set(key, 0); queue.push(key); }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const key = queue[cursor]!;
    const depth = distances.get(key)!;
    if (depth >= maxDepth) continue;
    for (const item of adjacency.get(key) ?? []) if (!distances.has(item.next)) {
      distances.set(item.next, depth + 1);
      queue.push(item.next);
      if (queue.length > 3000) throw tooLarge();
    }
  }
  const nodes = [...distances.keys()].map((key) => byId.get(key)!).sort((a, b) => cmp([a.scope, a.scope === 'workspace' ? a.workspaceId : '', a.id], [b.scope, b.scope === 'workspace' ? b.workspaceId : '', b.id]));
  const edges = edgeRecords.filter(({ source, target }) => distances.has(source) && distances.has(target)).map(({ edge }) => edge).sort((a, b) => cmp([a.scope, a.sourceWorkspaceId ?? '', a.sourceId, a.targetId, a.kind, a.id], [b.scope, b.sourceWorkspaceId ?? '', b.sourceId, b.targetId, b.kind, b.id]));
  return { nodes, edges };
}
function systemNodeKey(workspaceId: string, id: string) { return `${workspaceId}\0${id}`; }
function systemEdgeKey(workspaceId: string, id: string) { return `${workspaceId}\0${id}`; }
function withHydratedEvidence(snapshot:CrossWorkspaceSnapshot,nodes:GraphNode[],edges:GraphEdge[]):CrossWorkspaceSnapshot{
  const nodeMap=new Map(nodes.map((item)=>[systemNodeKey(item.workspaceId,item.id),item]));const edgeMap=new Map(edges.map((item)=>[systemEdgeKey(item.workspaceId,item.id),item]));
  const generations=snapshot.generations.map((workspace)=>{const selectedNodes=workspace.nodes.map((item)=>nodeMap.get(systemNodeKey(workspace.workspace.id,item.id))??item);const selectedEdges=workspace.edges.map((item)=>edgeMap.get(systemEdgeKey(workspace.workspace.id,item.id))??item);const evidence=[...selectedNodes.flatMap((item)=>item.evidence??[]),...selectedEdges.flatMap((item)=>item.evidence??[])];return {...workspace,nodes:selectedNodes,edges:selectedEdges,evidence};});
  return {...snapshot,generations};
}
function relevantDiagnostics(items: readonly AnalysisDiagnostic[], nodes: SystemNode[]) {
  const contracts = new Set(nodes.filter((node) => node.scope === 'global').map((node) => JSON.stringify(node.properties)));
  return items.filter((item) => {
    const detail = item.detail && typeof item.detail === 'object' ? item.detail as Record<string, unknown> : {};
    const tuple = JSON.stringify({ namespace: detail.namespace, method: detail.method, path: detail.path });
    return !detail.namespace || contracts.has(tuple);
  }).sort((a, b) => cmp([a.code ?? '', a.message], [b.code ?? '', b.message]));
}
function filterKey(query: CrossWorkspaceArchitectureQuery) { return JSON.stringify({ root: query.root, namespace: query.namespace ?? null, method: query.method ?? null, path: query.path ?? null, workspace: query.workspace ?? null, depth: query.depth, includeEvidence: query.includeEvidence, includeDiagnostics: query.includeDiagnostics }); }
function encodeCursor(cursor: Cursor) { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
function decodeCursor(raw: string): Cursor {
  if (!raw || raw.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new CrossWorkspaceQueryError('INVALID_CURSOR', 'Cursor is invalid.', 400);
  let value: unknown;
  try { const bytes = Buffer.from(raw, 'base64url'); if (bytes.toString('base64url') !== raw) throw new Error(); value = JSON.parse(bytes.toString('utf8')); } catch { throw new CrossWorkspaceQueryError('INVALID_CURSOR', 'Cursor is invalid.', 400); }
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'filters,offset,snapshotId,v,workspaces' || value.v !== 1 || !Array.isArray(value.workspaces) || value.workspaces.length < 2 || value.workspaces.length > 16 || value.workspaces.some((id) => typeof id !== 'string' || !id.length || id.length > 256) || new Set(value.workspaces).size !== value.workspaces.length || typeof value.filters !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.filters) || typeof value.snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshotId) || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0) throw new CrossWorkspaceQueryError('INVALID_CURSOR', 'Cursor is invalid.', 400);
  return value as Cursor;
}
function dominant(items: readonly AnalysisEvidence[]): 'DIRECT' | 'DERIVED' | 'INFERRED' { return items.some((item) => item.level === 'DIRECT') ? 'DIRECT' : items.some((item) => item.level === 'DERIVED') ? 'DERIVED' : 'INFERRED'; }
function cmp(a: readonly (string | number)[], b: readonly (string | number)[]) { for (let i = 0; i < Math.min(a.length, b.length); i++) { if (a[i]! < b[i]!) return -1; if (a[i]! > b[i]!) return 1; } return a.length - b.length; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function tooLarge() { return new CrossWorkspaceQueryError('CROSS_WORKSPACE_QUERY_TOO_LARGE', 'Cross-workspace query exceeds a hard response limit; no partial result was returned.', 422); }
