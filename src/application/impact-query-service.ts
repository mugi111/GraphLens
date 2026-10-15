import { createHash } from 'node:crypto';
import type { AnalysisEvidence } from '../domain/analyzer.js';
import type { CrossWorkspaceEvidence, CrossWorkspaceSnapshot, SystemEdge, SystemNode, WorkspaceArchitectureSnapshot } from '../domain/federation.js';
import type { GraphNode } from '../domain/graph.js';
import { CrossWorkspaceResolutionError, MAX_CONTRACT_NAMESPACE_LENGTH, MAX_CONTRACT_PATH_LENGTH, resolveCrossWorkspace } from './cross-workspace-resolver.js';
import type { GraphStore } from '../infrastructure/sqlite/graph-store.js';

export type ImpactDirection = 'dependents' | 'dependencies' | 'both';
export type ImpactQuery = { workspaces: string[]; node: string; direction: ImpactDirection; depth: number; limit: number; includeInferred: boolean; includeEvidence: boolean; includeDiagnostics: boolean };
type TraversalEdge = { edge: SystemEdge; dependent: string; dependency: string };
type Path = { nodeId: string; nodeIds: string[]; edgeIds: string[]; workspaceIds: string[]; level: 'DIRECT' | 'DERIVED' | 'INFERRED' };

export class ImpactQueryError extends Error {
  constructor(public readonly code: 'WORKSPACES_REQUIRED' | 'INVALID_IMPACT_QUERY' | 'WORKSPACE_NOT_FOUND' | 'IMPACT_TARGET_NOT_FOUND' | 'INSUFFICIENT_ACTIVE_ARCHITECTURE_WORKSPACES' | 'IMPACT_QUERY_TOO_LARGE' | 'IMPACT_QUERY_FAILED', message: string, public readonly status: 400 | 404 | 409 | 422 | 500) { super(message); }
}

const dependencyKinds = new Set(['handled_by', 'depends_on', 'calls', 'references', 'accepts', 'returns', 'uses_schema', 'secured_by', 'uses_scheme', 'accesses_model', 'maps_to', 'contains', 'http_request', 'implements_contract', 'provides_contract', 'defines_contract', 'consumes_contract']);

export class ImpactQueryService {
  constructor(private readonly store: GraphStore) {}

  query(query: ImpactQuery) {
    const workspaceIds = [...query.workspaces].sort();
    let snapshot: CrossWorkspaceSnapshot;
    try { snapshot = this.store.crossWorkspaceArchitectureSnapshot(workspaceIds); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/^Workspace not found:/.test(message)) throw new ImpactQueryError('WORKSPACE_NOT_FOUND', message, 404);
      throw new ImpactQueryError('IMPACT_QUERY_FAILED', 'Could not read the cross-workspace architecture snapshot.', 500);
    }
    if (snapshot.generations.length < 2) throw new ImpactQueryError('INSUFFICIENT_ACTIVE_ARCHITECTURE_WORKSPACES', 'At least two selected workspaces need an active architecture generation.', 409);
    let resolution;
    try { resolution = resolveCrossWorkspace(snapshot); }
    catch (error) {
      if (error instanceof CrossWorkspaceResolutionError && error.code === 'CROSS_WORKSPACE_LIMIT_EXCEEDED') throw tooLarge();
      throw new ImpactQueryError('IMPACT_QUERY_FAILED', 'Could not resolve the cross-workspace architecture graph.', 500);
    }
    const graph = buildGraph(snapshot, resolution.nodes, resolution.edges, query.includeEvidence);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const target = byId.get(query.node);
    if (!target) throw new ImpactQueryError('IMPACT_TARGET_NOT_FOUND', `Impact target '${query.node}' was not found in the selected workspaces.`, 404);
    const ownerEndpoint = new Map<string, Set<string>>();
    for (const edge of graph.edges) if (edge.kind === 'exposes') {
      const source = byId.get(edge.sourceId);
      const target = byId.get(edge.targetId);
      if (source?.scope === 'workspace' && target?.kind === 'api_endpoint') addOwnerEndpoint(ownerEndpoint, source.id, target.id);
      else if (target?.scope === 'workspace' && source?.kind === 'api_endpoint') addOwnerEndpoint(ownerEndpoint, target.id, source.id);
    }
    const traversals = graph.edges.flatMap((edge) => normalizeEdge(edge, byId, ownerEndpoint));
    const result = traverse(target.id, graph.nodes, traversals, query);
    const findings = attachedFindings(graph.nodes, graph.edges, new Set(result.nodes.map((node) => node.id)));
    const nodes = [...new Map([...result.nodes, ...findings].map((node) => [node.id, node])).values()].sort((a, b) => cmp([a.id], [b.id]));
    if (nodes.length > query.limit || nodes.length > 2000 || result.edges.length > 4000 || result.paths.length > 2000) throw tooLarge();
    let outputEdges = result.edges;
    let evidence = query.includeEvidence ? [...graph.evidence.filter((item) => item.subjectKind === 'node' && nodes.some((node) => node.id === item.subjectId)), ...result.edges.flatMap((edge) => edge.evidence)] : undefined;
    if (evidence && evidence.reduce((sum, item) => sum + 1 + item.sources.reduce((n, source) => n + source.evidenceIds.length, 0), 0) > 5000) throw tooLarge();
    if (evidence) {
      const edgeEvidenceCount = result.edges.reduce((count, edge) => count + edge.evidence.length, 0);
      const confirmed = confirmSourceReferences(evidence, this.store, 5000);
      evidence = confirmed.slice(0, confirmed.length - edgeEvidenceCount);
      const confirmedEdges = confirmed.slice(confirmed.length - edgeEvidenceCount);
      let offset = 0;
      outputEdges = result.edges.map((edge) => {
        const edgeEvidence = confirmedEdges.slice(offset, offset + edge.evidence.length);
        offset += edge.evidence.length;
        return { ...edge, evidence: edgeEvidence };
      });
    }
    const diagnostics = query.includeDiagnostics ? snapshot.generations.flatMap((workspace) => workspace.diagnostics).sort((a, b) => cmp([a.code ?? '', a.message, a.uri ?? ''], [b.code ?? '', b.message, b.uri ?? ''])) : undefined;
    if (diagnostics && diagnostics.length > 1000) throw tooLarge();
    const impacted = result.nodes.filter((node) => node.id !== target.id);
    const workspaceCount = new Set(impacted.flatMap((node) => node.scope === 'workspace' ? [node.workspaceId] : [])).size;
    const scope = workspaceIds.map((id) => {
      const item = snapshot.generations.find((generation) => generation.workspace.id === id);
      const workspace = item?.workspace ?? this.store.getWorkspace(id);
      if (!workspace) throw new ImpactQueryError('WORKSPACE_NOT_FOUND', `Workspace '${id}' was not found.`, 404);
      return { id: workspace.id, name: workspace.name };
    });
    return {
      scope: { workspaceIds, workspaces: scope, missingArchitectureWorkspaceIds: [...snapshot.missingArchitectureWorkspaceIds] },
      snapshot: { id: snapshot.snapshotId, generations: snapshot.generations.map((item) => item.generation), inputGenerations: snapshot.generations.flatMap((item) => item.inputGenerations.map((input) => ({ workspaceId: item.workspace.id, ...input }))).sort((a, b) => cmp([a.workspaceId, a.analyzerId, a.generationId], [b.workspaceId, b.analyzerId, b.generationId])) },
      query: { node: query.node, direction: query.direction, depth: query.depth, includeInferred: query.includeInferred },
      target,
      summary: { impactedNodeCount: impacted.length, edgeCount: result.edges.length, workspaceCount, maxDistance: Math.max(0, ...result.distances.values()), inferredPathCount: result.paths.filter((path) => path.level === 'INFERRED').length },
      nodes: nodes.map((node) => ({ ...node, distance: result.distances.get(node.id) ?? 0, impactRole: node.id === target.id ? 'target' : result.roles.get(node.id) ?? 'dependency' })),
      edges: outputEdges,
      paths: result.paths,
      findings,
      ...(evidence ? { evidence } : {}),
      ...(diagnostics ? { diagnostics } : {}),
    };
  }
}

export function parseImpactQuery(params: URLSearchParams): { query: ImpactQuery } | { error: string; code: 'WORKSPACES_REQUIRED' | 'INVALID_IMPACT_QUERY' } {
  const fail = (error: string) => ({ error, code: 'INVALID_IMPACT_QUERY' as const });
  const allowed = new Set(['workspaces', 'node', 'direction', 'depth', 'limit', 'includeInferred', 'include']);
  const values = new Map<string, string>();
  for (const [key, value] of params) { if (!allowed.has(key)) return fail(`Unknown query parameter '${key}'.`); if (values.has(key)) return fail(`Query parameter '${key}' must be supplied at most once.`); values.set(key, value); }
  const rawWorkspaces = values.get('workspaces');
  if (!rawWorkspaces) return { error: 'workspaces is required.', code: 'WORKSPACES_REQUIRED' };
  const workspaces = rawWorkspaces.split(',');
  if (workspaces.length < 2 || workspaces.length > 16 || workspaces.some((id) => !id || id.length > 256) || new Set(workspaces).size !== workspaces.length) return fail('workspaces must contain 2–16 unique workspace IDs.');
  const node = values.get('node');
  if (!node || node.includes('\0') || (!isCanonicalContractId(node) && node.length > 512)) return fail('node must be a stable node ID or a canonical api-contract URI within resolver limits.');
  const direction = values.get('direction') ?? 'both';
  if (!['dependents', 'dependencies', 'both'].includes(direction)) return fail("direction must be 'dependents', 'dependencies', or 'both'.");
  const depthText = values.get('depth') ?? '4';
  if (!/^[1-8]$/.test(depthText)) return fail('depth must be an integer between 1 and 8.');
  const limitText = values.get('limit') ?? '500';
  if (!/^[1-9]\d*$/.test(limitText) || Number(limitText) > 2000) return fail('limit must be an integer between 1 and 2000.');
  const inferredText = values.get('includeInferred') ?? 'false';
  if (!['true', 'false'].includes(inferredText)) return fail('includeInferred must be true or false.');
  const includeText = values.get('include');
  const include = includeText === undefined ? [] : includeText.split(',');
  if (includeText === '' || include.some((item) => !['evidence', 'diagnostics'].includes(item)) || new Set(include).size !== include.length) return fail('include accepts a comma-separated list of evidence and diagnostics.');
  return { query: { workspaces, node, direction: direction as ImpactDirection, depth: Number(depthText), limit: Number(limitText), includeInferred: inferredText === 'true', includeEvidence: include.includes('evidence'), includeDiagnostics: include.includes('diagnostics') } };
}

function buildGraph(snapshot: CrossWorkspaceSnapshot, resolvedNodes: readonly SystemNode[], resolvedEdges: readonly SystemEdge[], includeEvidence: boolean) {
  const nodes = new Map<string, SystemNode>();
  const edges = new Map<string, SystemEdge>();
  const evidence: CrossWorkspaceEvidence[] = [];
  for (const workspace of snapshot.generations) {
    const evidenceBySubject = groupEvidence(workspace.evidence);
    for (const node of workspace.nodes) nodes.set(node.id, projectNode(workspace, node, evidenceBySubject.get(`node\0${node.id}`) ?? []));
    for (const edge of workspace.edges) {
      const items = evidenceBySubject.get(`edge\0${edge.id}`) ?? [];
      const projected: SystemEdge = { id: edge.id, scope: 'workspace', sourceId: edge.sourceId, targetId: edge.targetId, sourceWorkspaceId: workspace.workspace.id, targetWorkspaceId: workspace.workspace.id, kind: edge.kind as SystemEdge['kind'], level: edge.level ?? dominant(items), properties: edge.properties, evidence: includeEvidence && items.length ? [toEvidence(workspace, edge.sourceId, edge.id, 'edge', items)] : [] };
      edges.set(edge.id, projected);
      if (includeEvidence && items.length) evidence.push(toEvidence(workspace, edge.sourceId, edge.id, 'edge', items));
    }
    if (includeEvidence) for (const node of workspace.nodes) {
      const items = evidenceBySubject.get(`node\0${node.id}`) ?? [];
      if (items.length) evidence.push(toEvidence(workspace, node.id, node.id, 'node', items));
    }
  }
  const originalId = (workspaceId: string | undefined, id: string) => workspaceId && id.startsWith(`workspace\0${workspaceId}\0`) ? id.slice(`workspace\0${workspaceId}\0`.length) : id;
  for (const node of resolvedNodes) nodes.set(originalId(node.scope === 'workspace' ? node.workspaceId : undefined, node.id), node.scope === 'workspace' ? { ...node, id: originalId(node.workspaceId, node.id) } : node);
  for (const edge of resolvedEdges) {
    // Workspace edges are already projected from the immutable architecture snapshot above.
    // Keep only federation edges here to avoid duplicate relationships under synthetic IDs.
    if (edge.scope !== 'cross-workspace') continue;
    const properties = typeof edge.properties.endpointId === 'string' ? { ...edge.properties, endpointId: originalId(edge.sourceWorkspaceId, edge.properties.endpointId) } : edge.properties;
    const projected = { ...edge, sourceId: originalId(edge.sourceWorkspaceId, edge.sourceId), targetId: originalId(edge.targetWorkspaceId, edge.targetId), properties, evidence: includeEvidence ? edge.evidence.map((item) => ({ ...item, subjectId: originalId(item.sources[0]?.workspaceId, item.subjectId) })) : [] };
    edges.set(projected.id, projected);
    if (includeEvidence) evidence.push(...projected.evidence);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], evidence };
}

function normalizeEdge(edge: SystemEdge, nodes: Map<string, SystemNode>, ownerEndpoint: Map<string, Set<string>>): TraversalEdge[] {
  if (edge.kind === 'architecture_contract_finding') return [];
  let dependent = edge.sourceId;
  let dependency = edge.targetId;
  if (edge.kind === 'exposes') {
    const source = nodes.get(edge.sourceId);
    const target = nodes.get(edge.targetId);
    if (source?.kind === 'api_endpoint') { dependent = source.id; dependency = target?.id ?? edge.targetId; }
    else if (target?.kind === 'api_endpoint') { dependent = target.id; dependency = source?.id ?? edge.sourceId; }
    else return [];
  } else if (edge.kind === 'handled_by') {
    const endpoints = [...(ownerEndpoint.get(edge.sourceId) ?? new Set([edge.sourceId]))].sort();
    return endpoints.map((endpointId) => {
      const id = `impact-edge://${createEdgeIdentity(edge.id, endpointId)}`;
      return { edge: { ...edge, id, sourceId: endpointId, targetId: dependency, evidence: edge.evidence.map((item) => ({ ...item, id: `impact-evidence://${createEdgeIdentity(item.id, endpointId)}`, subjectId: id })) }, dependent: endpointId, dependency };
    });
  } else if (!dependencyKinds.has(edge.kind)) return [];
  const normalized = { ...edge, sourceId: dependent, targetId: dependency };
  if (edge.kind === 'exposes' && edge.sourceWorkspaceId !== edge.targetWorkspaceId) return [];
  return [{ edge: normalized, dependent, dependency }];
}

function traverse(targetId: string, allNodes: SystemNode[], allEdges: TraversalEdge[], query: ImpactQuery) {
  const allowed = allEdges.filter(({ edge }) => query.includeInferred || edge.level !== 'INFERRED');
  const adjacency = new Map<string, Array<{ next: string; traversal: TraversalEdge; role: 'dependent' | 'dependency' }>>();
  const add = (from: string, next: string, traversal: TraversalEdge, role: 'dependent' | 'dependency') => adjacency.set(from, [...(adjacency.get(from) ?? []), { next, traversal, role }]);
  for (const traversal of allowed) {
    if (query.direction === 'dependencies' || query.direction === 'both') add(traversal.dependent, traversal.dependency, traversal, 'dependency');
    if (query.direction === 'dependents' || query.direction === 'both') add(traversal.dependency, traversal.dependent, traversal, 'dependent');
  }
  for (const list of adjacency.values()) list.sort((a, b) => cmp([a.next, a.traversal.edge.id, a.role], [b.next, b.traversal.edge.id, b.role]));
  const distances = new Map([[targetId, 0]]);
  const roles = new Map<string, 'dependent' | 'dependency'>();
  const paths = new Map<string, Path>();
  const includedEdges = new Map<string, SystemEdge>();
  const queue = [targetId];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    const distance = distances.get(current)!;
    if (distance >= query.depth) continue;
    for (const item of adjacency.get(current) ?? []) {
      if (distances.has(item.next)) continue;
      const nextDistance = distance + 1;
      if (nextDistance > query.depth) continue;
      distances.set(item.next, nextDistance);
      roles.set(item.next, current === targetId ? item.role : roles.get(current)!);
      queue.push(item.next);
      includedEdges.set(item.traversal.edge.id, item.traversal.edge);
      const parent = paths.get(current);
      const nodeIds = [...(parent?.nodeIds ?? [targetId]), item.next];
      const edgeIds = [...(parent?.edgeIds ?? []), item.traversal.edge.id];
      const levels = edgeIds.map((id) => includedEdges.get(id)?.level ?? item.traversal.edge.level);
      paths.set(item.next, { nodeId: item.next, nodeIds, edgeIds, workspaceIds: [...new Set(nodeIds.map((id) => allNodes.find((node) => node.id === id)?.scope === 'workspace' ? (allNodes.find((node) => node.id === id) as Extract<SystemNode, { scope: 'workspace' }>).workspaceId : '').filter(Boolean))].sort(), level: levels.includes('INFERRED') ? 'INFERRED' : levels.includes('DERIVED') ? 'DERIVED' : 'DIRECT' });
      if (queue.length > 2000) throw tooLarge();
    }
  }
  for (const traversal of allowed) {
    if (distances.has(traversal.dependent) && distances.has(traversal.dependency)) includedEdges.set(traversal.edge.id, traversal.edge);
  }
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  const nodes = [...distances.keys()].map((id) => byId.get(id)!).sort((a, b) => cmp([distances.get(a.id)!, a.id], [distances.get(b.id)!, b.id]));
  const edges = [...includedEdges.values()].sort((a, b) => cmp([a.id], [b.id]));
  return { nodes, edges, paths: [...paths.values()].sort((a, b) => cmp([a.nodeId], [b.nodeId])), distances, roles };
}

function attachedFindings(nodes: SystemNode[], edges: SystemEdge[], reached: Set<string>) {
  const findingIds = new Set(nodes.filter((node) => node.kind.startsWith('architecture_contract_') && reached.has(node.id)).map((node) => node.id));
  for (const edge of edges) if (edge.kind === 'architecture_contract_finding') {
    if ((reached.has(edge.sourceId) || findingIds.has(edge.sourceId)) && nodes.some((node) => node.id === edge.targetId && node.kind.startsWith('architecture_contract_'))) findingIds.add(edge.targetId);
    if ((reached.has(edge.targetId) || findingIds.has(edge.targetId)) && nodes.some((node) => node.id === edge.sourceId && node.kind.startsWith('architecture_contract_'))) findingIds.add(edge.sourceId);
  }
  return nodes.filter((node) => node.kind.startsWith('architecture_contract_') && findingIds.has(node.id)).sort((a, b) => cmp([a.id], [b.id]));
}

function projectNode(workspace: WorkspaceArchitectureSnapshot, node: GraphNode, evidence: readonly AnalysisEvidence[]): SystemNode { return { scope: 'workspace', workspaceId: workspace.workspace.id, id: node.id, kind: node.kind, label: node.label, properties: node.properties, level: node.level ?? dominant(evidence) }; }
function groupEvidence(items: readonly AnalysisEvidence[]) { const result = new Map<string, AnalysisEvidence[]>(); for (const item of items) { const key = `${item.subjectKind}\0${item.subjectId}`; result.set(key, [...(result.get(key) ?? []), item]); } return result; }
function addOwnerEndpoint(owners: Map<string, Set<string>>, ownerId: string, endpointId: string) { owners.set(ownerId, new Set([...(owners.get(ownerId) ?? []), endpointId])); }
function isCanonicalContractId(value: string) {
  const prefix = 'api-contract://';
  const maxLength = prefix.length + 9 * MAX_CONTRACT_NAMESPACE_LENGTH + 1 + 7 + 1 + 9 * MAX_CONTRACT_PATH_LENGTH;
  if (!value.startsWith(prefix) || value.length > maxLength) return false;
  const parts = value.slice(prefix.length).split('/');
  if (parts.length !== 3) return false;
  try {
    const namespace = decodeURIComponent(parts[0]!);
    const path = decodeURIComponent(parts[2]!);
    if (!namespace || namespace === 'default' || namespace.length > MAX_CONTRACT_NAMESPACE_LENGTH || namespace.includes('\0') || !['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'].includes(parts[1]!) || !path.startsWith('/') || path.length > MAX_CONTRACT_PATH_LENGTH || /[\u0000-\u001f\u007f?#]/.test(path)) return false;
    return `${prefix}${encodeURIComponent(namespace)}/${parts[1]}/${encodeURIComponent(path)}` === value;
  } catch { return false; }
}
function createEdgeIdentity(edgeId: string, endpointId: string) { return createHash('sha256').update(`${edgeId}\0${endpointId}`).digest('hex'); }
function toEvidence(workspace: WorkspaceArchitectureSnapshot, nodeId: string, subjectId: string, subjectKind: 'node' | 'edge', items: readonly AnalysisEvidence[]): CrossWorkspaceEvidence {
  const sourceEvidence = new Map<string, { workspaceId: string; analyzerId: string; generationId: number; evidenceIds: Set<string> }>();
  let sourceLocationsUnavailable = false;
  const addSource = (analyzerId: unknown, generationId: unknown, evidenceId: unknown, hasUri: boolean) => {
    if (!hasUri || typeof analyzerId !== 'string' || typeof generationId !== 'number' || !Number.isSafeInteger(generationId) || typeof evidenceId !== 'string' || !evidenceId) return false;
    const recorded = workspace.inputGenerations.find((input) => input.analyzerId === analyzerId && input.generationId === generationId);
    if (!recorded) return false;
    const key = `${workspace.workspace.id}\0${analyzerId}\0${generationId}`;
    const source = sourceEvidence.get(key) ?? { workspaceId: workspace.workspace.id, analyzerId, generationId, evidenceIds: new Set<string>() };
    source.evidenceIds.add(evidenceId); sourceEvidence.set(key, source); return true;
  };
  for (const item of items) {
    const provenance = item.provenance;
    if (!provenance) { sourceLocationsUnavailable = true; continue; }
    if (typeof provenance.analyzerId === 'string' && typeof provenance.generationId === 'number' && typeof provenance.sourceEvidenceId === 'string') {
      if (!addSource(provenance.analyzerId, provenance.generationId, provenance.sourceEvidenceId, typeof item.uri === 'string')) sourceLocationsUnavailable = true;
    } else if (Array.isArray(provenance.sources)) {
      if (!provenance.sources.length) sourceLocationsUnavailable = true;
      for (const source of provenance.sources) {
        if (!source || typeof source !== 'object' || Array.isArray(source)) { sourceLocationsUnavailable = true; continue; }
        const value = source as Record<string, unknown>;
        const input = workspace.inputGenerations.find((candidate) => candidate.analyzerId === value.analyzerId);
        if (!addSource(value.analyzerId, input?.generationId, value.evidenceId, typeof value.uri === 'string')) sourceLocationsUnavailable = true;
      }
    } else sourceLocationsUnavailable = true;
  }
  return {
    id: `impact-evidence://${workspace.workspace.id}/${subjectKind}/${encodeURIComponent(subjectId)}`, subjectKind, subjectId, level: 'DERIVED', type: 'architecture.source_evidence',
    sources: [{ workspaceId: workspace.workspace.id, analyzerId: workspace.generation.analyzerId, generationId: workspace.generation.generationId, nodeId, evidenceIds: items.map((item) => item.id).sort() }],
    sourceReferences: [...sourceEvidence.values()].map((source) => ({ workspaceId: source.workspaceId, analyzerId: source.analyzerId, generationId: source.generationId, evidenceIds: [...source.evidenceIds].sort() })).sort((a, b) => cmp([a.workspaceId, a.analyzerId, a.generationId], [b.workspaceId, b.analyzerId, b.generationId))),
    sourceLocationsUnavailable,
  };
}
function confirmSourceReferences(items: readonly CrossWorkspaceEvidence[], store: GraphStore, maxReferenceChecks: number): CrossWorkspaceEvidence[] {
  const availability = new Map<string, boolean>();
  let referenceChecks = 0;
  const confirm = (item: CrossWorkspaceEvidence): CrossWorkspaceEvidence => {
    const requestedCount = item.sourceReferences?.reduce((count, source) => count + source.evidenceIds.length, 0) ?? 0;
    let confirmedCount = 0;
    const sourceReferences = item.sourceReferences?.flatMap((source) => {
      const evidenceIds = source.evidenceIds.filter((evidenceId) => {
        const key = `${source.workspaceId}\0${source.analyzerId}\0${source.generationId}\0${evidenceId}`;
        const cached = availability.get(key);
        if (cached !== undefined) return cached;
        if (++referenceChecks > maxReferenceChecks) throw tooLarge();
        const row = store.activeSourceEvidence(source.workspaceId, source.analyzerId, source.generationId, evidenceId);
        let available = false;
        if (row && !row.payloadTooLarge) {
          try { available = typeof (JSON.parse(row.payload_json) as { uri?: unknown }).uri === 'string'; } catch { available = false; }
        }
        availability.set(key, available);
        return available;
      });
      confirmedCount += evidenceIds.length;
      return evidenceIds.length ? [{ ...source, evidenceIds }] : [];
    });
    const hasProvenanceEvidence = item.sources.some((source) => source.evidenceIds.length > 0);
    const unavailable = item.sourceLocationsUnavailable === true || (hasProvenanceEvidence && (confirmedCount < requestedCount || !sourceReferences?.length));
    return { ...item, sourceReferences, sourceLocationsUnavailable: unavailable };
  };
  return items.map(confirm);
}
function dominant(items: readonly AnalysisEvidence[]): SystemNode['level'] { return items.some((item) => item.level === 'INFERRED') ? 'INFERRED' : items.some((item) => item.level === 'DERIVED') ? 'DERIVED' : 'DIRECT'; }
function cmp(a: Array<string | number>, b: Array<string | number>) { for (let i = 0; i < Math.min(a.length, b.length); i++) { const value = String(a[i]).localeCompare(String(b[i])); if (value) return value; } return a.length - b.length; }
function tooLarge() { return new ImpactQueryError('IMPACT_QUERY_TOO_LARGE', 'Impact query exceeds a hard response limit; no partial result was returned.', 422); }
