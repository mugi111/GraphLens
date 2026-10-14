import { GraphIdentityFactory } from '../../core/graph-identity.js';
import type { AnalysisEvidence } from '../../domain/analyzer.js';
import type { GraphEdge, GraphNode, Workspace } from '../../domain/graph.js';
import type { PythonImportFact } from './python-source-types.js';

const identity = new GraphIdentityFactory();

/** Resolves only against files in this scan. Everything else stays visibly unresolved. */
export function resolvePythonImports(workspace: Workspace, imports: PythonImportFact[], nodes: GraphNode[]): { nodes: GraphNode[]; edges: GraphEdge[]; evidence: AnalysisEvidence[] } {
  const modules = new Map<string, GraphNode>();
  const symbols = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.kind === 'python_module') modules.set(String(node.properties.module), node);
    if (node.kind === 'python_class' || node.kind === 'python_function' || node.kind === 'python_async_function') symbols.set(`${String(node.properties.module)}.${String(node.properties.qualifiedName)}`, node);
  }
  const unresolved = new Map<string, GraphNode>();
  const unresolvedLocations = new Map<string, PythonImportFact>();
  const edges: GraphEdge[] = [];
  const evidence: AnalysisEvidence[] = [];
  const seenEdges = new Set<string>();
  for (const imported of imports) {
    const source = modules.get(moduleForPath(imported.file));
    if (!source) continue;
    const moduleName = absoluteImportName(imported);
    const symbolName = imported.imported ? `${moduleName}.${imported.imported}` : undefined;
    const target = symbolName ? (symbols.get(symbolName) ?? modules.get(symbolName)) : modules.get(moduleName);
    const targetName = target ? (symbolName && target !== modules.get(moduleName) ? symbolName : moduleName) : (symbolName ?? moduleName);
    let destination = target;
    if (!destination) {
      const key = `${moduleName}:${imported.imported ?? ''}`;
      destination = unresolved.get(key);
      if (!destination) {
        const uri = `python://external/${key}`;
        destination = { id: identity.node(workspace.id, uri, 'python_unresolved_import'), workspaceId: workspace.id, kind: 'python_unresolved_import', label: targetName, properties: { module: moduleName, importedName: imported.imported ?? null, resolved: false } };
        unresolved.set(key, destination);
        unresolvedLocations.set(key, imported);
      }
    }
    const edgeId = identity.edge(workspace.id, source.id, destination.id, 'imports');
    if (seenEdges.has(edgeId)) continue;
    seenEdges.add(edgeId);
    edges.push({ id: edgeId, workspaceId: workspace.id, sourceId: source.id, targetId: destination.id, kind: 'imports', properties: { module: moduleName, importedName: imported.imported ?? null, alias: imported.alias ?? null, relativeLevel: imported.relativeLevel, resolved: !!target, sourcePath: imported.file } });
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
function importEvidence(subjectKind: 'node' | 'edge', subjectId: string, fact: PythonImportFact, type: string): AnalysisEvidence { return { id: identity.node(subjectId, `evidence:${subjectKind}`, `${type}:${fact.startOffset}:${fact.endOffset}`), subjectKind, subjectId, level: 'DIRECT', type, uri: fact.file, line: fact.line, column: fact.column, endLine: fact.endLine, endColumn: fact.endColumn, startOffset: fact.startOffset, endOffset: fact.endOffset }; }
