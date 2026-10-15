import type { AnalysisDiagnostic, AnalysisEvidence, ArchitectureInputGeneration, AnalysisInputGeneration } from '../../domain/analyzer.js';
import type { GraphEdge, GraphNode } from '../../domain/graph.js';
import { GraphIdentityFactory } from '../../core/graph-identity.js';

const ids = new GraphIdentityFactory();

export type ArchitectureConfig = {
  allowPathShapeInference: boolean;
  maxEndpoints: number;
  maxTraversalDepth: number;
  maxVisitedSymbolsPerEndpoint: number;
  maxTotalTraversalVisits: number;
};

const defaults: ArchitectureConfig = {
  allowPathShapeInference: false,
  maxEndpoints: 1000,
  maxTraversalDepth: 4,
  maxVisitedSymbolsPerEndpoint: 250,
  maxTotalTraversalVisits: 50000,
};
const limits: Record<Exclude<keyof ArchitectureConfig, 'allowPathShapeInference'>, number> = {
  maxEndpoints: 5000,
  maxTraversalDepth: 8,
  maxVisitedSymbolsPerEndpoint: 1000,
  maxTotalTraversalVisits: 250000,
};

export function architectureConfig(input: Record<string, unknown>): ArchitectureConfig {
  const unknown = Object.keys(input).filter((key) => !Object.hasOwn(defaults, key));
  if (unknown.length) throw new Error(`Unsupported architecture option '${unknown.sort()[0]}'.`);
  const output = { ...defaults };
  for (const key of Object.keys(input) as Array<keyof ArchitectureConfig>) {
    const value = input[key];
    if (key === 'allowPathShapeInference') {
      if (typeof value !== 'boolean') throw new Error('allowPathShapeInference must be a boolean.');
      output[key] = value;
    } else {
      const max = limits[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${key} must be an integer from 1 to ${max}.`);
      output[key] = value;
    }
  }
  return output;
}

export type ArchitectureSources = { workspaceId: string; fastApi?: ArchitectureInputGeneration; openApi?: ArchitectureInputGeneration; sqlAlchemy?: ArchitectureInputGeneration };
export type ArchitectureResolution = { nodes: GraphNode[]; edges: GraphEdge[]; evidence: AnalysisEvidence[]; diagnostics: AnalysisDiagnostic[]; inputGenerations: AnalysisInputGeneration[] };

export function resolveArchitecture(sources: ArchitectureSources, rawConfig: Record<string, unknown>): ArchitectureResolution {
  const config = architectureConfig(rawConfig);
  const inputs = [sources.fastApi, sources.openApi, sources.sqlAlchemy].filter((x): x is ArchitectureInputGeneration => !!x);
  const inputGenerations = inputs.map(({ analyzerId, generationId }) => ({ analyzerId, generationId })).sort((a, b) => a.analyzerId.localeCompare(b.analyzerId));
  const diagnostics: AnalysisDiagnostic[] = [];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const evidence: AnalysisEvidence[] = [];
  const evidenceIds = new Set<string>();
  const issueIds = new Set<string>();
  const matchedPairs: Array<{ fast: GraphNode; spec: GraphNode; match: string }> = [];
  // The resolver works only from bounded projections of the supplied generations.
  const endpointNodes = (generation: ArchitectureInputGeneration | undefined) => (generation?.nodes ?? []).filter((node) => node.kind === 'api_endpoint');
  const allFastEndpoints = endpointNodes(sources.fastApi);
  const allSpecEndpoints = endpointNodes(sources.openApi);
  const fastEndpoints = allFastEndpoints.slice(0, config.maxEndpoints);
  const specEndpoints = allSpecEndpoints.slice(0, Math.max(0, config.maxEndpoints - fastEndpoints.length));
  if (allFastEndpoints.length + allSpecEndpoints.length > fastEndpoints.length + specEndpoints.length) diagnostics.push({ code: 'ARCHITECTURE_ENDPOINT_LIMIT', severity: 'warning', message: `Architecture endpoint input exceeded maxEndpoints (${config.maxEndpoints}); remaining endpoints were skipped.` });
  const openApiEndpointIds = new Set(specEndpoints.map(({ id }) => id));
  const pushMatch = (fast: GraphNode, spec: GraphNode, method: 'endpoint_id' | 'operation_id' | 'path_shape', level: 'DERIVED' | 'INFERRED', confidence: number) => {
    const id = ids.edge(sources.workspaceId, fast.id, spec.id, `architecture_${method}`);
    if (edges.some((item) => item.id === id)) return;
    edges.push({ id, workspaceId: sources.workspaceId, sourceId: fast.id, targetId: spec.id, kind: `architecture_${method}`, properties: { confidence } });
    matchedPairs.push({ fast, spec, match: method });
    const fastSource = evidenceFor(sources.fastApi, fast.id);
    const specSource = evidenceFor(sources.openApi, spec.id);
    const item: AnalysisEvidence = {
      id: ids.node(id, 'evidence:edge', `architecture.${method}`), subjectKind: 'edge', subjectId: id, level,
      type: `architecture.${method}`, confidence,
      provenance: { sources: [sourceProvenance(sources.fastApi, fastSource), sourceProvenance(sources.openApi, specSource)], inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`) },
      inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`),
    };
    if (!evidenceIds.has(item.id)) { evidenceIds.add(item.id); evidence.push(item); }
  };
  const unmatchedFast = new Map(fastEndpoints.map((node) => [node.id, node]));
  const unmatchedSpec = new Map(specEndpoints.map((node) => [node.id, node]));
  for (const fast of fastEndpoints) {
    const spec = unmatchedSpec.get(fast.id);
    if (!spec) continue;
    unmatchedFast.delete(fast.id); unmatchedSpec.delete(spec.id);
    pushMatch(fast, spec, 'endpoint_id', 'DERIVED', 1);
  }
  matchUnique(unmatchedFast, unmatchedSpec, (node) => { const id = stringProperty(node, 'operationId'); const namespace = stringProperty(node, 'namespace'); return id && namespace ? `${namespace}\u0000${id}` : undefined; }, 'operation_id', pushMatch, 'DERIVED', 1, (kind, candidates) => {
    for (const endpoint of candidates) addIssue(endpoint, kind, 'operationId does not identify a unique endpoint in both inputs.');
  });
  if (config.allowPathShapeInference) matchUnique(unmatchedFast, unmatchedSpec, (node) => {
    const namespace = stringProperty(node, 'namespace'); const method = stringProperty(node, 'method'); const shape = stringProperty(node, 'pathShape');
    return namespace && method && shape ? `${namespace}\u0000${method}\u0000${shape}` : undefined;
  }, 'path_shape', pushMatch, 'INFERRED', 0.8, (kind, candidates) => {
    for (const endpoint of candidates) addIssue(endpoint, kind, 'Path-shape candidates are ambiguous; no match was inferred.');
  });
  if (sources.fastApi && sources.openApi) {
    for (const endpoint of unmatchedFast.values()) addIssue(endpoint, 'unresolved', 'No OpenAPI operation could be matched to this FastAPI endpoint.');
    for (const endpoint of unmatchedSpec.values()) addIssue(endpoint, 'unresolved', 'No FastAPI endpoint could be matched to this OpenAPI operation.');
  }
  for (const pair of matchedPairs) compareContract(pair.fast, pair.spec, pair.match);
  function addIssue(endpoint: GraphNode, kind: 'ambiguous' | 'unresolved', message: string) {
    const id = ids.node(sources.workspaceId, `architecture://${kind}/${endpoint.id}`, `architecture_contract_${kind}`);
    if (issueIds.has(id) || nodes.length + edges.length + 2 > 9000 || evidence.length >= 10000 || diagnostics.length >= 10000) return;
    issueIds.add(id);
    nodes.push({ id, workspaceId: sources.workspaceId, kind: `architecture_contract_${kind}`, label: `${kind}: ${endpoint.label}`, properties: { sourceEndpointId: endpoint.id } });
    const edgeId = ids.edge(sources.workspaceId, endpoint.id, id, 'architecture_contract_finding');
    edges.push({ id: edgeId, workspaceId: sources.workspaceId, sourceId: endpoint.id, targetId: id, kind: 'architecture_contract_finding', properties: { code: `ARCHITECTURE_${kind.toUpperCase()}` } });
    diagnostics.push({ code: `ARCHITECTURE_${kind.toUpperCase()}`, severity: kind === 'ambiguous' ? 'warning' : 'info', message, detail: { endpointId: endpoint.id } });
    const input = openApiEndpointIds.has(endpoint.id) ? sources.openApi : sources.fastApi;
    const source = evidenceFor(input, endpoint.id);
    const item: AnalysisEvidence = {
      id: ids.node(id, 'evidence:node', `architecture.${kind}`), subjectKind: 'node', subjectId: id, level: 'DERIVED', type: `architecture.${kind}`,
      provenance: { sources: [sourceProvenance(input, source)], inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`) },
      inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`), detail: message,
    };
    if (!evidenceIds.has(item.id)) { evidenceIds.add(item.id); evidence.push(item); }
  }
  function compareContract(fast: GraphNode, spec: GraphNode, match: string) {
    if (!sources.fastApi || !sources.openApi) return;
    const relations = (generation: ArchitectureInputGeneration, endpoint: GraphNode, kind: string) => generation.edges.filter((edge) => edge.sourceId === endpoint.id && edge.kind === kind).sort((a, b) => a.id.localeCompare(b.id));
    const nodeById = (generation: ArchitectureInputGeneration, id: string) => generation.nodes.find((node) => node.id === id);
    const addMismatch = (dimension: string, detail: Record<string, unknown>) => {
      const id = ids.node(sources.workspaceId, `architecture://mismatch/${fast.id}/${dimension}`, 'architecture_contract_mismatch');
      if (issueIds.has(id)) return;
      if (nodes.length + edges.length >= 9000 || evidence.length >= 10000 || diagnostics.length >= 10000) return;
      issueIds.add(id);
      nodes.push({ id, workspaceId: sources.workspaceId, kind: 'architecture_contract_mismatch', label: `Contract mismatch: ${dimension}`, properties: { fastApiEndpointId: fast.id, openApiEndpointId: spec.id, dimension, ...detail } });
      const edgeId = ids.edge(sources.workspaceId, fast.id, id, 'architecture_contract_finding');
      edges.push({ id: edgeId, workspaceId: sources.workspaceId, sourceId: fast.id, targetId: id, kind: 'architecture_contract_finding', properties: { code: 'ARCHITECTURE_CONTRACT_MISMATCH', dimension } });
      const fastEvidence = evidenceFor(sources.fastApi, fast.id); const specEvidence = evidenceFor(sources.openApi, spec.id);
      evidence.push({ id: ids.node(id, 'evidence:node', 'architecture.mismatch'), subjectKind: 'node', subjectId: id, level: 'DERIVED', type: 'architecture.contract_mismatch', provenance: { match, sources: [sourceProvenance(sources.fastApi, fastEvidence), sourceProvenance(sources.openApi, specEvidence)], inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`) }, inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`) });
      diagnostics.push({ code: 'ARCHITECTURE_CONTRACT_MISMATCH', severity: 'warning', message: `Provable ${dimension} contract mismatch for '${fast.label}'.`, detail: { dimension, fastApiEndpointId: fast.id, openApiEndpointId: spec.id } });
    };
    const fastParams = relations(sources.fastApi, fast, 'accepts').map(({ targetId }) => nodeById(sources.fastApi!, targetId)).filter((node): node is GraphNode => node?.kind === 'api_parameter');
    const specParams = relations(sources.openApi, spec, 'accepts').map(({ targetId }) => nodeById(sources.openApi!, targetId)).filter((node): node is GraphNode => node?.kind === 'api_parameter');
    const pkey = (node: GraphNode) => { const loc = node.properties.in; const name = node.properties.alias ?? node.properties.name; return typeof loc === 'string' && typeof name === 'string' ? `${loc}\u0000${name}` : undefined; };
    const fastByParam = new Map(fastParams.map((node) => [pkey(node), node]).filter((entry): entry is [string, GraphNode] => !!entry[0]));
    const specByParam = new Map(specParams.map((node) => [pkey(node), node]).filter((entry): entry is [string, GraphNode] => !!entry[0]));
    for (const key of new Set([...fastByParam.keys(), ...specByParam.keys()])) {
      const impl = fastByParam.get(key); const contract = specByParam.get(key);
      if (!impl || !contract) { addMismatch('parameters', { parameter: key.replace('\u0000', ':') }); continue; }
      if (typeof impl.properties.required === 'boolean' && typeof contract.properties.required === 'boolean' && impl.properties.required !== contract.properties.required) addMismatch('parameter_required', { parameter: key.replace('\u0000', ':'), implementationRequired: impl.properties.required, contractRequired: contract.properties.required });
    }
    const responseStatuses = (generation: ArchitectureInputGeneration, endpoint: GraphNode) => relations(generation, endpoint, 'returns').map(({ targetId }) => nodeById(generation, targetId)).filter((node): node is GraphNode => node?.kind === 'api_response').map((node) => node.properties.statusCode ?? node.properties.status).filter((status) => typeof status === 'string' || typeof status === 'number').map(String);
    const fastStatus = responseStatuses(sources.fastApi, fast); if (!fastStatus.length) fastStatus.push('200');
    const specStatus = responseStatuses(sources.openApi, spec);
    const covered = (status: string) => specStatus.includes(status) || specStatus.includes('default') || specStatus.some((item) => /^([1-5])XX$/i.test(item) && item[0] === status[0]);
    if (specStatus.length && fastStatus.some((status) => /^\d{3}$/.test(status) && !covered(status))) addMismatch('response_status', { implementationStatuses: [...new Set(fastStatus)].sort(), contractStatuses: [...new Set(specStatus)].sort() });
  }
  return { nodes, edges, evidence, diagnostics, inputGenerations };
}

function matchUnique(fast: Map<string, GraphNode>, spec: Map<string, GraphNode>, keyOf: (node: GraphNode) => string | undefined, method: 'operation_id' | 'path_shape', add: (fast: GraphNode, spec: GraphNode, method: 'endpoint_id' | 'operation_id' | 'path_shape', level: 'DERIVED' | 'INFERRED', confidence: number) => void, level: 'DERIVED' | 'INFERRED' = 'DERIVED', confidence = 1, ambiguous?: (kind: 'ambiguous', candidates: GraphNode[]) => void) {
  const group = (nodes: Iterable<GraphNode>) => {
    const groups = new Map<string, GraphNode[]>();
    for (const node of nodes) { const key = keyOf(node); if (key) groups.set(key, [...(groups.get(key) ?? []), node]); }
    return groups;
  };
  const left = group(fast.values()); const right = group(spec.values());
  for (const [key, candidates] of left) {
    const targets = right.get(key);
    if (candidates.length !== 1 || targets?.length !== 1) {
      if (targets?.length) ambiguous?.('ambiguous', [...candidates, ...targets]);
      continue;
    }
    add(candidates[0]!, targets[0]!, method, level, confidence);
    fast.delete(candidates[0]!.id); spec.delete(targets[0]!.id);
  }
}

function stringProperty(node: GraphNode, key: string): string | undefined { const value = node.properties[key]; return typeof value === 'string' && value.length ? value : undefined; }
function evidenceFor(generation: ArchitectureInputGeneration | undefined, subjectId: string): AnalysisEvidence | undefined { return generation?.evidence.find((item) => item.subjectKind === 'node' && item.subjectId === subjectId); }
function sourceProvenance(generation: ArchitectureInputGeneration | undefined, evidence: AnalysisEvidence | undefined) {
  return evidence ? { analyzerId: generation?.analyzerId ?? null, evidenceId: evidence.id, type: evidence.type, level: evidence.level, uri: evidence.uri ?? null, line: evidence.line ?? null } : null;
}
