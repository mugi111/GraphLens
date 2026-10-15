import { GraphIdentityFactory } from '../../core/graph-identity.js';
import type { AnalysisEvidence } from '../../domain/analyzer.js';
import type { GraphEdge, GraphNode, Workspace } from '../../domain/graph.js';
import type { PythonImportFact } from './python-source-types.js';

const identity = new GraphIdentityFactory();

/** Resolves only against files in this scan. Everything else stays visibly unresolved. */
export function resolvePythonImports(workspace: Workspace, imports: PythonImportFact[], nodes: GraphNode[]): { nodes: GraphNode[]; edges: GraphEdge[]; evidence: AnalysisEvidence[] } {
  const modulesByPath = new Map<string, GraphNode>();
  const modulesByName = new Map<string, GraphNode[]>();
  const symbolsByName = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.kind === 'python_module') {
      modulesByPath.set(String(node.properties.path), node);
      addCandidate(modulesByName, String(node.properties.module), node);
    }
    if (node.kind === 'python_class' || node.kind === 'python_function' || node.kind === 'python_async_function') addCandidate(symbolsByName, `${String(node.properties.module)}.${String(node.properties.qualifiedName)}`, node);
  }
  const unresolved = new Map<string, GraphNode>();
  const unresolvedLocations = new Map<string, PythonImportFact>();
  const edges: GraphEdge[] = [];
  const evidence: AnalysisEvidence[] = [];
  const edgesById = new Map<string, GraphEdge>();
  for (const imported of imports) {
    const source = modulesByPath.get(imported.file);
    if (!source) continue;
    const moduleName = absoluteImportName(imported);
    const symbolName = imported.imported ? `${moduleName}.${imported.imported}` : undefined;
    const candidates = symbolName ? (symbolsByName.get(symbolName) ?? modulesByName.get(symbolName) ?? []) : (modulesByName.get(moduleName) ?? []);
    const target = candidates.length === 1 ? candidates[0] : undefined;
    const ambiguous = candidates.length > 1;
    const targetName = symbolName ?? moduleName;
    let destination = target;
    if (!destination) {
      const candidatePaths = candidates.map((candidate) => String(candidate.properties.path)).sort();
      const key = `${moduleName}:${imported.imported ?? ''}:${candidatePaths.join(',')}`;
      destination = unresolved.get(key);
      if (!destination) {
        const uri = `python://external/${key}`;
        destination = { id: identity.node(workspace.id, uri, ambiguous ? 'python_ambiguous_import' : 'python_unresolved_import'), workspaceId: workspace.id, kind: ambiguous ? 'python_ambiguous_import' : 'python_unresolved_import', label: targetName, properties: { module: moduleName, importedName: imported.imported ?? null, resolved: false, ambiguous, candidatePaths } };
        unresolved.set(key, destination);
        unresolvedLocations.set(key, imported);
      }
    }
    const edgeId = identity.edge(workspace.id, source.id, destination.id, 'imports');
    let edge = edgesById.get(edgeId);
    const binding = { module: moduleName, importedName: imported.imported ?? null, alias: imported.alias ?? null, relativeLevel: imported.relativeLevel, resolved: !!target, ambiguous, sourcePath: imported.file, line: imported.line, column: imported.column, endLine: imported.endLine, endColumn: imported.endColumn };
    if (!edge) {
      edge = { id: edgeId, workspaceId: workspace.id, sourceId: source.id, targetId: destination.id, kind: 'imports', properties: { ...binding, bindings: [binding] } };
      edgesById.set(edgeId, edge);
      edges.push(edge);
    } else (edge.properties.bindings as unknown[]).push(binding);
    evidence.push(importEvidence('edge', edgeId, imported, 'python.import'));
  }
  const nodesAdded = [...unresolved.values()];
  for (const [key, node] of unresolved) evidence.push(importEvidence('node', node.id, unresolvedLocations.get(key)!, 'python.unresolved_import'));
  return { nodes: nodesAdded, edges, evidence };
}

function absoluteImportName(value: PythonImportFact) {
  if (value.relativeLevel === 0) return value.module;
  const current = moduleForPath(value.file).split('.');
  const packageParts = value.file.endsWith('/__init__.py') || value.file.endsWith('/__init__.pyi') ? current : current.slice(0, -1);
  const base = packageParts.slice(0, Math.max(0, packageParts.length - value.relativeLevel + 1));
  return [...base, value.module].filter(Boolean).join('.');
}
function moduleForPath(path: string) { return path.replace(/\.pyi?$/, '').split('/').filter((part) => part !== '__init__').join('.') || '__init__'; }
function addCandidate(map: Map<string, GraphNode[]>, key: string, candidate: GraphNode) { const list = map.get(key) ?? []; list.push(candidate); map.set(key, list); }
function importEvidence(subjectKind: 'node' | 'edge', subjectId: string, fact: PythonImportFact, type: string): AnalysisEvidence { return { id: identity.node(subjectId, `evidence:${subjectKind}`, `${type}:${fact.file}:${fact.occurrence ?? 0}`), subjectKind, subjectId, level: 'DIRECT', type, uri: fact.file, line: fact.line, column: fact.column, endLine: fact.endLine, endColumn: fact.endColumn, startOffset: fact.startOffset, endOffset: fact.endOffset }; }
