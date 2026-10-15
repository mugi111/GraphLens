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
  const unknown = Object.keys(input).filter((key) => !(key in defaults));
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
  // The resolver works only from bounded projections of the supplied generations.
  const endpointNodes = (generation: ArchitectureInputGeneration | undefined) => (generation?.nodes ?? []).filter((node) => node.kind === 'api_endpoint');
  const fastEndpoints = endpointNodes(sources.fastApi).slice(0, config.maxEndpoints);
  const specEndpoints = endpointNodes(sources.openApi).slice(0, config.maxEndpoints);
  if (endpointNodes(sources.fastApi).length > config.maxEndpoints || endpointNodes(sources.openApi).length > config.maxEndpoints) diagnostics.push({ code: 'ARCHITECTURE_ENDPOINT_LIMIT', severity: 'warning', message: `Architecture endpoint input exceeded maxEndpoints (${config.maxEndpoints}); remaining endpoints were skipped.` });
  const pushMatch = (fast: GraphNode, spec: GraphNode, method: 'endpoint_id' | 'operation_id' | 'path_shape', level: 'DERIVED' | 'INFERRED', confidence: number) => {
    const id = ids.edge(sources.workspaceId, fast.id, spec.id, `architecture_${method}`);
    if (edges.some((item) => item.id === id)) return;
    edges.push({ id, workspaceId: sources.workspaceId, sourceId: fast.id, targetId: spec.id, kind: `architecture_${method}`, properties: { confidence } });
    const fastSource = evidenceFor(sources.fastApi, fast.id);
    const specSource = evidenceFor(sources.openApi, spec.id);
    evidence.push({
      id: ids.node(id, 'evidence:edge', `architecture.${method}`), subjectKind: 'edge', subjectId: id, level,
      type: `architecture.${method}`, confidence,
      provenance: { sources: [sourceProvenance(sources.fastApi, fastSource), sourceProvenance(sources.openApi, specSource)], inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`) },
      inputGenerations: inputGenerations.map(({ analyzerId, generationId }) => `${analyzerId}:${generationId}`),
    });
  };
  const unmatchedFast = new Map(fastEndpoints.map((node) => [node.id, node]));
  const unmatchedSpec = new Map(specEndpoints.map((node) => [node.id, node]));
  for (const fast of fastEndpoints) {
    const spec = unmatchedSpec.get(fast.id);
    if (!spec) continue;
    unmatchedFast.delete(fast.id); unmatchedSpec.delete(spec.id);
    pushMatch(fast, spec, 'endpoint_id', 'DERIVED', 1);
  }
  matchUnique(unmatchedFast, unmatchedSpec, (node) => stringProperty(node, 'operationId'), 'operation_id', pushMatch);
  if (config.allowPathShapeInference) matchUnique(unmatchedFast, unmatchedSpec, (node) => {
    const namespace = stringProperty(node, 'namespace'); const method = stringProperty(node, 'method'); const shape = stringProperty(node, 'pathShape');
    return namespace && method && shape ? `${namespace}\u0000${method}\u0000${shape}` : undefined;
  }, 'path_shape', pushMatch, 'INFERRED', 0.8);
  return { nodes, edges, evidence, diagnostics, inputGenerations };
}

function matchUnique(fast: Map<string, GraphNode>, spec: Map<string, GraphNode>, keyOf: (node: GraphNode) => string | undefined, method: 'operation_id' | 'path_shape', add: (fast: GraphNode, spec: GraphNode, method: 'endpoint_id' | 'operation_id' | 'path_shape', level: 'DERIVED' | 'INFERRED', confidence: number) => void, level: 'DERIVED' | 'INFERRED' = 'DERIVED', confidence = 1) {
  const group = (nodes: Iterable<GraphNode>) => {
    const groups = new Map<string, GraphNode[]>();
    for (const node of nodes) { const key = keyOf(node); if (key) groups.set(key, [...(groups.get(key) ?? []), node]); }
    return groups;
  };
  const left = group(fast.values()); const right = group(spec.values());
  for (const [key, candidates] of left) {
    const targets = right.get(key);
    if (candidates.length !== 1 || targets?.length !== 1) continue;
    add(candidates[0]!, targets[0]!, method, level, confidence);
    fast.delete(candidates[0]!.id); spec.delete(targets[0]!.id);
  }
}

function stringProperty(node: GraphNode, key: string): string | undefined { const value = node.properties[key]; return typeof value === 'string' && value.length ? value : undefined; }
function evidenceFor(generation: ArchitectureInputGeneration | undefined, subjectId: string): AnalysisEvidence | undefined { return generation?.evidence.find((item) => item.subjectKind === 'node' && item.subjectId === subjectId); }
function sourceProvenance(generation: ArchitectureInputGeneration | undefined, evidence: AnalysisEvidence | undefined) {
  return evidence ? { analyzerId: generation?.analyzerId ?? null, evidenceId: evidence.id, type: evidence.type, level: evidence.level, uri: evidence.uri ?? null, line: evidence.line ?? null } : null;
}
