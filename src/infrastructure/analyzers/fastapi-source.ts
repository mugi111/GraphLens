import type { AnalysisContext, AnalysisEvidence, JsonValue } from '../../domain/analyzer.js';
import type { GraphNode } from '../../domain/graph.js';
import { collectPythonSourceSnapshot, type PythonSourceSnapshot } from './python-source-snapshot.js';
import { parsePythonSourceFile } from './python-source-parser.js';
import { expressionName } from './sqlalchemy-source-collector.js';
import type { PythonCallFact, PythonDecoratorFact, PythonExpressionFact, PythonImportFact } from './python-source-types.js';

export type FastApiConfig = {
  apiNamespace: string;
  maxRouterDepth: number;
  maxDependencyDepth: number;
  maxResolvedFunctionsPerRoute: number;
};
export type FastApiBinding = { scope: string; offset: number; local: string; canonical?: string; imported?: PythonImportFact; sourceNodeId?: string; shadow?: boolean };
export type FastApiFile = {
  path: string;
  module: string;
  source: string;
  nodes: GraphNode[];
  classes: GraphNode[];
  functions: GraphNode[];
  assignments: GraphNode[];
  moduleNode: GraphNode;
  bindings: FastApiBinding[];
  evidenceBySubject: Map<string, AnalysisEvidence>;
};

const FASTAPI_CONFIG_KEYS = new Set(['apiNamespace', 'maxRouterDepth', 'maxDependencyDepth', 'maxResolvedFunctionsPerRoute', 'includeStubs', 'excludes', 'maxFiles', 'maxFileBytes', 'maxTotalBytes']);
export function fastApiConfig(input: Record<string, unknown>): FastApiConfig {
  for (const key of Object.keys(input)) if (!FASTAPI_CONFIG_KEYS.has(key)) throw new Error(`Unsupported FastAPI option '${key}'.`);
  const apiNamespace = input.apiNamespace ?? 'default';
  if (typeof apiNamespace !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(apiNamespace)) throw new Error('apiNamespace must be 1 to 128 letters, digits, dots, underscores, or hyphens.');
  return {
    apiNamespace,
    maxRouterDepth: bounded(input.maxRouterDepth, 8, 1, 16, 'maxRouterDepth'),
    maxDependencyDepth: bounded(input.maxDependencyDepth, 8, 1, 16, 'maxDependencyDepth'),
    maxResolvedFunctionsPerRoute: bounded(input.maxResolvedFunctionsPerRoute, 500, 1, 2000, 'maxResolvedFunctionsPerRoute'),
  };
}
function bounded(value: unknown, fallback: number, min: number, max: number, name: string) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return Number(value);
}

export async function collectFastApiSource(context: AnalysisContext): Promise<PythonSourceSnapshot> {
  const { apiNamespace: _apiNamespace, maxRouterDepth: _routerDepth, maxDependencyDepth: _dependencyDepth, maxResolvedFunctionsPerRoute: _functions, ...scanConfig } = context.config;
  return collectPythonSourceSnapshot({ ...context, config: scanConfig });
}

export function collectFastApiFiles(snapshot: PythonSourceSnapshot, workspace: AnalysisContext['workspace']): FastApiFile[] {
  return snapshot.parsedFiles.map(({ file }) => {
    // Defaults are parsed only for this analyzer; arbitrary defaults are never added to the Python source index.
    const parsed = parsePythonSourceFile(workspace, file, { includeParameterDefaults: true });
    const nodes = parsed.nodes;
    const classes = nodes.filter((node) => node.kind === 'python_class');
    const functions = nodes.filter((node) => node.kind === 'python_function' || node.kind === 'python_async_function');
    const assignments = nodes.filter((node) => node.kind === 'python_assignment');
    const moduleNode = nodes.find((node) => node.kind === 'python_module')!;
    const evidenceBySubject = new Map<string, AnalysisEvidence>();
    for (const evidence of parsed.evidence) if (evidence.subjectKind === 'node') evidenceBySubject.set(evidence.subjectId, evidence);
    const owners = new Map(nodes.map((node) => [node.id, node]));
    const bindings: FastApiBinding[] = [];
    for (const imported of parsed.imports) {
      const owner = owners.get(imported.ownerId);
      const scope = isScopeNode(owner) ? String(owner.properties.qualifiedName ?? '') : '';
      const local = imported.imported ? imported.alias ?? imported.imported : imported.alias ?? imported.module.split('.')[0]!;
      const canonical = imported.imported ? `${absoluteModule(file.path, imported)}.${imported.imported}` : imported.alias ? absoluteModule(file.path, imported) : absoluteModule(file.path, imported).split('.')[0]!;
      bindings.push({ scope, offset: imported.startOffset, local, canonical, imported });
    }
    for (const assignment of assignments) {
      const target = expressionName(assignment.properties.target);
      if (target && !target.includes('.')) bindings.push({ scope: String(assignment.properties.scope ?? ''), offset: evidenceBySubject.get(assignment.id)?.endOffset ?? 0, local: target, sourceNodeId: assignment.id });
    }
    for (const declaration of [...classes, ...functions]) {
      const qualifiedName = String(declaration.properties.qualifiedName ?? '');
      const parts = qualifiedName.split('.');
      const local = parts.pop();
      if (local) bindings.push({ scope: parts.join('.'), offset: evidenceBySubject.get(declaration.id)?.endOffset ?? 0, local, sourceNodeId: declaration.id });
    }
    for (const fn of functions) {
      const scope = String(fn.properties.qualifiedName ?? '');
      const offset = evidenceBySubject.get(fn.id)?.startOffset ?? 0;
      const parameters = Array.isArray(fn.properties.parameters) ? fn.properties.parameters as Array<{ name?: string }> : [];
      for (const parameter of parameters) if (parameter.name) bindings.push({ scope, offset, local: parameter.name, sourceNodeId: fn.id, shadow: true });
    }
    bindings.sort((a, b) => a.offset - b.offset || lexical(a.scope, b.scope));
    return { path: file.path, module: moduleNameFor(file.path), source: file.source, nodes, classes, functions, assignments, moduleNode, bindings, evidenceBySubject };
  });
}

export function importsFor(file: FastApiFile, scope: string, offset = Number.MAX_SAFE_INTEGER) {
  const scopes = [''];
  if (scope) scopes.push(...scope.split('.').map((_, index, parts) => parts.slice(0, index + 1).join('.')));
  const imports = new Map<string, string>();
  for (const current of scopes) {
    const latest = new Map<string, FastApiBinding>();
    for (const binding of file.bindings) if (binding.scope === current && binding.offset <= offset) latest.set(binding.local, binding);
    for (const [name, binding] of latest) if (binding.canonical) imports.set(name, binding.canonical); else imports.delete(name);
  }
  return imports;
}

export function canonicalFastApiName(name: string, file: FastApiFile, scope = '', offset = Number.MAX_SAFE_INTEGER) {
  const [head, ...tail] = name.split('.');
  const canonical = importsFor(file, scope, offset).get(head!);
  if (canonical) return [canonical, ...tail].join('.');
  return head === 'fastapi' ? `__unbound__.${name}` : name;
}

export function resolveFastApiSymbol(files: FastApiFile[], file: FastApiFile, name: string, scope = '', offset = Number.MAX_SAFE_INTEGER): string | undefined {
  const head = name.split('.')[0]!;
  const scopes = scope ? scope.split('.').map((_, index, parts) => parts.slice(0, index + 1).join('.')).reverse() : [];
  scopes.push('');
  for (const current of scopes) {
    const event = file.bindings.filter((binding) => binding.scope === current && binding.local === head && binding.offset <= offset).sort((a, b) => b.offset - a.offset)[0];
    if (!event) continue;
    if (event.shadow) return undefined;
    if (event.imported) {
      const imported = event.imported;
      if (imported.imported) return `${absoluteModule(file.path, imported)}.${imported.imported}${name.includes('.') ? `.${name.split('.').slice(1).join('.')}` : ''}`;
      const suffix = imported.alias ? name.split('.').slice(1).join('.') : name.split('.').slice(imported.module.split('.').length).join('.');
      const module = imported.alias ? absoluteModule(file.path, imported) : absoluteModule(file.path, imported).split('.')[0]!;
      return `${module}${suffix ? `.${suffix}` : ''}`;
    }
    const local = `${file.module}.${head}${name.includes('.') ? `.${name.split('.').slice(1).join('.')}` : ''}`;
    return existsSymbol(files, local) ? local : undefined;
  }
  const sameModule = `${file.module}.${name}`;
  return existsSymbol(files, sameModule) ? sameModule : undefined;
}

export function callsOf(node: GraphNode): PythonCallFact[] {
  return Array.isArray(node.properties.calls) ? node.properties.calls.filter((call): call is PythonCallFact => !!call && typeof call.callee === 'string' && Array.isArray(call.arguments)) : [];
}
export function decoratorsOf(node: GraphNode): PythonDecoratorFact[] {
  return Array.isArray(node.properties.decorators) ? node.properties.decorators.filter((item): item is PythonDecoratorFact => !!item && typeof item.name === 'string' && Array.isArray(item.arguments)) : [];
}
export function argsOf(expression: PythonExpressionFact | undefined) { return expression?.arguments ?? []; }
export function expressionString(expression: PythonExpressionFact | undefined): string | undefined { return expression?.literalKind === 'string' && typeof expression.value === 'string' ? expression.value : undefined; }
export function literalList(expression: PythonExpressionFact | undefined): PythonExpressionFact[] | undefined {
  if (!expression) return undefined;
  if (expression.kind !== 'ArrayExpression' && expression.kind !== 'ListExpression' && expression.kind !== 'TupleExpression') return undefined;
  return expression.children ?? [];
}
export function expressionValue(expression: PythonExpressionFact | undefined): JsonValue | undefined {
  if (!expression || expression.kind === 'unknown') return undefined;
  if (expression.literalKind === 'string' || expression.literalKind === 'number' || expression.literalKind === 'boolean' || expression.literalKind === 'none') return expression.value as JsonValue;
  const values = literalList(expression);
  if (values) {
    const converted = values.map(expressionValue);
    return converted.every((value) => value !== undefined) ? converted as JsonValue[] : undefined;
  }
  return undefined;
}
export function keywordArgs(args: PythonCallFact['arguments'] | PythonExpressionFact['arguments']) {
  return new Map((args ?? []).filter((item) => item.kind === 'keyword' && item.keyword).map((item) => [item.keyword!, item.expression]));
}
export function expressionCall(expression: PythonExpressionFact | undefined, canonicalName: (name: string) => string) {
  return expression?.kind === 'call' && canonicalName(expression.name ?? '') ? expression : undefined;
}
export function moduleNameFor(path: string) { return path.replace(/\.pyi?$/, '').split('/').filter((part) => part !== '__init__').join('.') || '__init__'; }
function absoluteModule(path: string, binding: PythonImportFact) {
  if (!binding.relativeLevel) return binding.module;
  const current = moduleNameFor(path).split('.');
  const packageParts = path.endsWith('/__init__.py') || path.endsWith('/__init__.pyi') ? current : current.slice(0, -1);
  return [...packageParts.slice(0, Math.max(0, packageParts.length - binding.relativeLevel + 1)), binding.module].filter(Boolean).join('.');
}
function existsSymbol(files: FastApiFile[], key: string) { return files.some((candidate) => candidate.assignments.some((node) => node.properties.scope === '' && expressionName(node.properties.target) === key.slice(candidate.module.length + 1)) || candidate.classes.some((node) => `${candidate.module}.${String(node.properties.qualifiedName)}` === key) || candidate.functions.some((node) => `${candidate.module}.${String(node.properties.qualifiedName)}` === key)); }
function isScopeNode(node: GraphNode | undefined): node is GraphNode { return node?.kind === 'python_class' || node?.kind === 'python_function' || node?.kind === 'python_async_function'; }
function lexical(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
