import { createHash } from 'node:crypto';
import type { AnalysisDiagnostic, AnalysisEvidence } from '../domain/analyzer.js';
import type { ApiContractKey, ArchitectureEdgeKind, CrossWorkspaceEvidence, CrossWorkspaceResolution, CrossWorkspaceSnapshot, SystemEdge, SystemNode, WorkspaceArchitectureSnapshot } from '../domain/federation.js';
import type { GraphEdge, GraphNode } from '../domain/graph.js';

export type CrossWorkspaceResolverOptions = {
  maxInputEndpoints: number;
  maxContracts: number;
  maxSyntheticEdges: number;
};

const defaults: CrossWorkspaceResolverOptions = { maxInputEndpoints: 5000, maxContracts: 2500, maxSyntheticEdges: 10000 };
const hardLimits: CrossWorkspaceResolverOptions = { maxInputEndpoints: 20000, maxContracts: 10000, maxSyntheticEdges: 40000 };
const allowedMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH']);
export const MAX_CONTRACT_NAMESPACE_LENGTH = 256;
export const MAX_CONTRACT_PATH_LENGTH = 2048;

export class CrossWorkspaceResolutionError extends Error {
  constructor(public readonly code: 'INVALID_SNAPSHOT' | 'INVALID_OPTIONS' | 'CROSS_WORKSPACE_LIMIT_EXCEEDED', message: string) { super(message); }
}

type Participant = {
  workspace: WorkspaceArchitectureSnapshot;
  owner: GraphNode;
  endpoint: GraphNode;
  exposure: GraphEdge;
  role: 'provider' | 'specification' | 'consumer';
  key: ApiContractKey;
};

/** Pure, deterministic API-contract federation over an immutable architecture snapshot. */
export function resolveCrossWorkspace(snapshot: CrossWorkspaceSnapshot, rawOptions: Partial<CrossWorkspaceResolverOptions> = {}): CrossWorkspaceResolution {
  const options = resolverOptions(rawOptions);
  validateSnapshot(snapshot);
  const participants: Participant[] = [];
  let inputEndpoints = 0;
  const workspaceIds = new Set(snapshot.requestedWorkspaceIds);

  for (const workspace of [...snapshot.generations].sort((a, b) => cmp([a.workspace.id], [b.workspace.id]))) {
    if (!workspaceIds.has(workspace.workspace.id) || workspace.generation.workspaceId !== workspace.workspace.id || workspace.generation.analyzerId !== 'builtin.architecture') {
      throw invalid('Generation does not belong to the requested architecture snapshot.');
    }
    const nodesById = new Map(workspace.nodes.map((node) => [node.id, node]));
    const endpoints = workspace.nodes.filter((node) => node.kind === 'api_endpoint');
    inputEndpoints += endpoints.length;
    if (inputEndpoints > options.maxInputEndpoints) throw exceeded('input endpoint', options.maxInputEndpoints);

    for (const edge of workspace.edges) {
      if (edge.kind !== 'exposes' || !nodesById.has(edge.sourceId)) continue;
      const owner = nodesById.get(edge.sourceId)!;
      const endpoint = nodesById.get(edge.targetId);
      if (!endpoint || endpoint.kind !== 'api_endpoint') continue;
      const role = owner.kind === 'fastapi_route' ? 'provider' : owner.kind === 'openapi_operation' ? 'specification' : undefined;
      if (role) {
        const key = contractKey(endpoint);
        if (key) participants.push({ workspace, owner, endpoint, exposure: edge, role, key });
      }
    }
    // Frontend HTTP requests are consumers. OpenAPI operations remain specifications.
    for (const edge of workspace.edges) {
      if (edge.kind !== 'http_request') continue;
      const owner = nodesById.get(edge.sourceId);
      const endpoint = nodesById.get(edge.targetId);
      if (owner?.kind !== 'frontend.http_request' || endpoint?.kind !== 'api_endpoint') continue;
      const key = contractKey(endpoint);
      if (key) participants.push({ workspace, owner, endpoint, exposure: edge, role: 'consumer', key });
    }
  }

  participants.sort((a, b) => cmp([a.key.namespace, a.key.method, a.key.path, a.workspace.workspace.id, a.role, a.owner.id, a.endpoint.id, a.exposure.id], [b.key.namespace, b.key.method, b.key.path, b.workspace.workspace.id, b.role, b.owner.id, b.endpoint.id, b.exposure.id]));
  const byKey = group(participants, (item) => contractKeyString(item.key));
  const shared = [...byKey.entries()].filter(([, items]) => new Set(items.map((item) => item.workspace.workspace.id)).size >= 2);
  if (shared.length > options.maxContracts) throw exceeded('shared contract', options.maxContracts);

  const nodes = new Map<string, SystemNode>();
  const edges: SystemEdge[] = [];
  const diagnostics: AnalysisDiagnostic[] = [];
  let syntheticEvidenceCost = 0;
  const addSystemEdge = (edge: SystemEdge) => {
    if (edges.length >= options.maxSyntheticEdges) throw exceeded('synthetic edge', options.maxSyntheticEdges);
    const evidenceCost = edge.evidence.reduce((total, item) => total + 1 + item.sources.reduce((sum, source) => sum + source.evidenceIds.length, 0), 0);
    if (syntheticEvidenceCost + evidenceCost > options.maxSyntheticEdges) throw exceeded('synthetic evidence source', options.maxSyntheticEdges);
    syntheticEvidenceCost += evidenceCost;
    edges.push(edge);
  };
  const evidenceBySubject = new Map<string, AnalysisEvidence[]>();
  for (const workspace of snapshot.generations) for (const evidence of workspace.evidence) {
    const key = `${workspace.workspace.id}\0${evidence.subjectKind}\0${evidence.subjectId}`;
    evidenceBySubject.set(key, [...(evidenceBySubject.get(key) ?? []), evidence]);
  }

  const workspaceNode = (workspace: WorkspaceArchitectureSnapshot, node: GraphNode): SystemNode => {
    const id = workspaceNodeKey(workspace.workspace.id, node.id);
    const existing = nodes.get(id);
    if (existing) return existing;
    const item: SystemNode = { scope: 'workspace', workspaceId: workspace.workspace.id, id: node.id, kind: node.kind, label: node.label, properties: node.properties, level: graphLevel(node, evidenceBySubject.get(`${workspace.workspace.id}\0node\0${node.id}`) ?? []), contributors: node.contributors, propertySources: node.propertySources, propertyConflicts: node.propertyConflicts };
    nodes.set(id, item);
    return item;
  };
  const workspaceEvidence = (workspace: WorkspaceArchitectureSnapshot, subjectKind: 'node' | 'edge', subjectId: string) => evidenceBySubject.get(`${workspace.workspace.id}\0${subjectKind}\0${subjectId}`) ?? [];
  const evidenceSource = (workspace: WorkspaceArchitectureSnapshot, nodeId: string, evidence: AnalysisEvidence[]) => {
    const grouped = new Map<string, { workspaceId: string; analyzerId: string; generationId: number; nodeId: string; evidenceIds: Set<string> }>();
    for (const item of evidence) {
      const analyzerId = item.analyzerId ?? workspace.generation.analyzerId;
      const generationId = item.generationId ?? workspace.generation.generationId;
      const key = `${analyzerId}\0${generationId}`;
      const source = grouped.get(key) ?? { workspaceId: workspace.workspace.id, analyzerId, generationId, nodeId, evidenceIds: new Set<string>() };
      if (item.id) source.evidenceIds.add(item.id);
      grouped.set(key, source);
    }
    if (!grouped.size) grouped.set(`${workspace.generation.analyzerId}\0${workspace.generation.generationId}`, { workspaceId: workspace.workspace.id, analyzerId: workspace.generation.analyzerId, generationId: workspace.generation.generationId, nodeId, evidenceIds: new Set() });
    return [...grouped.values()].map((source) => ({ ...source, evidenceIds: [...source.evidenceIds].sort() }));
  };
  const makeEvidence = (workspace: WorkspaceArchitectureSnapshot, subjectKind: 'node' | 'edge', subjectId: string, type: string, sources: CrossWorkspaceEvidence['sources'], detail?: string): CrossWorkspaceEvidence => ({
    id: `cross-workspace-evidence://${hash(`${workspace.workspace.id}\0${subjectKind}\0${subjectId}\0${type}`)}`,
    subjectKind,
    subjectId,
    level: 'DERIVED',
    type,
    sources,
    ...sourceReferences(snapshot, sources),
    ...(detail ? { detail } : {}),
  });

  // Keep the original route/operation context while projecting no unrelated graph facts.
  for (const item of participants) {
    workspaceNode(item.workspace, item.owner);
    workspaceNode(item.workspace, item.endpoint);
    const id = workspaceEdgeId(item.workspace.workspace.id, item.exposure.id);
    const evidenceSources = [
      ...evidenceSource(item.workspace, item.owner.id, workspaceEvidence(item.workspace, 'node', item.owner.id)),
      ...evidenceSource(item.workspace, item.endpoint.id, workspaceEvidence(item.workspace, 'node', item.endpoint.id)),
      ...evidenceSource(item.workspace, item.owner.id, workspaceEvidence(item.workspace, 'edge', item.exposure.id)),
    ];
    addSystemEdge({
      id,
      scope: 'workspace',
      sourceId: item.owner.id,
      targetId: item.endpoint.id,
      sourceWorkspaceId: item.workspace.workspace.id,
      targetWorkspaceId: item.workspace.workspace.id,
      kind: item.exposure.kind as ArchitectureEdgeKind,
      level: graphLevel(undefined, workspaceEvidence(item.workspace, 'edge', item.exposure.id)),
      properties: item.exposure.properties,
      evidence: [makeEvidence(item.workspace, 'edge', id, `cross_workspace.${item.exposure.kind}`, evidenceSources)],
    });
  }

  for (const [keyText, items] of shared) {
    const first = items[0]!;
    const key = first.key;
    const globalId = contractId(key);
    const globalNode: SystemNode = { scope: 'global', id: globalId, kind: 'api_contract', label: `${key.namespace} ${key.method} ${key.path}`, properties: key, level: 'DERIVED' };
    nodes.set(`global\0${globalId}`, globalNode);
    const providerItems = items.filter((item) => item.role === 'provider');
    const providerIdentities = new Set(providerItems.map((item) => `${item.workspace.workspace.id}\0${item.owner.id}\0${item.endpoint.id}`));
    if (providerIdentities.size > 1) diagnostics.push({ code: 'CROSS_WORKSPACE_MULTIPLE_PROVIDERS', severity: 'warning', message: `The shared API contract ${key.method} ${key.path} has multiple FastAPI providers; all providers are retained without selecting one.`, detail: { namespace: key.namespace, method: key.method, path: key.path, providerCount: providerIdentities.size } });

    const byRoleEndpoint = new Map<string, Participant[]>();
    for (const item of items) {
      const groupKey = item.role === 'specification'
        ? `${item.role}\0${item.workspace.workspace.id}\0${item.owner.id}`
        : `${item.role}\0${item.workspace.workspace.id}\0${item.endpoint.id}`;
      byRoleEndpoint.set(groupKey, [...(byRoleEndpoint.get(groupKey) ?? []), item]);
    }
    const contractSources = participantSources(items, options.maxSyntheticEdges);
    for (const groupedItems of [...byRoleEndpoint.values()].sort((a, b) => cmp([a[0]!.role, a[0]!.workspace.workspace.id, a[0]!.endpoint.id, a[0]!.owner.id], [b[0]!.role, b[0]!.workspace.workspace.id, b[0]!.endpoint.id, b[0]!.owner.id]))) {
      const item = groupedItems[0]!;
      const workspaceId = item.workspace.workspace.id;
      const endpointNode = workspaceNode(item.workspace, item.endpoint);
      const ownerNodes = groupedItems.map(({ workspace, owner }) => workspaceNode(workspace, owner));
      const kind = item.role === 'provider' ? 'provides_contract' : item.role === 'consumer' ? 'consumes_contract' : 'defines_contract';
      // Consumers attach at endpoint identity once per workspace; providers point from hub to implementation.
      const sourceId = item.role === 'provider' ? globalId : item.role === 'consumer' ? endpointNode.id : ownerNodes[0]!.id;
      const targetId = item.role === 'provider' ? endpointNode.id : globalId;
      const id = contractEdgeId(workspaceId, sourceId, targetId, kind);
      const sourceEvidence = contractSources;
      addSystemEdge({
        id,
        scope: 'cross-workspace',
        sourceId,
        targetId,
        ...(item.role === 'provider' ? { targetWorkspaceId: workspaceId } : { sourceWorkspaceId: workspaceId }),
        kind,
        level: 'DERIVED',
        properties: { contract: key, endpointId: endpointNode.id, ownerIds: ownerNodes.map(({ id: ownerId }) => ownerId).sort(), ...(item.role === 'consumer' ? { requestCount: ownerNodes.length } : {}) },
        evidence: [makeEvidence(item.workspace, 'edge', id, `cross_workspace.${kind}`, sourceEvidence)],
      });
    }
    // Protect against accidental key collisions in canonical URI encoding.
    if (globalId !== keyText) throw invalid('Contract identity is not canonical.');
  }

  return {
    snapshotId: snapshot.snapshotId,
    requestedWorkspaceIds: [...snapshot.requestedWorkspaceIds].sort(),
    missingArchitectureWorkspaceIds: [...snapshot.missingArchitectureWorkspaceIds].sort(),
    nodes: [...nodes.values()].sort((a, b) => cmp([a.scope, a.scope === 'workspace' ? a.workspaceId : '', a.id], [b.scope, b.scope === 'workspace' ? b.workspaceId : '', b.id])),
    edges: edges.sort((a, b) => cmp([a.scope, a.sourceWorkspaceId ?? '', a.sourceId, a.targetWorkspaceId ?? '', a.targetId, a.kind, a.id], [b.scope, b.sourceWorkspaceId ?? '', b.sourceId, b.targetWorkspaceId ?? '', b.targetId, b.kind, b.id])),
    diagnostics: diagnostics.sort((a, b) => cmp([a.code ?? '', JSON.stringify(a.detail ?? {})], [b.code ?? '', JSON.stringify(b.detail ?? {})])),
  };
}

function sourceReferences(snapshot: CrossWorkspaceSnapshot, sources: CrossWorkspaceEvidence['sources']) {
  const refs = new Map<string, { workspaceId: string; analyzerId: string; generationId: number; evidenceIds: Set<string> }>();
  let sourceLocationsUnavailable = false;
  const add = (workspace: WorkspaceArchitectureSnapshot, analyzerId: unknown, generationId: unknown, evidenceId: unknown, hasUri: boolean, mustBeArchitectureInput: boolean) => {
    if (!hasUri || typeof analyzerId !== 'string' || typeof generationId !== 'number' || !Number.isSafeInteger(generationId) || typeof evidenceId !== 'string' || !evidenceId) { sourceLocationsUnavailable = true; return; }
    if (!workspace.activeGenerations.some((active) => active.analyzerId === analyzerId && active.generationId === generationId)) { sourceLocationsUnavailable = true; return; }
    if (mustBeArchitectureInput && !workspace.inputGenerations.some((input) => input.analyzerId === analyzerId && input.generationId === generationId)) { sourceLocationsUnavailable = true; return; }
    const key = `${workspace.workspace.id}\0${analyzerId}\0${generationId}`;
    const ref = refs.get(key) ?? { workspaceId: workspace.workspace.id, analyzerId, generationId, evidenceIds: new Set<string>() };
    ref.evidenceIds.add(evidenceId); refs.set(key, ref);
  };
  for (const tuple of sources) {
    const workspace = snapshot.generations.find((candidate) => candidate.workspace.id === tuple.workspaceId);
    if (!workspace) { sourceLocationsUnavailable = true; continue; }
    for (const evidenceId of tuple.evidenceIds) {
      const evidence = workspace.evidence.find((item) => item.id === evidenceId && (item.analyzerId ?? workspace.generation.analyzerId) === tuple.analyzerId && (item.generationId ?? workspace.generation.generationId) === tuple.generationId);
      if (!evidence) { sourceLocationsUnavailable = true; continue; }
      const provenance = evidence.provenance;
      if (typeof evidence.uri === 'string' && tuple.analyzerId !== 'builtin.architecture') {
        add(workspace, tuple.analyzerId, tuple.generationId, evidence.id, true, false);
      } else if (provenance && typeof provenance === 'object' && !Array.isArray(provenance)) {
        const data = provenance as Record<string, unknown>;
        if (typeof data.analyzerId === 'string' && typeof data.generationId === 'number' && typeof data.sourceEvidenceId === 'string') {
          add(workspace, data.analyzerId, data.generationId, data.sourceEvidenceId, typeof evidence.uri === 'string', true);
        } else if (Array.isArray(data.sources)) {
          if (!data.sources.length) sourceLocationsUnavailable = true;
          for (const value of data.sources) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) { sourceLocationsUnavailable = true; continue; }
            const item = value as Record<string, unknown>;
            const input = workspace.inputGenerations.find((candidate) => candidate.analyzerId === item.analyzerId);
            add(workspace, item.analyzerId, input?.generationId, item.evidenceId, typeof item.uri === 'string', true);
          }
        } else sourceLocationsUnavailable = true;
      } else if (typeof evidence.uri === 'string') {
        add(workspace, tuple.analyzerId, tuple.generationId, evidence.id, true, false);
      } else sourceLocationsUnavailable = true;
    }
  }
  return { sourceReferences: [...refs.values()].map((ref) => ({ workspaceId: ref.workspaceId, analyzerId: ref.analyzerId, generationId: ref.generationId, evidenceIds: [...ref.evidenceIds].sort() })), sourceLocationsUnavailable };
}

function resolverOptions(input: Partial<CrossWorkspaceResolverOptions>): CrossWorkspaceResolverOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !Object.hasOwn(defaults, key))) throw new CrossWorkspaceResolutionError('INVALID_OPTIONS', 'Cross-workspace resolver options contain unsupported fields.');
  const output = { ...defaults };
  for (const key of Object.keys(input) as Array<keyof CrossWorkspaceResolverOptions>) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > hardLimits[key]) throw new CrossWorkspaceResolutionError('INVALID_OPTIONS', `${key} must be an integer between 1 and ${hardLimits[key]}.`);
    output[key] = value;
  }
  return output;
}

function participantSources(items: readonly Participant[], maxEvidenceSourceCost: number): CrossWorkspaceEvidence['sources'] {
  const grouped = new Map<string, { workspaceId: string; analyzerId: string; generationId: number; nodeId: string; evidenceIds: Set<string> }>();
  let sourceCost = 0;
  for (const item of items) {
    const subjects = [
      [item.owner.id, 'node', item.owner.id],
      [item.endpoint.id, 'node', item.endpoint.id],
      [item.exposure.sourceId, 'edge', item.exposure.id],
    ] as const;
    for (const [nodeId, subjectKind, subjectId] of subjects) {
      const evidence = item.workspace.evidence.filter((entry) => entry.subjectKind === subjectKind && entry.subjectId === subjectId);
      const owners = evidence.length ? evidence : [{ analyzerId: item.workspace.generation.analyzerId, generationId: item.workspace.generation.generationId, id: undefined } as AnalysisEvidence];
      for (const entry of owners) {
        const analyzerId = entry.analyzerId ?? item.workspace.generation.analyzerId;
        const generationId = entry.generationId ?? item.workspace.generation.generationId;
        const key = `${item.workspace.workspace.id}\0${analyzerId}\0${generationId}\0${nodeId}`;
        const current = grouped.get(key) ?? { workspaceId: item.workspace.workspace.id, analyzerId, generationId, nodeId, evidenceIds: new Set<string>() };
        if (!grouped.has(key)) sourceCost++;
        if (entry.id && !current.evidenceIds.has(entry.id)) { current.evidenceIds.add(entry.id); sourceCost++; }
        if (sourceCost > maxEvidenceSourceCost) throw exceeded('synthetic evidence source', maxEvidenceSourceCost);
        grouped.set(key, current);
      }
    }
  }
  return [...grouped.values()].map((source) => ({ ...source, evidenceIds: [...source.evidenceIds].sort() })).sort((a, b) => cmp([a.workspaceId, a.analyzerId, a.generationId, a.nodeId], [b.workspaceId, b.analyzerId, b.generationId, b.nodeId]));
}

function validateSnapshot(snapshot: CrossWorkspaceSnapshot): void {
  if (!snapshot || !Array.isArray(snapshot.requestedWorkspaceIds) || snapshot.requestedWorkspaceIds.length < 2 || snapshot.requestedWorkspaceIds.length > 16 || new Set(snapshot.requestedWorkspaceIds).size !== snapshot.requestedWorkspaceIds.length || !Array.isArray(snapshot.generations) || !Array.isArray(snapshot.missingArchitectureWorkspaceIds)) throw invalid('Snapshot must contain 2–16 unique requested workspaces and generation lists.');
}
function contractKey(node: GraphNode): ApiContractKey | undefined {
  const { namespace, method, path } = node.properties;
  if (typeof namespace !== 'string' || !namespace || namespace.length > MAX_CONTRACT_NAMESPACE_LENGTH || namespace === 'default' || namespace.includes('\0') || typeof method !== 'string' || !allowedMethods.has(method) || typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_CONTRACT_PATH_LENGTH || /[\u0000-\u001f\u007f?#]/.test(path)) return undefined;
  return { namespace, method, path };
}
function contractKeyString(key: ApiContractKey) { return contractId(key); }
function contractId(key: ApiContractKey) { return `api-contract://${encodeURIComponent(key.namespace)}/${key.method}/${encodeURIComponent(key.path)}`; }
function workspaceNodeKey(workspaceId: string, nodeId: string) { return `workspace\0${workspaceId}\0${nodeId}`; }
function workspaceEdgeId(workspaceId: string, edgeId: string) { return `system-edge://${hash(`${workspaceId}\0${edgeId}`)}`; }
function contractEdgeId(workspaceId: string, sourceId: string, targetId: string, kind: string) { return `system-edge://${hash(`${workspaceId}\0${sourceId}\0${targetId}\0${kind}`)}`; }
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function graphLevel(node: GraphNode | undefined, evidence: readonly AnalysisEvidence[]): 'DIRECT' | 'DERIVED' | 'INFERRED' {
  if (node?.level) return node.level;
  return evidence.some((item) => item.level === 'DIRECT') ? 'DIRECT' : evidence.some((item) => item.level === 'DERIVED') ? 'DERIVED' : 'INFERRED';
}
function group<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> { const result = new Map<string, T[]>(); for (const item of items) { const key = keyOf(item); result.set(key, [...(result.get(key) ?? []), item]); } return result; }
function cmp(a: readonly (string | number)[], b: readonly (string | number)[]) { for (let i = 0; i < Math.min(a.length, b.length); i++) { if (a[i]! < b[i]!) return -1; if (a[i]! > b[i]!) return 1; } return a.length - b.length; }
function invalid(message: string) { return new CrossWorkspaceResolutionError('INVALID_SNAPSHOT', message); }
function exceeded(kind: string, limit: number) { return new CrossWorkspaceResolutionError('CROSS_WORKSPACE_LIMIT_EXCEEDED', `Cross-workspace ${kind} count exceeds configured limit (${limit}); no partial result was returned.`); }
