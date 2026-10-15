import { parser } from '@lezer/python';
import { GraphIdentityFactory } from '../../core/graph-identity.js';
import type { GraphEdge, GraphNode, Workspace } from '../../domain/graph.js';
import type { AnalysisEvidence, JsonValue } from '../../domain/analyzer.js';
import type { PythonImportFact, PythonSourceFile } from './python-source-types.js';
import type { PythonCallFact, PythonDecoratorFact, PythonExpressionFact, PythonParameterFact } from './python-source-types.js';

export type ParsedPythonFile = { nodes: GraphNode[]; edges: GraphEdge[]; evidence: AnalysisEvidence[]; imports: PythonImportFact[]; diagnostics: Array<{ code: string; severity: 'warning'; message: string; uri: string; line: number; detail: Record<string, JsonValue> }> };
type Range = { from: number; to: number };
const identity = new GraphIdentityFactory();

/** Parser adapter: grammar-specific node names stay behind this boundary. */
export function parsePythonSourceFile(workspace: Workspace, file: PythonSourceFile): ParsedPythonFile {
  const tree = parser.parse(file.source);
  const offsets = lineOffsets(file.source);
  const errorRegions = collectErrorRegions(tree.topNode);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const evidence: AnalysisEvidence[] = [];
  const nodesById = new Map<string, GraphNode>();
  const edgesById = new Set<string>();
  const declarationOccurrences = new Map<string, number>();
  const assignmentOccurrences = new Map<string, number>();
  const imports: PythonImportFact[] = [];
  const diagnostics: ParsedPythonFile['diagnostics'] = errorRegions.map((region) => {
    const location = point(region.from, offsets);
    return { code: 'PYTHON_SYNTAX_RECOVERED', severity: 'warning', message: 'Python syntax error; facts intersecting the damaged syntax were omitted.', uri: file.path, line: location.line, detail: { startOffset: region.from, endOffset: region.to } };
  });
  const addNode = (uri: string, kind: string, label: string, range: Range, properties: Record<string, unknown> = {}) => {
    const id = identity.node(workspace.id, `python://${file.path}#${uri}`, kind);
    const existing = nodesById.get(id);
    if (existing) return existing;
    if (nodes.length + edges.length >= 9000) throw new Error('Python source contributions exceed the combined limit (9000).');
    const node = { id, workspaceId: workspace.id, kind, label, properties: { path: file.path, ...properties } };
    nodesById.set(id, node);
    nodes.push(node);
    evidence.push(sourceEvidence('node', id, file.path, 'python.source', range, offsets));
    return node;
  };
  const addEdge = (source: GraphNode, target: GraphNode, kind: string, range: Range, properties: Record<string, unknown> = {}) => {
    const id = identity.edge(workspace.id, source.id, target.id, kind);
    if (edgesById.has(id)) return;
    if (nodes.length + edges.length >= 9000) throw new Error('Python source contributions exceed the combined limit (9000).');
    edgesById.add(id);
    edges.push({ id, workspaceId: workspace.id, sourceId: source.id, targetId: target.id, kind, properties: { path: file.path, ...properties } });
    evidence.push(sourceEvidence('edge', id, file.path, 'python.source', range, offsets));
  };
  const fileNode = addNode(file.path, 'python_file', file.path, { from: 0, to: 0 }, { sha256: file.hash, bytes: file.bytes.length });
  const moduleName = moduleNameFor(file.path);
  const moduleNode = addNode(`${file.path}#module`, 'python_module', moduleName, { from: 0, to: 0 }, { module: moduleName });
  addEdge(fileNode, moduleNode, 'contains', { from: 0, to: 0 });

  function visit(node: any, scope: string[], parent: GraphNode, decorators: PythonDecoratorFact[] = []) {
    if (node.name === '⚠') return;
    if (node.name === 'DecoratedStatement') {
      const facts = children(node).filter((child) => child.name === 'Decorator' && !intersectsDamage({ from: child.from, to: child.to }, errorRegions)).map((child) => decoratorFact(child, file.source)).filter((fact): fact is PythonDecoratorFact => !!fact);
      for (const child of children(node)) if (child.name !== 'Decorator') visit(child, scope, parent, facts);
      return;
    }
    if (node.name === 'ClassDefinition' || node.name === 'FunctionDefinition') {
      const nameNode = directChild(node, 'VariableName');
      if (!nameNode) return;
      const body = directChild(node, 'Body');
      const header = { from: node.from, to: body?.from ?? node.to };
      if (intersectsDamage(header, errorRegions)) return;
      const name = file.source.slice(nameNode.from, nameNode.to);
      const async = node.name === 'FunctionDefinition' && childNamed(node, 'async');
      const qualified = [...scope, name];
      const kind = node.name === 'ClassDefinition' ? 'python_class' : async ? 'python_async_function' : 'python_function';
      const qualifiedName = qualified.join('.');
      const occurrenceKey = `${kind}:${qualifiedName}`;
      const declarationOrdinal = declarationOccurrences.get(occurrenceKey) ?? 0;
      declarationOccurrences.set(occurrenceKey, declarationOrdinal + 1);
      const stableName = declarationOrdinal === 0 ? qualifiedName : `${qualifiedName}#${declarationOrdinal}`;
      const args = node.name === 'ClassDefinition' ? directChild(node, 'ArgList') : undefined;
      const bases = node.name === 'ClassDefinition' && args ? callArguments(args, file.source).filter((arg) => arg.kind === 'positional').map((arg) => arg.expression) : [];
      const classKeywords = node.name === 'ClassDefinition' && args ? callArguments(args, file.source).filter((arg) => arg.kind === 'keyword').map((arg) => ({ name: arg.keyword, value: arg.expression })) : [];
      const parameters = node.name === 'FunctionDefinition' ? functionParameters(directChild(node, 'ParamList'), file.source) : [];
      const returnTypeNode = node.name === 'FunctionDefinition' ? children(node).find((child) => child.name === 'TypeDef' && file.source.slice(child.from, child.to).startsWith('->')) : undefined;
      const declarationFacts = structuredFacts(node, file.source, offsets);
      const declared = addNode(`${file.path}#${stableName}`, kind, name, { from: node.from, to: node.to }, { module: moduleName, qualifiedName, declarationOrdinal, async, decorators, bases, classKeywords, parameters, ...(returnTypeNode ? { returnAnnotation: annotationFact(returnTypeNode, file.source) } : {}), references: declarationFacts.references, calls: declarationFacts.calls });
      addEdge(parent, declared, 'contains', { from: node.from, to: node.to });
      for (const child of children(node)) visit(child, qualified, declared);
      return;
    }
    if (node.name === 'AssignStatement' || node.name === 'AugmentedAssignStatement') {
      const assignments = intersectsDamage({ from: node.from, to: node.to }, errorRegions) ? [] : assignmentFacts(node, file.source, offsets);
      for (const assignment of assignments) {
        const target = expressionName(assignment.target) ?? `${assignment.target.kind}:${JSON.stringify(assignment.target)}`;
        const occurrenceKey = `${scope.join('.')}:${target}`;
        const ordinal = assignmentOccurrences.get(occurrenceKey) ?? 0;
        assignmentOccurrences.set(occurrenceKey, ordinal + 1);
        const qualified = [...scope, `assignment:${target}`].join('.');
        const stableName = ordinal === 0 ? qualified : `${qualified}#${ordinal}`;
        const declared = addNode(`${file.path}#${stableName}`, 'python_assignment', target, { from: node.from, to: node.to }, { module: moduleName, scope: scope.join('.'), target: assignment.target, annotation: assignment.annotation ?? null, value: assignment.value ?? null, references: assignment.references, calls: assignment.calls, assignmentOrdinal: ordinal });
        addEdge(parent, declared, 'contains', { from: node.from, to: node.to });
      }
    }
    if (node.name === 'ImportStatement') {
      if (!intersectsDamage({ from: node.from, to: node.to }, errorRegions)) parseImport(node, parent.id, file, offsets, imports);
      if (imports.length > 10_000) throw new Error('Python source import facts exceed the result limit (10000).');
      return;
    }
    for (const child of children(node)) visit(child, scope, parent);
  }
  for (const child of children(tree.topNode)) visit(child, [], moduleNode);
  return { nodes, edges, evidence, imports: assignImportOccurrences(imports), diagnostics };
}

function parseImport(node: any, ownerId: string, file: PythonSourceFile, offsets: number[], out: PythonImportFact[]) {
  const tokens = children(node);
  const points = range(node.from, node.to, offsets);
  if (tokens.some((child) => child.name === 'from')) {
    const importIndex = tokens.findIndex((child) => child.name === 'import');
    if (importIndex < 0) return;
    const moduleTokens = tokens.slice(0, importIndex).filter((child) => child.name === 'VariableName');
    const relativeLevel = tokens.slice(0, importIndex).reduce((count, child) => count + (child.name === '.' ? 1 : child.name === 'Ellipsis' ? file.source.slice(child.from, child.to).length : 0), 0);
    const module = moduleTokens.map((child) => file.source.slice(child.from, child.to)).join('.');
    const importedTokens = flattenImportTokens(tokens.slice(importIndex + 1));
    for (const segment of splitImportSegments(importedTokens)) {
      const parsed = importedName(segment, file.source);
      if (parsed) out.push({ file: file.path, ownerId, module, imported: parsed.name, alias: parsed.alias, relativeLevel, ...points });
    }
  } else {
    for (const segment of splitImportSegments(tokens)) {
      const parsed = importedName(segment, file.source);
      if (parsed) out.push({ file: file.path, ownerId, module: parsed.name, alias: parsed.alias, relativeLevel: 0, ...points });
    }
  }
}

function decoratorFact(node: any, source: string): PythonDecoratorFact | undefined {
  const expression = children(node).find(isExpressionNode);
  const name = expression ? expressionName(expressionFact(expression, source)) : undefined;
  if (!name) return undefined;
  const args = directChild(node, 'ArgList');
  const arguments_ = args ? callArguments(args, source).map((arg) => arg.kind === 'keyword' ? ({ kind: 'keyword', name: arg.keyword ?? '', children: [arg.expression] }) : arg.expression) : [];
  return { name, arguments: arguments_ };
}

function callArguments(node: any, source: string): Array<{ kind: 'positional' | 'keyword'; keyword?: string; expression: PythonExpressionFact }> {
  const result = [] as Array<{ kind: 'positional' | 'keyword'; keyword?: string; expression: PythonExpressionFact }>;
  for (const segment of splitChildren(node)) {
    const assign = segment.findIndex((child) => child.name === 'AssignOp');
    const expression = (assign >= 0 ? segment.slice(assign + 1) : segment).find(isExpressionNode);
    if (!expression) continue;
    if (assign >= 0) {
      const keyword = segment.slice(0, assign).find((child) => child.name === 'VariableName');
      result.push({ kind: 'keyword', keyword: keyword ? source.slice(keyword.from, keyword.to) : '', expression: expressionFact(expression, source) });
    } else result.push({ kind: 'positional', expression: expressionFact(expression, source) });
  }
  return result;
}

function functionParameters(node: any, source: string): PythonParameterFact[] {
  if (!node) return [];
  const result: PythonParameterFact[] = [];
  let keywordOnly = false;
  let positionalOnlyMarker = false;
  for (const segment of splitChildren(node)) {
    if (segment.some((child) => child.name === '/')) { positionalOnlyMarker = true; continue; }
    if (segment.some((child) => child.name === '*') && !segment.some((child) => child.name === 'VariableName')) { keywordOnly = true; continue; }
    const nameNode = segment.find((child) => child.name === 'VariableName');
    if (!nameNode) continue;
    const name = source.slice(nameNode.from, nameNode.to);
    const annotation = segment.find((child) => child.name === 'TypeDef');
    const prefix = segment.slice(0, segment.indexOf(nameNode));
    const kind = prefix.some((child) => child.name === '**') ? 'var_keyword' : prefix.some((child) => child.name === '*') ? 'var_positional' : keywordOnly ? 'keyword_only' : 'positional_or_keyword';
    result.push({ name, kind, ...(annotation ? { annotation: annotationFact(annotation, source) } : {}), hasDefault: segment.some((child) => child.name === 'AssignOp') });
    if (positionalOnlyMarker) positionalOnlyMarker = false;
  }
  const slashBefore = splitChildren(node).some((segment) => segment.some((child) => child.name === '/'));
  if (slashBefore) {
    const markerIndex = splitChildren(node).findIndex((segment) => segment.some((child) => child.name === '/'));
    const precedingNames = splitChildren(node).slice(0, markerIndex).flatMap((segment) => segment.find((child) => child.name === 'VariableName') ? [source.slice(segment.find((child) => child.name === 'VariableName').from, segment.find((child) => child.name === 'VariableName').to)] : []);
    for (const parameter of result) if (precedingNames.includes(parameter.name) && parameter.kind === 'positional_or_keyword') parameter.kind = 'positional_only';
  }
  return result;
}

function annotationFact(node: any, source: string): PythonExpressionFact {
  const expression = children(node).find(isExpressionNode);
  return expression ? expressionFact(expression, source) : { kind: 'unknown' };
}

function assignmentFacts(node: any, source: string, offsets: number[]) {
  const children_ = children(node);
  const operators = children_.flatMap((child, index) => child.name === 'AssignOp' || child.name === 'AugAssignOp' ? [index] : []);
  const isAugmented = node.name === 'AugmentedAssignStatement';
  let targetNodes: any[] = [];
  let valueNode: any;
  if (operators.length) {
    const segments: any[][] = [[]];
    for (const child of children_) { if (child.name === 'AssignOp' || child.name === 'AugAssignOp') segments.push([]); else segments[segments.length - 1].push(child); }
    targetNodes = isAugmented ? segments[0].filter(isExpressionNode) : segments.slice(0, -1).flatMap((segment) => segment.filter(isExpressionNode));
    valueNode = [...segments.at(-1)!].reverse().find(isExpressionNode);
  } else {
    targetNodes = children_.filter((child) => child.name === 'VariableName' || child.name === 'MemberExpression' || child.name === 'TupleExpression' || child.name === 'ListExpression');
    valueNode = [...children_].reverse().find(isExpressionNode);
  }
  const annotation = children_.find((child) => child.name === 'TypeDef');
  const value = valueNode ? expressionFact(valueNode, source) : undefined;
  const facts = valueNode ? structuredFacts(valueNode, source, offsets) : { references: [], calls: [] };
  return targetNodes.map((target) => ({ target: expressionFact(target, source), annotation: annotation ? annotationFact(annotation, source) : undefined, value, references: facts.references, calls: facts.calls }));
}

function structuredFacts(root: any, source: string, offsets: number[]) {
  const references = new Map<string, PythonExpressionFact>();
  const calls: PythonCallFact[] = [];
  function walk(node: any, isRoot = false) {
    if (!isRoot && (node.name === 'ClassDefinition' || node.name === 'FunctionDefinition')) return;
    if (node.name === 'CallExpression') calls.push(callFact(node, source, offsets));
    if (node.name === 'MemberExpression' || node.name === 'VariableName') {
      const fact = expressionFact(node, source);
      const key = JSON.stringify(fact);
      references.set(key, fact);
      if (node.name === 'MemberExpression') return;
    }
    for (const child of children(node)) walk(child);
  }
  walk(root, true);
  return { references: [...references.values()], calls };
}

function callFact(node: any, source: string, offsets: number[]): PythonCallFact {
  const parts = children(node);
  const calleeNode = parts.find(isExpressionNode);
  const argsNode = directChild(node, 'ArgList');
  const point_ = point(node.from, offsets);
  return { callee: calleeNode ? expressionName(expressionFact(calleeNode, source)) ?? '' : '', arguments: argsNode ? callArguments(argsNode, source).map((arg) => ({ kind: arg.kind, ...(arg.keyword ? { keyword: arg.keyword } : {}), literalKind: arg.expression.literalKind ?? arg.expression.kind })) : [], line: point_.line, column: point_.column };
}

function expressionFact(node: any, source: string): PythonExpressionFact {
  if (node.name === 'VariableName' || node.name === 'PropertyName') return { kind: 'name', name: source.slice(node.from, node.to) };
  if (node.name === 'MemberExpression') {
    const parts = children(node).filter(isExpressionNode);
    const object = parts[0] ? expressionFact(parts[0], source) : { kind: 'unknown' };
    const property = [...parts].reverse()[0];
    return { kind: 'member', property: property ? expressionName(expressionFact(property, source)) ?? '' : '', children: [object] };
  }
  if (node.name === 'CallExpression') {
    const callee = children(node).find(isExpressionNode);
    return { kind: 'call', name: callee ? expressionName(expressionFact(callee, source)) ?? '' : '' };
  }
  const literalKind = ({ String: 'string', Number: 'number', Boolean: 'boolean', None: 'none' } as Record<string, string>)[node.name];
  const parts = children(node).filter(isExpressionNode);
  return { kind: node.name, ...(literalKind ? { literalKind } : {}), ...(parts.length ? { children: parts.map((part) => expressionFact(part, source)) } : {}) };
}

function expressionName(fact: PythonExpressionFact): string | undefined {
  if (fact.kind === 'name') return fact.name;
  if (fact.kind === 'member') { const base = fact.children?.[0] ? expressionName(fact.children[0]) : undefined; return base && fact.property ? `${base}.${fact.property}` : undefined; }
  if (fact.kind === 'call') return fact.name;
  if (fact.kind === 'TupleExpression' || fact.kind === 'ListExpression') { const parts = fact.children?.map(expressionName); return parts?.every((part): part is string => !!part) ? parts.join(',') : undefined; }
  return undefined;
}

function splitChildren(node: any) { const result: any[][] = [[]]; for (const child of children(node)) { if (child.name === ',') result.push([]); else result[result.length - 1].push(child); } return result; }
function isExpressionNode(node: any) { return !['(', ')', '[', ']', '{', '}', ',', ':', '.', '...', 'AssignOp', 'AugAssignOp', 'as', '*', '**', '/'].includes(node.name) && !['TypeDef'].includes(node.name) && (node.name === 'VariableName' || node.name === 'PropertyName' || /Expression$|Literal$|^(String|Number|Boolean|None|True|False)$/.test(node.name)); }

function flattenImportTokens(tokens: any[]): any[] { return tokens.flatMap((token) => token.name === 'ImportList' ? flattenImportTokens(children(token)) : [token]); }
function splitImportSegments(tokens: any[]) { const result: any[][] = [[]]; for (const token of tokens) { if (token.name === ',') result.push([]); else if (!['(', ')'].includes(token.name)) result[result.length - 1].push(token); } return result; }
function importedName(segment: any[], source: string): { name: string; alias?: string } | undefined {
  const aliasIndex = segment.findIndex((token) => token.name === 'as');
  const nameTokens = segment.slice(0, aliasIndex < 0 ? undefined : aliasIndex).filter((token) => token.name === 'VariableName');
  if (nameTokens.length === 0 && segment.some((token) => token.name === '*')) return { name: '*' };
  if (nameTokens.length === 0) return undefined;
  const name = nameTokens.map((token) => source.slice(token.from, token.to)).join('.');
  const aliasToken = aliasIndex < 0 ? undefined : segment.slice(aliasIndex + 1).find((token) => token.name === 'VariableName');
  return { name, alias: aliasToken ? source.slice(aliasToken.from, aliasToken.to) : undefined };
}

export function sourceEvidence(subjectKind: 'node' | 'edge', subjectId: string, uri: string, type: string, bounds: Range, lineStarts: number[]): AnalysisEvidence {
  const start = point(bounds.from, lineStarts); const end = point(bounds.to, lineStarts);
  return { id: identity.node(subjectId, `evidence:${subjectKind}`, type), subjectKind, subjectId, level: 'DIRECT', type, uri, line: start.line, column: start.column, endLine: end.line, endColumn: end.column, startOffset: bounds.from, endOffset: bounds.to };
}

function assignImportOccurrences(imports: PythonImportFact[]) { const occurrences = new Map<string, number>(); return imports.map((fact) => { const key = `${fact.file}\u0000${fact.ownerId}\u0000${fact.module}\u0000${fact.imported ?? ''}\u0000${fact.alias ?? ''}\u0000${fact.relativeLevel}`; const occurrence = occurrences.get(key) ?? 0; occurrences.set(key, occurrence + 1); return { ...fact, occurrence }; }); }

function directChild(node: any, name: string) { return children(node).find((child) => child.name === name); }
function collectErrorRegions(root: any) { const result: Range[] = []; function walk(node: any) { if (node.name === '⚠') result.push({ from: node.from, to: node.to }); for (const child of children(node)) walk(child); } walk(root); return result; }
function intersectsDamage(range: Range, errors: Range[]) { return errors.some((error) => error.from === error.to ? error.from >= range.from && error.from <= range.to : range.from < error.to && error.from < range.to); }
function childNamed(node: any, name: string) { return children(node).some((child) => child.name === name); }
function children(node: any) { const result = []; for (let child = node.firstChild; child; child = child.nextSibling) result.push(child); return result; }
function lineOffsets(source: string) { const result = [0]; for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) result.push(i + 1); return result; }
function point(offset: number, offsets: number[]) { let low = 0; let high = offsets.length; while (low < high) { const mid = (low + high) >>> 1; if (offsets[mid] <= offset) low = mid + 1; else high = mid; } const index = Math.max(0, low - 1); return { line: index + 1, column: offset - offsets[index] + 1 }; }
function range(from: number, to: number, offsets: number[]) { const start = point(from, offsets); const end = point(to, offsets); return { line: start.line, column: start.column, endLine: end.line, endColumn: end.column, startOffset: from, endOffset: to }; }
function moduleNameFor(path: string) { return path.replace(/\.pyi?$/, '').split('/').filter((part) => part !== '__init__').join('.') || '__init__'; }
