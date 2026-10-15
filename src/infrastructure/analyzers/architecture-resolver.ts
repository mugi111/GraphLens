import { AnalysisError, type AnalysisDiagnostic, type AnalysisEvidence, type ArchitectureInputGeneration, type AnalysisInputGeneration } from '../../domain/analyzer.js';
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
  const projectedNodeIds = new Set<string>();
  const projectedEdgeIds = new Set<string>();
  const processedClosures = new Set<string>();
  const matchedPairs: Array<{ fast: GraphNode; spec: GraphNode; match: string }> = [];
  const ambiguousEndpointIds = new Set<string>();
  let totalVisits = 0;
  let outputLimitReached = false;
  const markOutputLimit = () => {
    if (outputLimitReached) return;
    outputLimitReached = true;
    if (diagnostics.length < 10000) diagnostics.push({ code: 'ARCHITECTURE_OUTPUT_LIMIT', severity: 'warning', message: 'Architecture projection reached the configured result bounds; remaining findings were skipped.' });
  };
  const evidenceId = (subjectId: string, key: string) => ids.node(sources.workspaceId, `architecture-evidence://${subjectId}/${encodeURIComponent(key)}`, 'evidence');
  // The resolver works only from bounded projections of the supplied generations.
  const endpointNodes = (generation: ArchitectureInputGeneration | undefined) => (generation?.nodes ?? []).filter((node) => node.kind === 'api_endpoint');
  const allFastEndpoints = endpointNodes(sources.fastApi);
  const allSpecEndpoints = endpointNodes(sources.openApi);
  const fastEndpoints = allFastEndpoints.slice(0, config.maxEndpoints);
  const specEndpoints = allSpecEndpoints.slice(0, Math.max(0, config.maxEndpoints - fastEndpoints.length));
  if (allFastEndpoints.length + allSpecEndpoints.length > fastEndpoints.length + specEndpoints.length) diagnostics.push({ code: 'ARCHITECTURE_ENDPOINT_LIMIT', severity: 'warning', message: `Architecture endpoint input exceeded maxEndpoints (${config.maxEndpoints}); remaining endpoints were skipped.` });
  const openApiEndpointIds = new Set(specEndpoints.map(({ id }) => id));
  const ownersFor = (generation: ArchitectureInputGeneration | undefined, endpoint: GraphNode, kind: string) => generation ? generation.edges.filter((edge) => edge.targetId === endpoint.id && edge.kind === 'exposes').map((edge) => generation.nodes.find((node) => node.id === edge.sourceId)).filter((node): node is GraphNode => node?.kind === kind).sort((a, b) => a.id.localeCompare(b.id)) : [];
  const pushMatch = (fast: GraphNode, spec: GraphNode, method: 'endpoint_id' | 'operation_id' | 'path_shape', level: 'DERIVED' | 'INFERRED', confidence: number) => {
    const id = ids.edge(sources.workspaceId, fast.id, spec.id, `architecture_${method}`);
    if (edges.some((item) => item.id === id)) return true;
    if (nodes.length + edges.length + 1 > 9000 || evidence.length + 1 > 10000) {
      markOutputLimit();
      return false;
    }
    edges.push({ id, workspaceId: sources.workspaceId, sourceId: fast.id, targetId: spec.id, kind: 'implements_contract', properties: { matchMethod: method, confidence } });
    matchedPairs.push({ fast, spec, match: method });
    const fastSource = evidenceFor(sources.fastApi, fast.id);
    const specSource = evidenceFor(sources.openApi, spec.id);
    const item: AnalysisEvidence = {
      id: evidenceId(id, `architecture.${method}`), subjectKind: 'edge', subjectId: id, level,
      type: `architecture.${method}`,
      ...(level === 'INFERRED' ? { confidence } : {}),
      provenance: { sources: [sourceProvenance(sources.fastApi, fastSource), sourceProvenance(sources.openApi, specSource)], inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`) },
      inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`),
    };
    if (!evidenceIds.has(item.id)) { evidenceIds.add(item.id); evidence.push(item); }
    projectClosure(sources.fastApi, fast);
    projectClosure(sources.openApi, spec);
    return true;
  };
  const unmatchedFast = new Map(fastEndpoints.map((node) => [node.id, node]));
  const unmatchedSpec = new Map(specEndpoints.map((node) => [node.id, node]));
  for (const [map, otherMap, generation, otherGeneration, ownerKind, otherOwnerKind] of [[unmatchedFast, unmatchedSpec, sources.fastApi, sources.openApi, 'fastapi_route', 'openapi_operation'], [unmatchedSpec, unmatchedFast, sources.openApi, sources.fastApi, 'openapi_operation', 'fastapi_route']] as const) for (const endpoint of [...map.values()]) {
    if (ownersFor(generation, endpoint, ownerKind).length <= 1) continue;
    ambiguousEndpointIds.add(endpoint.id);
    addIssue(endpoint, 'ambiguous', 'Endpoint has multiple route or operation owners; no owner was selected.', generation);
    map.delete(endpoint.id);
    const counterpart = otherMap.get(endpoint.id);
    if (counterpart) { ambiguousEndpointIds.add(counterpart.id); addIssue(counterpart, 'ambiguous', 'Endpoint shares its identity with an endpoint that has multiple owners.', otherGeneration); otherMap.delete(counterpart.id); }
  }
  for (const fast of fastEndpoints) {
    const spec = unmatchedSpec.get(fast.id);
    if (!spec) continue;
    if (pushMatch(fast, spec, 'endpoint_id', 'DERIVED', 1)) { unmatchedFast.delete(fast.id); unmatchedSpec.delete(spec.id); }
  }
  const operationKey = (node: GraphNode, generation: ArchitectureInputGeneration | undefined, ownerKind: string) => {
    const owners = ownersFor(generation, node, ownerKind);
    if (owners.length !== 1) return undefined;
    const id = stringProperty(owners[0]!, 'operationId'); const namespace = stringProperty(node, 'namespace');
    return id && namespace ? `${namespace}\u0000${id}` : undefined;
  };
  const countKeys = (items: GraphNode[], generation: ArchitectureInputGeneration | undefined, ownerKind: string) => {
    const counts = new Map<string, number>();
    for (const node of items) for (const owner of ownersFor(generation, node, ownerKind)) {
      const operationId = stringProperty(owner, 'operationId'); const namespace = stringProperty(node, 'namespace');
      const key = operationId && namespace ? `${namespace}\u0000${operationId}` : undefined;
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const fastOperationCounts = countKeys(allFastEndpoints, sources.fastApi, 'fastapi_route'); const specOperationCounts = countKeys(allSpecEndpoints, sources.openApi, 'openapi_operation');
  const ambiguousOperationKeys = new Set([...fastOperationCounts.keys(), ...specOperationCounts.keys()].filter((key) => (fastOperationCounts.get(key) ?? 0) > 0 && (specOperationCounts.get(key) ?? 0) > 0 && ((fastOperationCounts.get(key) ?? 0) !== 1 || (specOperationCounts.get(key) ?? 0) !== 1)));
  for (const [map, counts] of [[unmatchedFast, fastOperationCounts], [unmatchedSpec, specOperationCounts]] as const) for (const node of [...map.values()]) {
    const key = operationKey(node, map === unmatchedFast ? sources.fastApi : sources.openApi, map === unmatchedFast ? 'fastapi_route' : 'openapi_operation');
    if (!key || !ambiguousOperationKeys.has(key)) continue;
    ambiguousEndpointIds.add(node.id); addIssue(node, 'ambiguous', 'operationId is not unique across the complete input generations.', map === unmatchedFast ? sources.fastApi : sources.openApi); map.delete(node.id);
  }
  matchUnique(unmatchedFast, unmatchedSpec, (node, side) => {
    const key = operationKey(node, side === 'left' ? sources.fastApi : sources.openApi, side === 'left' ? 'fastapi_route' : 'openapi_operation');
    return key && fastOperationCounts.get(key) === 1 && specOperationCounts.get(key) === 1 ? key : undefined;
  }, 'operation_id', pushMatch);
  if (config.allowPathShapeInference) {
    const rawShapeKey = (node: GraphNode) => {
    const namespace = stringProperty(node, 'namespace'); const method = stringProperty(node, 'method'); const shape = stringProperty(node, 'pathShape');
    return namespace && method && shape ? `${namespace}\u0000${method}\u0000${shape}` : undefined;
    };
    const countKeys = (items: GraphNode[]) => {
      const counts = new Map<string, number>();
      for (const node of items) { const key = rawShapeKey(node); if (key) counts.set(key, (counts.get(key) ?? 0) + 1); }
      return counts;
    };
    const fastShapeCounts = countKeys(allFastEndpoints); const specShapeCounts = countKeys(allSpecEndpoints);
    for (const [map, ownCounts] of [[unmatchedFast, fastShapeCounts], [unmatchedSpec, specShapeCounts]] as const) for (const node of [...map.values()]) {
      const key = rawShapeKey(node);
      if (!key || (fastShapeCounts.get(key) ?? 0) === 0 || (specShapeCounts.get(key) ?? 0) === 0) continue;
      if (fastShapeCounts.get(key) === 1 && specShapeCounts.get(key) === 1) continue;
      ambiguousEndpointIds.add(node.id); addIssue(node, 'ambiguous', 'Path-shape inference is not unique across the complete input generations.'); map.delete(node.id);
    }
    matchUnique(unmatchedFast, unmatchedSpec, (node) => {
      const key = rawShapeKey(node);
      return key && fastShapeCounts.get(key) === 1 && specShapeCounts.get(key) === 1 ? key : undefined;
    }, 'path_shape', pushMatch, 'INFERRED', 0.8);
  }
  const endpointInputTruncated = allFastEndpoints.length + allSpecEndpoints.length > fastEndpoints.length + specEndpoints.length;
  if (sources.fastApi && sources.openApi && !endpointInputTruncated && !outputLimitReached) {
    for (const endpoint of unmatchedFast.values()) if (!ambiguousEndpointIds.has(endpoint.id)) addIssue(endpoint, 'gap', 'No OpenAPI operation could be matched to this FastAPI endpoint.', sources.fastApi);
    for (const endpoint of unmatchedSpec.values()) if (!ambiguousEndpointIds.has(endpoint.id)) addIssue(endpoint, 'gap', 'No FastAPI endpoint could be matched to this OpenAPI operation.', sources.openApi);
  }
  if (!sources.fastApi || !sources.openApi) for (const endpoint of [...fastEndpoints, ...specEndpoints]) projectClosure(sources.fastApi ? sources.fastApi : sources.openApi, endpoint);
  for (const pair of matchedPairs) compareContract(pair.fast, pair.spec, pair.match);
  function addIssue(endpoint: GraphNode, kind: 'ambiguous' | 'unresolved' | 'gap', message: string, generation?: ArchitectureInputGeneration) {
    const id = ids.node(sources.workspaceId, `architecture://${kind}/${endpoint.id}`, `architecture_contract_${kind}`);
    if (issueIds.has(id)) return;
    const input = generation ?? (openApiEndpointIds.has(endpoint.id) ? sources.openApi : sources.fastApi);
    projectClosure(input, endpoint);
    if (nodes.length + edges.length + 2 > 9000 || evidence.length + 2 > 10000 || diagnostics.length >= 10000) { markOutputLimit(); return; }
    issueIds.add(id);
    nodes.push({ id, workspaceId: sources.workspaceId, kind: `architecture_contract_${kind}`, label: `${kind}: ${endpoint.label}`, properties: { sourceEndpointId: endpoint.id } });
    const edgeId = ids.edge(sources.workspaceId, endpoint.id, id, 'architecture_contract_finding');
    edges.push({ id: edgeId, workspaceId: sources.workspaceId, sourceId: endpoint.id, targetId: id, kind: 'architecture_contract_finding', properties: { code: `ARCHITECTURE_${kind.toUpperCase()}` } });
    diagnostics.push({ code: `ARCHITECTURE_${kind.toUpperCase()}`, severity: kind === 'unresolved' ? 'info' : 'warning', message, detail: { endpointId: endpoint.id } });
    const source = evidenceFor(input, endpoint.id);
    const item: AnalysisEvidence = {
      id: evidenceId(id, `architecture.${kind}`), subjectKind: 'node', subjectId: id, level: 'DERIVED', type: `architecture.${kind}`,
      provenance: { sources: [sourceProvenance(input, source)], inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`) },
      inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`), detail: message,
    };
    if (!evidenceIds.has(item.id)) { evidenceIds.add(item.id); evidence.push(item); }
    const edgeEvidenceId = evidenceId(edgeId, `architecture.${kind}.finding`);
    if (!evidenceIds.has(edgeEvidenceId) && evidence.length < 10000) {
      evidenceIds.add(edgeEvidenceId);
      evidence.push({ id: edgeEvidenceId, subjectKind: 'edge', subjectId: edgeId, level: 'DERIVED', type: `architecture.${kind}.finding`, provenance: { sourceEvidenceId: source?.id ?? null, inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`) }, inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`) });
    }
  }
  function compareContract(fast: GraphNode, spec: GraphNode, match: string) {
    if (!sources.fastApi || !sources.openApi) return;
    const relations = (generation: ArchitectureInputGeneration, endpoint: GraphNode, kind: string) => generation.edges.filter((edge) => edge.sourceId === endpoint.id && edge.kind === kind).sort((a, b) => a.id.localeCompare(b.id));
    const nodeById = (generation: ArchitectureInputGeneration, id: string) => generation.nodes.find((node) => node.id === id);
    const operationId = sources.openApi.edges.find((edge) => edge.targetId === spec.id && edge.kind === 'exposes')?.sourceId;
    const specOwner = operationId ? nodeById(sources.openApi, operationId) ?? spec : spec;
    const addMismatch = (dimension: string, detail: Record<string, unknown>) => {
      const id = ids.node(sources.workspaceId, `architecture://mismatch/${fast.id}/${dimension}`, 'architecture_contract_mismatch');
      if (issueIds.has(id)) return;
      if (nodes.length + edges.length + 2 > 9000 || evidence.length + 2 > 10000 || diagnostics.length >= 10000) { markOutputLimit(); return; }
      issueIds.add(id);
      nodes.push({ id, workspaceId: sources.workspaceId, kind: 'architecture_contract_mismatch', label: `Contract mismatch: ${dimension}`, properties: { fastApiEndpointId: fast.id, openApiEndpointId: spec.id, dimension, ...detail } });
      const edgeId = ids.edge(sources.workspaceId, fast.id, id, 'architecture_contract_finding');
      edges.push({ id: edgeId, workspaceId: sources.workspaceId, sourceId: fast.id, targetId: id, kind: 'architecture_contract_finding', properties: { code: 'ARCHITECTURE_CONTRACT_MISMATCH', dimension } });
      const fastEvidence = evidenceFor(sources.fastApi, fast.id); const specEvidence = evidenceFor(sources.openApi, spec.id);
      evidence.push({ id: evidenceId(id, 'architecture.mismatch'), subjectKind: 'node', subjectId: id, level: 'DERIVED', type: 'architecture.contract_mismatch', provenance: { match, sources: [sourceProvenance(sources.fastApi, fastEvidence), sourceProvenance(sources.openApi, specEvidence)], inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`) }, inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`) });
      if (evidence.length < 10000) evidence.push({ id: evidenceId(edgeId, 'architecture.contract_mismatch.finding'), subjectKind: 'edge', subjectId: edgeId, level: 'DERIVED', type: 'architecture.contract_mismatch.finding', provenance: { sources: [sourceProvenance(sources.fastApi, fastEvidence), sourceProvenance(sources.openApi, specEvidence)], inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`) }, inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`) });
      diagnostics.push({ code: 'ARCHITECTURE_CONTRACT_MISMATCH', severity: 'warning', message: `Provable ${dimension} contract mismatch for '${fast.label}'.`, detail: { dimension, fastApiEndpointId: fast.id, openApiEndpointId: spec.id } });
    };
    const fastParams = relations(sources.fastApi, fast, 'accepts').map(({ targetId }) => nodeById(sources.fastApi!, targetId)).filter((node): node is GraphNode => node?.kind === 'api_parameter');
    const specParams = relations(sources.openApi, specOwner, 'accepts').map(({ targetId }) => nodeById(sources.openApi!, targetId)).filter((node): node is GraphNode => node?.kind === 'api_parameter');
    const pkey = (node: GraphNode) => { const loc = node.properties.in; const name = node.properties.alias ?? node.properties.name; return typeof loc === 'string' && typeof name === 'string' ? `${loc}\u0000${name}` : undefined; };
    const fastByParam = new Map(fastParams.map((node) => [pkey(node), node]).filter((entry): entry is [string, GraphNode] => !!entry[0]));
    const specByParam = new Map(specParams.map((node) => [pkey(node), node]).filter((entry): entry is [string, GraphNode] => !!entry[0]));
    for (const key of fastByParam.size && specByParam.size ? new Set([...fastByParam.keys(), ...specByParam.keys()]) : []) {
      const impl = fastByParam.get(key); const contract = specByParam.get(key);
      if (!impl || !contract) { addMismatch('parameters', { parameter: key.replace('\u0000', ':') }); continue; }
      if (typeof impl.properties.required === 'boolean' && typeof contract.properties.required === 'boolean' && impl.properties.required !== contract.properties.required) addMismatch('parameter_required', { parameter: key.replace('\u0000', ':'), implementationRequired: impl.properties.required, contractRequired: contract.properties.required });
    }
    const bodies = (generation: ArchitectureInputGeneration, endpoint: GraphNode) => relations(generation, endpoint, 'accepts').map(({ targetId }) => nodeById(generation, targetId)).filter((node): node is GraphNode => node?.kind === 'api_request_body');
    const fastBodies = bodies(sources.fastApi, fast); const specBodies = bodies(sources.openApi, specOwner);
    const fastApiRoute = ownersFor(sources.fastApi, fast, 'fastapi_route')[0];
    const fastApiHandlerId = typeof fastApiRoute?.properties.handlerId === 'string' ? fastApiRoute.properties.handlerId : undefined;
    const fastApiDiagnosticUris = new Set([fast, fastApiRoute, fastApiHandlerId ? nodeById(sources.fastApi, fastApiHandlerId) : undefined]
      .map((node) => node ? evidenceFor(sources.fastApi, node.id)?.uri : undefined)
      .filter((uri): uri is string => typeof uri === 'string'));
    const unresolvedFastApiBody = !fastBodies.length && sources.fastApi.diagnostics.some((item) => {
      const code = item.code ?? '';
      const isRelevant = /FASTAPI_(UNRESOLVED_PARAMETER|UNRESOLVED_DEPENDENCY|AMBIGUOUS_DEPENDENCY|DYNAMIC_SECURITY_SCOPES)/.test(code);
      return isRelevant && (!item.uri || fastApiDiagnosticUris.size === 0 || fastApiDiagnosticUris.has(item.uri));
    });
    const openApiOperationEvidence = evidenceFor(sources.openApi, specOwner.id);
    const unresolvedRequestBody = !specBodies.length && sources.openApi.diagnostics.some((item) => {
      const code = item.code ?? '';
      const isRelevant = /OPENAPI_(EXTERNAL_REF_UNRESOLVED|LOCAL_REF_UNRESOLVED|REF_CYCLE|REF_DEPTH_LIMIT|DYNAMIC_REF_UNRESOLVED|INVALID_REF|INVALID_DOCUMENT|INVALID_ENCODING)/.test(code);
      return isRelevant && (!item.uri || !openApiOperationEvidence?.uri || item.uri === openApiOperationEvidence.uri);
    });
    if (!unresolvedRequestBody && fastBodies.length && !specBodies.length) addMismatch('request_body_presence', { implementationHasRequestBody: true, contractHasRequestBody: false });
    if (!unresolvedFastApiBody && specBodies.length && !fastBodies.length) addMismatch('request_body_presence', { implementationHasRequestBody: false, contractHasRequestBody: true });
    if (fastBodies.length === 1 && specBodies.length === 1 && typeof fastBodies[0]!.properties.required === 'boolean' && typeof specBodies[0]!.properties.required === 'boolean' && fastBodies[0]!.properties.required !== specBodies[0]!.properties.required) addMismatch('request_body_required', { implementationRequired: fastBodies[0]!.properties.required, contractRequired: specBodies[0]!.properties.required });
    if (fastBodies.length === 1 && specBodies.length === 1) {
      const implementationMedia = Array.isArray(fastBodies[0]!.properties.contentTypes) ? fastBodies[0]!.properties.contentTypes.filter((value): value is string => typeof value === 'string') : [];
      const contractMedia = Array.isArray(specBodies[0]!.properties.contentTypes) ? specBodies[0]!.properties.contentTypes.filter((value): value is string => typeof value === 'string') : [];
      if (implementationMedia.length && contractMedia.length && !implementationMedia.some((type) => contractMedia.includes(type))) addMismatch('request_body_media', { implementationMedia: [...new Set(implementationMedia)].sort(), contractMedia: [...new Set(contractMedia)].sort() });
    }
    const responseStatuses = (generation: ArchitectureInputGeneration, endpoint: GraphNode) => relations(generation, endpoint, 'returns').map(({ targetId }) => nodeById(generation, targetId)).filter((node): node is GraphNode => node?.kind === 'api_response').map((node) => node.properties.statusCode ?? node.properties.status).filter((status) => typeof status === 'string' || typeof status === 'number').map(String);
    const fastStatus = responseStatuses(sources.fastApi, fast);
    const fastRouteId = sources.fastApi.edges.find((edge) => edge.targetId === fast.id && edge.kind === 'exposes')?.sourceId;
    const fastRoute = fastRouteId ? nodeById(sources.fastApi, fastRouteId) : undefined;
    const routeStatus = typeof fastRoute?.properties.statusCode === 'number' ? String(fastRoute.properties.statusCode) : typeof fastRoute?.properties.statusCode === 'string' && /^\d{3}$/.test(fastRoute.properties.statusCode) ? fastRoute.properties.statusCode : undefined;
    if (routeStatus) fastStatus.push(routeStatus);
    const specStatus = responseStatuses(sources.openApi, specOwner);
    const covered = (status: string) => specStatus.includes(status) || specStatus.includes('default') || specStatus.some((item) => /^([1-5])XX$/i.test(item) && item[0] === status[0]);
    if (specStatus.length && fastStatus.some((status) => /^\d{3}$/.test(status) && !covered(status))) addMismatch('response_status', { implementationStatuses: [...new Set(fastStatus)].sort(), contractStatuses: [...new Set(specStatus)].sort() });
    const specMode = stringProperty(specOwner, 'securityMode');
    type SchemeFact = { tuple?: string; scopes?: string[]; required?: boolean };
    type SecurityGroup = { id: string; facts: SchemeFact[]; complete: boolean };
    const securityGroups = (generation: ArchitectureInputGeneration, endpoint: GraphNode, isOpenApi: boolean): SecurityGroup[] => {
      const groups = new Map<string, SecurityGroup>();
      for (const edge of relations(generation, endpoint, 'secured_by')) {
        const requirement = nodeById(generation, edge.targetId);
        if (!requirement) continue;
        const groupId = isOpenApi ? String(requirement.properties.alternative) : String(requirement.properties.requirementGroup ?? '');
        if (!groupId) continue;
        let group = groups.get(groupId);
        if (!group) { group = { id: groupId, facts: [], complete: true }; groups.set(groupId, group); }
        const schemeEdges = generation.edges.filter((item) => item.sourceId === requirement.id && item.kind === 'uses_scheme').sort((a, b) => a.id.localeCompare(b.id));
        if (!schemeEdges.length) { group.complete = false; continue; }
        for (const schemeEdge of schemeEdges) {
          const scheme = nodeById(generation, schemeEdge.targetId);
          const tuple = scheme ? normalizeScheme(scheme) : undefined;
          const rawScopes = schemeEdge.properties.scopes ?? requirement.properties.scopes;
          const scopes = Array.isArray(rawScopes) ? rawScopes.filter((value): value is string => typeof value === 'string').sort() : undefined;
          const required = isOpenApi ? true : typeof schemeEdge.properties.required === 'boolean' ? schemeEdge.properties.required : typeof requirement.properties.required === 'boolean' ? requirement.properties.required : requirement.properties.mode === 'joint' ? true : requirement.properties.mode === 'optional' ? false : undefined;
          if (!tuple || !scopes) group.complete = false;
          if (required === undefined) group.complete = false;
          group.facts.push({ ...(tuple ? { tuple } : {}), ...(scopes ? { scopes } : {}), ...(required !== undefined ? { required } : {}) });
        }
      }
      return [...groups.values()].map((group) => ({ ...group, facts: group.facts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }));
    };
    const fastSecurity = securityGroups(sources.fastApi, fast, false);
    const specSecurity = securityGroups(sources.openApi, specOwner, true);
    const fastRequired = fastSecurity.some((group) => group.facts.some((fact) => fact.required === true));
    if ((specMode === 'disabled' || specMode === 'none') && fastRequired) addMismatch('security_requiredness', { implementationRequired: true, contractSecurityMode: specMode });
    if (specMode === 'declared' || specMode === 'document') {
      const fastGroup = fastSecurity.length === 1 ? fastSecurity[0] : undefined;
      const specGroup = specSecurity.length === 1 ? specSecurity[0] : undefined;
      if (fastGroup?.complete && specGroup?.complete) {
        for (const fact of fastGroup.facts) {
          const counterpart = specGroup.facts.find((candidate) => candidate.tuple === fact.tuple && JSON.stringify(candidate.scopes) === JSON.stringify(fact.scopes));
          if (fact.required === true && !counterpart) addMismatch('security_requirement_group', { implementationScheme: fact, contractSchemes: specGroup.facts });
          if (fact.required === false && counterpart?.required === true) addMismatch('security_requiredness', { implementationScheme: fact, contractScheme: counterpart });
        }
        for (const fact of specGroup.facts) {
          const counterpart = fastGroup.facts.find((candidate) => candidate.tuple === fact.tuple && JSON.stringify(candidate.scopes) === JSON.stringify(fact.scopes));
          if (counterpart?.required === false && fact.required === true) addMismatch('security_requiredness', { implementationScheme: counterpart, contractScheme: fact });
        }
      }
    }
  }
  function projectClosure(generation: ArchitectureInputGeneration | undefined, endpoint: GraphNode) {
    if (!generation || processedClosures.has(`${generation.analyzerId}:${generation.generationId}:${endpoint.id}`)) return;
    processedClosures.add(`${generation.analyzerId}:${generation.generationId}:${endpoint.id}`);
    const byId = new Map(generation.nodes.map((node) => [node.id, node]));
    const allowedKinds = new Set(['api_endpoint', 'fastapi_route', 'openapi_operation', 'python_function', 'python_class', 'api_parameter', 'api_request_body', 'api_response', 'api_security_requirement', 'api_security_scheme', 'api_schema_reference', 'api_schema', 'sqlalchemy_model', 'sqlalchemy_table']);
    const allowedEdges = new Set(['exposes', 'handled_by', 'depends_on', 'calls', 'references', 'accepts', 'returns', 'uses_schema', 'secured_by', 'uses_scheme', 'maps_to', 'contains']);
    const addNode = (node: GraphNode | undefined) => {
      if (!node || !allowedKinds.has(node.kind) || projectedNodeIds.has(node.id)) return;
      if (nodes.length + edges.length >= 9000) { markOutputLimit(); return; }
      projectedNodeIds.add(node.id);
      const safe: Record<string, unknown> = {};
      const fields: Record<string, string[]> = {
        api_endpoint: ['namespace', 'method', 'path', 'pathShape', 'operationId', 'securityMode'], fastapi_route: ['namespace', 'path', 'pathShape', 'methods', 'operationId'],
        openapi_operation: ['documentPath', 'method', 'path', 'operationId', 'securityMode'], python_function: ['module', 'qualifiedName', 'async'], python_class: ['module', 'qualifiedName'],
        api_parameter: ['name', 'alias', 'in', 'required', 'contentTypes'], api_request_body: ['required', 'contentTypes', 'model'], api_response: ['status', 'statusCode', 'model'],
        api_security_requirement: ['alternative', 'scopes', 'requirementGroup', 'mode', 'required'], api_security_scheme: ['constructor', 'scheme', 'type', 'name', 'in'], api_schema_reference: ['ref', 'referenceKind'], api_schema: ['name'],
        sqlalchemy_model: ['tableName', 'schema', 'databaseNamespace'], sqlalchemy_table: ['name', 'schema', 'databaseNamespace'],
      };
      for (const key of fields[node.kind] ?? []) if (node.properties[key] !== undefined && (typeof node.properties[key] !== 'object' || node.properties[key] === null)) safe[key] = node.properties[key];
      nodes.push({ id: node.id, workspaceId: sources.workspaceId, kind: node.kind, label: node.label, properties: safe, analyzerId: generation.analyzerId, generationId: generation.generationId, level: 'DERIVED' });
      const source = generation.evidence.find((item) => item.subjectKind === 'node' && item.subjectId === node.id);
      if (source && evidence.length < 10000) {
        const derivedId = evidenceId(node.id, `${generation.analyzerId}:${source.id}`);
        if (!evidenceIds.has(derivedId)) { evidenceIds.add(derivedId); evidence.push({ ...source, id: derivedId, level: source.level === 'INFERRED' ? 'INFERRED' : 'DERIVED', provenance: { analyzerId: generation.analyzerId, sourceEvidenceId: source.id, sourceLevel: source.level }, inputGenerations: [`${generation.analyzerId}:${generation.generationId}`] }); }
      } else if (source) markOutputLimit();
    };
    const addEdge = (edge: GraphEdge) => {
      if (!allowedEdges.has(edge.kind) || projectedEdgeIds.has(edge.id)) return;
      const endpoints = [byId.get(edge.sourceId), byId.get(edge.targetId)];
      const newNodes = new Set(endpoints.filter((node): node is GraphNode => !!node && allowedKinds.has(node.kind) && !projectedNodeIds.has(node.id)).map(({ id }) => id)).size;
      if (nodes.length + edges.length + newNodes + 1 > 9000) { markOutputLimit(); return; }
      addNode(endpoints[0]); addNode(endpoints[1]);
      if (!projectedNodeIds.has(edge.sourceId) || !projectedNodeIds.has(edge.targetId)) return;
      projectedEdgeIds.add(edge.id);
      edges.push({ ...edge, analyzerId: generation.analyzerId, generationId: generation.generationId, level: 'DERIVED' });
      const source = generation.evidence.find((item) => item.subjectKind === 'edge' && item.subjectId === edge.id);
      if (source && evidence.length < 10000) {
        const derivedId = evidenceId(edge.id, `${generation.analyzerId}:${source.id}`);
        if (!evidenceIds.has(derivedId)) { evidenceIds.add(derivedId); evidence.push({ ...source, id: derivedId, level: source.level === 'INFERRED' ? 'INFERRED' : 'DERIVED', provenance: { analyzerId: generation.analyzerId, sourceEvidenceId: source.id, sourceLevel: source.level }, inputGenerations: [`${generation.analyzerId}:${generation.generationId}`] }); }
      } else if (source) markOutputLimit();
    };
    addNode(endpoint);
    const outgoing = (id: string) => generation.edges.filter((edge) => edge.sourceId === id && allowedEdges.has(edge.kind)).sort((a, b) => a.id.localeCompare(b.id));
    const incoming = (id: string, kind: string) => generation.edges.filter((edge) => edge.targetId === id && edge.kind === kind).sort((a, b) => a.id.localeCompare(b.id));
    const callsQueue: Array<{ id: string; depth: number }> = [];
    const reachedClasses = new Set<string>();
    for (const edge of outgoing(endpoint.id)) {
      addEdge(edge);
      if (edge.kind === 'depends_on' && byId.get(edge.targetId)?.kind === 'python_function') callsQueue.push({ id: edge.targetId, depth: 0 });
      if (byId.get(edge.targetId)?.kind === 'python_class') reachedClasses.add(edge.targetId);
      if (edge.kind === 'maps_to' && byId.get(edge.targetId)?.kind === 'sqlalchemy_model') {
        for (const relation of outgoing(edge.targetId)) if (relation.kind === 'contains' && byId.get(relation.targetId)?.kind === 'sqlalchemy_table') addEdge(relation);
      }
    }
    for (const edge of incoming(endpoint.id, 'exposes')) {
      addEdge(edge);
      const owner = byId.get(edge.sourceId);
      if (owner?.kind === 'fastapi_route') {
        for (const relation of outgoing(owner.id)) {
          addEdge(relation);
          if (relation.kind === 'handled_by') callsQueue.push({ id: relation.targetId, depth: 0 });
        }
      } else if (owner?.kind === 'openapi_operation') {
        for (const relation of outgoing(owner.id)) addEdge(relation);
      }
    }
    const visited = new Set<string>();
    while (callsQueue.length) {
      callsQueue.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
      const current = callsQueue.shift()!;
      if (visited.has(current.id)) continue;
      if (current.depth > config.maxTraversalDepth || visited.size >= config.maxVisitedSymbolsPerEndpoint || totalVisits >= config.maxTotalTraversalVisits) {
        if (diagnostics.length < 10000) diagnostics.push({ code: 'ARCHITECTURE_TRAVERSAL_LIMIT', severity: 'info', message: 'Bounded handler traversal reached a configured limit; remaining symbols were skipped.', detail: { endpointId: endpoint.id } });
        break;
      }
      visited.add(current.id); totalVisits++;
      const currentNode = byId.get(current.id); addNode(currentNode);
      for (const edge of outgoing(current.id)) {
        if (!['calls', 'references', 'depends_on'].includes(edge.kind)) continue;
        addEdge(edge);
        const target = byId.get(edge.targetId);
        if (target?.kind === 'python_function' && current.depth < config.maxTraversalDepth) callsQueue.push({ id: edge.targetId, depth: current.depth + 1 });
        if (target?.kind === 'python_class') reachedClasses.add(target.id);
      }
    }
    if (sources.sqlAlchemy && generation.analyzerId === 'builtin.fastapi') for (const classId of reachedClasses) {
      const models = sources.sqlAlchemy.nodes.filter((node) => node.kind === 'sqlalchemy_model');
      const mappings = sources.sqlAlchemy.edges.filter((item) => item.sourceId === classId && item.kind === 'maps_to' && models.some((model) => model.id === item.targetId));
      if (mappings.length !== 1) continue;
      const model = models.find((item) => item.id === mappings[0]!.targetId)!;
      const tables = sources.sqlAlchemy.edges.filter((item) => item.sourceId === model.id && item.kind === 'contains' && sources.sqlAlchemy!.nodes.some((node) => node.id === item.targetId && node.kind === 'sqlalchemy_table'));
      if (tables.length === 1) {
        projectClosure(sources.sqlAlchemy, byId.get(classId) ?? endpoint);
        const id = ids.edge(sources.workspaceId, classId, model.id, 'accesses_model');
        if (!edges.some((edge) => edge.id === id) && nodes.length + edges.length < 9000 && evidence.length < 10000) {
          edges.push({ id, workspaceId: sources.workspaceId, sourceId: classId, targetId: model.id, kind: 'accesses_model', properties: { correlation: 'maps_to' } });
          const sourceEvidence = evidenceFor(generation, classId);
          if (evidence.length < 10000) evidence.push({ id: evidenceId(id, 'architecture.accesses_model'), subjectKind: 'edge', subjectId: id, level: 'DERIVED', type: 'architecture.accesses_model', provenance: { sources: [sourceProvenance(generation, sourceEvidence)], inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`) }, inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`) });
        } else if (!edges.some((edge) => edge.id === id)) markOutputLimit();
      }
    }
  }
  if (outputLimitReached) throw new AnalysisError('ANALYZER_FAILED', 'Architecture result exceeded a hard projection limit; the partial result was discarded.', [{ code: 'ARCHITECTURE_OUTPUT_LIMIT', severity: 'error', message: 'Architecture result exceeded a hard projection limit; the partial result was discarded.' }]);
  return { nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)), edges: edges.sort((a, b) => a.id.localeCompare(b.id)), evidence: evidence.sort((a, b) => (a.id ?? '').localeCompare(b.id ?? '')), diagnostics: diagnostics.slice(0, 10000), inputGenerations };
}

function matchUnique(fast: Map<string, GraphNode>, spec: Map<string, GraphNode>, keyOf: (node: GraphNode, side: 'left' | 'right') => string | undefined, method: 'operation_id' | 'path_shape', add: (fast: GraphNode, spec: GraphNode, method: 'endpoint_id' | 'operation_id' | 'path_shape', level: 'DERIVED' | 'INFERRED', confidence: number) => boolean, level: 'DERIVED' | 'INFERRED' = 'DERIVED', confidence = 1, ambiguous?: (kind: 'ambiguous', candidates: GraphNode[]) => void) {
  const group = (nodes: Iterable<GraphNode>, side: 'left' | 'right') => {
    const groups = new Map<string, GraphNode[]>();
    for (const node of nodes) { const key = keyOf(node, side); if (key) groups.set(key, [...(groups.get(key) ?? []), node]); }
    return groups;
  };
  const left = group(fast.values(), 'left'); const right = group(spec.values(), 'right');
  for (const [key, candidates] of left) {
    const targets = right.get(key);
    if (candidates.length !== 1 || targets?.length !== 1) {
      if (targets?.length) ambiguous?.('ambiguous', [...candidates, ...targets]);
      continue;
    }
    if (!add(candidates[0]!, targets[0]!, method, level, confidence)) continue;
    fast.delete(candidates[0]!.id); spec.delete(targets[0]!.id);
  }
}

function stringProperty(node: GraphNode, key: string): string | undefined { const value = node.properties[key]; return typeof value === 'string' && value.length ? value : undefined; }
function evidenceFor(generation: ArchitectureInputGeneration | undefined, subjectId: string): AnalysisEvidence | undefined { return generation?.evidence.find((item) => item.subjectKind === 'node' && item.subjectId === subjectId); }
function sourceProvenance(generation: ArchitectureInputGeneration | undefined, evidence: AnalysisEvidence | undefined) {
  return evidence ? { analyzerId: generation?.analyzerId ?? null, evidenceId: evidence.id, type: evidence.type, level: evidence.level, uri: evidence.uri ?? null, line: evidence.line ?? null } : null;
}

function normalizeScheme(node: GraphNode): string | undefined {
  const constructor = node.properties.constructor;
  if (typeof constructor === 'string') {
    if (/APIKeyHeader$/.test(constructor)) return `apiKey:${String(node.properties.in ?? 'header')}`;
    if (/APIKeyQuery$/.test(constructor)) return `apiKey:${String(node.properties.in ?? 'query')}`;
    if (/APIKeyCookie$/.test(constructor)) return `apiKey:${String(node.properties.in ?? 'cookie')}`;
    if (/HTTPBearer$/.test(constructor)) return 'http:bearer';
    if (/HTTPBasic$/.test(constructor)) return 'http:basic';
    if (/HTTPDigest$/.test(constructor)) return 'http:digest';
    if (/OAuth2/.test(constructor)) return 'oauth2';
    if (/OpenIdConnect$/.test(constructor)) return 'openIdConnect';
  }
  if (node.properties.type === 'apiKey' && typeof node.properties.in === 'string') return `apiKey:${node.properties.in}`;
  if (node.properties.type === 'http' && typeof node.properties.scheme === 'string') return `http:${node.properties.scheme.toLowerCase()}`;
  if (node.properties.type === 'oauth2') return 'oauth2';
  if (node.properties.type === 'openIdConnect') return 'openIdConnect';
  return undefined;
}
