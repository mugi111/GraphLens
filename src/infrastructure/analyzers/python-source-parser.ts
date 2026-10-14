import { parser } from '@lezer/python';
import { GraphIdentityFactory } from '../../core/graph-identity.js';
import type { GraphEdge, GraphNode, Workspace } from '../../domain/graph.js';
import type { AnalysisEvidence } from '../../domain/analyzer.js';
import type { PythonImportFact, PythonSourceFile } from './python-source-types.js';

export type ParsedPythonFile = { nodes: GraphNode[]; edges: GraphEdge[]; evidence: AnalysisEvidence[]; imports: PythonImportFact[]; diagnostics: Array<{ code: string; severity: 'warning'; message: string; uri: string; line: number; detail: Record<string, unknown> }> };
type Range = { from: number; to: number };
const identity = new GraphIdentityFactory();

/** Parser adapter: grammar-specific node names stay behind this boundary. */
export function parsePythonSourceFile(workspace: Workspace, file: PythonSourceFile): ParsedPythonFile {
  const tree = parser.parse(file.source);
  const offsets = lineOffsets(file.source);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const evidence: AnalysisEvidence[] = [];
  const imports: PythonImportFact[] = [];
  const diagnostics: ParsedPythonFile['diagnostics'] = [];
  const addNode = (uri: string, kind: string, label: string, range: Range, properties: Record<string, unknown> = {}) => {
    const id = identity.node(workspace.id, `python://${file.path}#${uri}`, kind);
    const node = { id, workspaceId: workspace.id, kind, label, properties: { path: file.path, ...properties } };
    nodes.push(node);
    evidence.push(sourceEvidence('node', id, file.path, 'python.source', range, offsets));
    return node;
  };
  const addEdge = (source: GraphNode, target: GraphNode, kind: string, range: Range, properties: Record<string, unknown> = {}) => {
    const id = identity.edge(workspace.id, source.id, target.id, kind);
    edges.push({ id, workspaceId: workspace.id, sourceId: source.id, targetId: target.id, kind, properties: { path: file.path, ...properties } });
    evidence.push(sourceEvidence('edge', id, file.path, 'python.source', range, offsets));
  };
  const fileNode = addNode(file.path, 'python_file', file.path, { from: 0, to: 0 }, { sha256: file.hash, bytes: file.bytes.length });
  const moduleName = moduleNameFor(file.path);
  const moduleNode = addNode(`${file.path}#module`, 'python_module', moduleName, { from: 0, to: 0 }, { module: moduleName });
  addEdge(fileNode, moduleNode, 'contains', { from: 0, to: 0 });

  function visit(node: any, scope: string[], parent: GraphNode) {
    if (node.name === '⚠') {
      const location = point(node.from, offsets);
      diagnostics.push({ code: 'PYTHON_SYNTAX_RECOVERED', severity: 'warning', message: 'Python syntax error; facts outside the recovered region were retained.', uri: file.path, line: location.line, detail: { startOffset: node.from, endOffset: node.to } });
      return;
    }
    if (node.name === 'ClassDefinition' || node.name === 'FunctionDefinition') {
      const nameNode = directChild(node, 'VariableName');
      if (!nameNode) return;
      const name = file.source.slice(nameNode.from, nameNode.to);
      const async = node.name === 'FunctionDefinition' && childNamed(node, 'async');
      const qualified = [...scope, name];
      const kind = node.name === 'ClassDefinition' ? 'python_class' : async ? 'python_async_function' : 'python_function';
      const declared = addNode(`${file.path}#${qualified.join('.')}`, kind, name, { from: node.from, to: node.to }, { module: moduleName, qualifiedName: qualified.join('.'), async });
      addEdge(parent, declared, 'contains', { from: node.from, to: node.to });
      for (const child of children(node)) visit(child, qualified, declared);
      return;
    }
    if (node.name === 'ImportStatement') {
      parseImport(node, file, offsets, imports);
      return;
    }
    for (const child of children(node)) visit(child, scope, parent);
  }
  for (const child of children(tree.topNode)) visit(child, [], moduleNode);
  return { nodes, edges, evidence, imports, diagnostics };
}

function parseImport(node: any, file: PythonSourceFile, offsets: number[], out: PythonImportFact[]) {
  const tokens = children(node);
  const names = tokens.filter((child) => child.name === 'VariableName');
  const points = range(node.from, node.to, offsets);
  if (tokens.some((child) => child.name === 'from')) {
    const importIndex = tokens.findIndex((child) => child.name === 'import');
    const moduleTokens = tokens.slice(0, importIndex).filter((child) => child.name === 'VariableName');
    const relativeLevel = tokens.slice(0, importIndex).filter((child) => child.name === '.').length;
    const module = moduleTokens.map((child) => file.source.slice(child.from, child.to)).join('.');
    for (let i = importIndex + 1; i < tokens.length; i++) if (tokens[i].name === 'VariableName') {
      const imported = file.source.slice(tokens[i].from, tokens[i].to);
      const alias = tokens[i + 1]?.name === 'as' && tokens[i + 2]?.name === 'VariableName' ? file.source.slice(tokens[i + 2].from, tokens[i + 2].to) : undefined;
      out.push({ file: file.path, module, imported, alias, relativeLevel, ...points });
    }
  } else {
    for (let i = 0; i < names.length; i++) {
      const imported = file.source.slice(names[i].from, names[i].to);
      const alias = tokens[tokens.indexOf(names[i]) + 1]?.name === 'as' && tokens[tokens.indexOf(names[i]) + 2]?.name === 'VariableName' ? file.source.slice(tokens[tokens.indexOf(names[i]) + 2].from, tokens[tokens.indexOf(names[i]) + 2].to) : undefined;
      out.push({ file: file.path, module: imported, alias, relativeLevel: 0, ...points });
      if (alias) i++;
    }
  }
}

export function sourceEvidence(subjectKind: 'node' | 'edge', subjectId: string, uri: string, type: string, bounds: Range, lineStarts: number[]): AnalysisEvidence {
  const start = point(bounds.from, lineStarts); const end = point(bounds.to, lineStarts);
  return { id: identity.node(subjectId, `evidence:${subjectKind}`, `${type}:${bounds.from}:${bounds.to}`), subjectKind, subjectId, level: 'DIRECT', type, uri, line: start.line, column: start.column, endLine: end.line, endColumn: end.column, startOffset: bounds.from, endOffset: bounds.to };
}

function directChild(node: any, name: string) { return children(node).find((child) => child.name === name); }
function childNamed(node: any, name: string) { return children(node).some((child) => child.name === name); }
function children(node: any) { const result = []; for (let child = node.firstChild; child; child = child.nextSibling) result.push(child); return result; }
function lineOffsets(source: string) { const result = [0]; for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) result.push(i + 1); return result; }
function point(offset: number, offsets: number[]) { let low = 0; let high = offsets.length; while (low < high) { const mid = (low + high) >>> 1; if (offsets[mid] <= offset) low = mid + 1; else high = mid; } const index = Math.max(0, low - 1); return { line: index + 1, column: offset - offsets[index] + 1 }; }
function range(from: number, to: number, offsets: number[]) { const start = point(from, offsets); const end = point(to, offsets); return { line: start.line, column: start.column, endLine: end.line, endColumn: end.column, startOffset: from, endOffset: to }; }
function moduleNameFor(path: string) { return path.replace(/\.pyi?$/, '').split('/').filter((part) => part !== '__init__').join('.') || '__init__'; }
