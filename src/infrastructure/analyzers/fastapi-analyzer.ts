import { AnalysisError, type AnalysisContext, type AnalysisDiagnostic, type AnalysisEvidence, type Analyzer, type AnalysisResult, type JsonValue } from '../../domain/analyzer.js';
import type { GraphEdge, GraphNode } from '../../domain/graph.js';
import { apiEndpointUri, apiPathShape } from '../../core/api-identity.js';
import { GraphIdentityFactory } from '../../core/graph-identity.js';
import { PYTHON_SOURCE_LIMITS, type PythonExpressionFact, type PythonParameterFact } from './python-source-types.js';
import { argsOf, callsOf, canonicalFastApiName, collectFastApiFiles, collectFastApiSource, decoratorsOf, expressionString, expressionValue, fastApiConfig, importsFor, keywordArgs, literalList, resolveFastApiSymbol, type FastApiConfig, type FastApiFile } from './fastapi-source.js';
import { expressionName } from './sqlalchemy-source-collector.js';

const identity = new GraphIdentityFactory();
const ROUTE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE']);
const DEPENDENCY_NAMES = new Set(['fastapi.Depends', 'fastapi.Security']);
const PARAMETER_NAMES = new Map([
  ['fastapi.Path', 'path'], ['fastapi.Query', 'query'], ['fastapi.Header', 'header'], ['fastapi.Cookie', 'cookie'],
  ['fastapi.Body', 'body'], ['fastapi.Form', 'form'], ['fastapi.File', 'file'],
]);
const SECURITY_NAMES = new Set([
  'fastapi.security.OAuth2PasswordBearer', 'fastapi.security.OAuth2AuthorizationCodeBearer', 'fastapi.security.APIKeyHeader',
  'fastapi.security.APIKeyQuery', 'fastapi.security.APIKeyCookie', 'fastapi.security.HTTPBearer', 'fastapi.security.HTTPBasic',
  'fastapi.security.OpenIdConnect',
]);

type DependencyFact = { expression: PythonExpressionFact; file: FastApiFile; scope: string; offset: number; source?: AnalysisEvidence };
type ResponseFact = { status: string; description?: string; model?: string };
type RouterObject = { key: string; logicalKey: string; sourceNodeId: string; file: FastApiFile; assignment: GraphNode; kind: 'application' | 'router'; prefix: string; prefixResolved: boolean; tags: string[]; dependencies: DependencyFact[]; responses: ResponseFact[]; node: GraphNode };
type RouteSpec = { key: string; ownerKey: string; file: FastApiFile; handlerFile: FastApiFile; handler: GraphNode; path: string; methods: string[]; operation: Record<string, unknown>; dependencies: DependencyFact[]; source?: AnalysisEvidence; occurrence: number };
type IncludeSpec = { key: string; ownerKey: string; childKey?: string; childSourceNodeId?: string; file: FastApiFile; scope: string; offset: number; prefix: string; prefixResolved: boolean; tags: string[]; dependencies: DependencyFact[]; responses: ResponseFact[]; source?: AnalysisEvidence };
type FastApiCallArgument = { kind: 'positional' | 'keyword'; keyword?: string; expression: PythonExpressionFact };

export const fastApiAnalyzer: Analyzer = {
  descriptor: { id: 'builtin.fastapi', version: '1.0.0', apiVersion: '1', capabilities: ['graph', 'evidence', 'diagnostics'] },
  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    try { return await analyzeFastApi(context); }
    catch (error) {
      if (error instanceof AnalysisError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const code = /apiNamespace|maxRouterDepth|maxDependencyDepth|maxResolvedFunctionsPerRoute|Unsupported FastAPI option|includeStubs|excludes|maxFiles|maxFileBytes|maxTotalBytes/.test(message) ? 'FASTAPI_INVALID_CONFIG' : /exceeds|limit|directory count|inventory/i.test(message) ? 'FASTAPI_LIMIT_EXCEEDED' : /UTF-8/i.test(message) ? 'FASTAPI_INVALID_ENCODING' : 'FASTAPI_ANALYSIS_FAILED';
      throw new AnalysisError('ANALYZER_FAILED', message, [{ code, severity: 'error', message }]);
    }
  },
};

async function analyzeFastApi(context: AnalysisContext): Promise<AnalysisResult> {
  const config = fastApiConfig(context.config);
  const snapshot = await collectFastApiSource(context);
  const files = collectFastApiFiles(snapshot, context.workspace);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const evidence: AnalysisEvidence[] = [];
  const diagnostics: AnalysisDiagnostic[] = [...snapshot.diagnostics];
  const nodesById = new Map<string, GraphNode>();
  const edgesById = new Set<string>();
  const evidenceIds = new Set<string>();
  const diagnosticKeys = new Set<string>();
  const addDiagnostic = (code: string, message: string, source?: AnalysisEvidence) => {
    const key = `${code}\u0000${source?.uri ?? ''}\u0000${source?.line ?? ''}\u0000${message}`;
    if (diagnosticKeys.has(key)) return;
    diagnosticKeys.add(key);
    diagnostics.push({ code, severity: 'warning', message, ...(source?.uri ? { uri: source.uri } : {}), ...(source?.line ? { line: source.line } : {}) });
  };
  const addEvidence = (subjectKind: 'node' | 'edge', subjectId: string, type: string, anchor: string, source?: AnalysisEvidence, level: 'DIRECT' | 'DERIVED' = 'DIRECT') => {
    const id = identity.node(subjectId, `evidence:${subjectKind}`, `${type}:${anchor}`);
    if (evidenceIds.has(id)) return;
    evidenceIds.add(id);
    evidence.push({ id, subjectKind, subjectId, level, type, ...(source?.uri ? { uri: source.uri } : {}), ...(source?.line ? { line: source.line } : {}), ...(source?.column ? { column: source.column } : {}), ...(source?.endLine ? { endLine: source.endLine } : {}), ...(source?.endColumn ? { endColumn: source.endColumn } : {}), ...(source?.startOffset !== undefined ? { startOffset: source.startOffset } : {}), ...(source?.endOffset !== undefined ? { endOffset: source.endOffset } : {}) });
  };
  const addNode = (kind: string, label: string, uri: string, key: string, properties: Record<string, unknown>, source?: AnalysisEvidence, type = `fastapi.${kind}`, level: 'DIRECT' | 'DERIVED' = 'DIRECT') => {
    const id = kind === 'api_endpoint' ? identity.node(context.workspace.id, uri, kind) : identity.node(context.workspace.id, `fastapi://${uri}#${key}`, kind);
    const existing = nodesById.get(id);
    if (existing) { addEvidence('node', id, type, key, source, level); return existing; }
    if (nodes.length + edges.length >= PYTHON_SOURCE_LIMITS.maxContributions) throw new Error('FastAPI graph exceeds the combined result limit (9000).');
    const node: GraphNode = { id, workspaceId: context.workspace.id, kind, label, properties };
    nodesById.set(id, node); nodes.push(node); addEvidence('node', id, type, key, source, level);
    return node;
  };
  const addSourceNode = (file: FastApiFile, source: GraphNode) => {
    if (!nodesById.has(source.id)) {
      const safeProperties: Record<string, unknown> = {};
      for (const key of ['module', 'qualifiedName', 'async', 'declarationOrdinal']) if (source.properties[key] !== undefined) safeProperties[key] = source.properties[key];
      const safeNode: GraphNode = { id: source.id, workspaceId: source.workspaceId, kind: source.kind, label: source.label, properties: safeProperties };
      nodesById.set(safeNode.id, safeNode); nodes.push(safeNode);
    }
    const sourceEvidence = file.evidenceBySubject.get(source.id);
    if (sourceEvidence && !evidenceIds.has(sourceEvidence.id)) { evidenceIds.add(sourceEvidence.id); evidence.push(sourceEvidence); }
    return source;
  };
  const addEdge = (source: GraphNode, target: GraphNode, kind: string, key: string, sourceEvidence?: AnalysisEvidence, properties: Record<string, unknown> = {}, level: 'DIRECT' | 'DERIVED' = 'DIRECT') => {
    const id = identity.edge(context.workspace.id, source.id, target.id, kind);
    if (edgesById.has(id)) return;
    if (nodes.length + edges.length >= PYTHON_SOURCE_LIMITS.maxContributions) throw new Error('FastAPI graph exceeds the combined result limit (9000).');
    edgesById.add(id); edges.push({ id, workspaceId: context.workspace.id, sourceId: source.id, targetId: target.id, kind, properties });
    addEvidence('edge', id, `fastapi.${kind}`, key, sourceEvidence, level);
  };

  const objects = collectRouterObjects(context, files, addNode, addDiagnostic);
  const objectByKey = new Map<string, RouterObject[]>();
  for (const object of objects) objectByKey.set(object.logicalKey, [...(objectByKey.get(object.logicalKey) ?? []), object]);
  const resolveObject = (file: FastApiFile, name: string, scope: string, offset: number, seen = new Set<string>()): RouterObject | undefined => {
    const symbol = resolveFastApiSymbol(files, file, name, scope, offset);
    const head = name.split('.')[0]!;
    const scopes = scope ? scope.split('.').map((_, index, parts) => parts.slice(0, index + 1).join('.')).reverse() : [];
    scopes.push('');
    let binding: FastApiFile['bindings'][number] | undefined;
    let bindingScope = '';
    for (const current of scopes) {
      binding = file.bindings.filter((item) => item.scope === current && item.local === head && item.offset <= offset).sort((a, b) => b.offset - a.offset)[0];
      if (binding) { bindingScope = current; break; }
    }
    if (binding?.shadow) return undefined;
    if (binding?.imported) {
      if (!symbol) return undefined;
      const matches = objectByKey.get(symbol) ?? [];
      if (matches.length > 1) addDiagnostic('FASTAPI_AMBIGUOUS_ROUTER', `Router symbol '${symbol}' has multiple source assignments.`, file.evidenceBySubject.get(binding.sourceNodeId ?? ''));
      return matches.length === 1 ? matches[0] : undefined;
    }
    if (binding?.sourceNodeId) {
      const exact = objects.find((object) => object.file === file && object.sourceNodeId === binding!.sourceNodeId);
      if (exact) return exact;
      const assignment = file.assignments.find((item) => item.id === binding!.sourceNodeId);
      const alias = expressionName(assignment?.properties.value);
      const key = `${bindingScope}.${head}:${binding.offset}`;
      if (!alias || seen.has(key)) return undefined;
      seen.add(key);
      return resolveObject(file, alias, bindingScope, binding.offset - 1, seen);
    }
    const matches = symbol ? objectByKey.get(symbol) ?? [] : [];
    if (matches.length > 1) addDiagnostic('FASTAPI_AMBIGUOUS_ROUTER', `Router symbol '${symbol}' has multiple source assignments.`);
    return matches.length === 1 ? matches[0] : undefined;
  };

  const includes = collectIncludes(files, resolveObject, addDiagnostic);
  const routes = collectRoutes(files, resolveObject, config.apiNamespace, addDiagnostic);
  const routesByOwner = new Map<string, RouteSpec[]>();
  for (const route of routes) routesByOwner.set(route.ownerKey, [...(routesByOwner.get(route.ownerKey) ?? []), route]);
  const includesByOwner = new Map<string, IncludeSpec[]>();
  for (const include of includes) includesByOwner.set(include.ownerKey, [...(includesByOwner.get(include.ownerKey) ?? []), include]);

  const appObjects = objects.filter((object) => object.kind === 'application');
  const roots = appObjects;
  let effectiveRouteCount = 0;
  const expandedRouteKeys = new Set<string>();
  for (const root of roots) {
    const rootTags: string[] = [];
    const rootDeps: DependencyFact[] = [];
    const rootKey = `${root.key}/${root.sourceNodeId}`;
    const walk = (object: RouterObject, mountPrefix: string, inheritedTags: string[], inheritedDeps: DependencyFact[], inheritedResponses: ResponseFact[], depth: number, stack: string[], mountKey: string, parentNode: GraphNode) => {
      if (depth > config.maxRouterDepth) throw fatalLimit('FASTAPI_ROUTER_DEPTH_LIMIT', `Router inclusion exceeded maxRouterDepth (${config.maxRouterDepth}).`, object.file.evidenceBySubject.get(object.assignment.id));
      if (stack.includes(object.key)) { addDiagnostic('FASTAPI_ROUTER_CYCLE', `Router inclusion cycle at '${object.key}' was not expanded.`, object.file.evidenceBySubject.get(object.assignment.id)); return; }
      if (object.kind === 'router' && !object.prefixResolved) { addDiagnostic('FASTAPI_DYNAMIC_ROUTER_PREFIX', `Router '${object.logicalKey}' has an unresolved constructor prefix and was not expanded.`, object.file.evidenceBySubject.get(object.assignment.id)); return; }
      const prefix = `${mountPrefix}${object.kind === 'router' ? object.prefix : ''}`;
      const tags = mergeStrings(inheritedTags, object.tags);
      const dependencies = [...inheritedDeps, ...object.dependencies];
      const responses = mergeResponses(inheritedResponses, object.responses);
      for (const route of routesByOwner.get(object.key) ?? []) {
        const fullPath = `${prefix}${route.path}`;
        if (!fullPath) { addDiagnostic('FASTAPI_EMPTY_EFFECTIVE_PATH', 'An empty route path has no mounted prefix and was not exposed.', route.source); continue; }
        const routeKey = `${route.key}/mount:${mountKey}/path:${fullPath}`;
        if (expandedRouteKeys.has(routeKey)) continue;
        expandedRouteKeys.add(routeKey);
        if (++effectiveRouteCount > 5000) throw fatalLimit('FASTAPI_ROUTE_LIMIT', 'FastAPI effective route count exceeds 5000.');
        const operation = { ...route.operation, responseStatuses: mergeResponses(responses, (route.operation.responseStatuses as ResponseFact[] | undefined) ?? []) };
        projectRoute(context, config.apiNamespace, { ...route, operation }, fullPath, mergeStrings(tags, Array.isArray(route.operation.routeTags) ? route.operation.routeTags as string[] : []), [...dependencies, ...route.dependencies, ...routeDependencies(route)], parentNode, routeKey, addSourceNode, addNode, addEdge, addDiagnostic, files, config);
      }
      const nextStack = [...stack, object.key];
      for (const include of includesByOwner.get(object.key) ?? []) {
        if (!include.childKey) continue;
        const child = objects.find((candidate) => candidate.key === include.childKey && candidate.sourceNodeId === include.childSourceNodeId);
        if (!child) continue;
        if (!include.prefixResolved) { addDiagnostic('FASTAPI_DYNAMIC_ROUTER_PREFIX', 'A router inclusion with a dynamic prefix was not expanded.', include.source); continue; }
        addEdge(object.node, child.node, 'contains', include.key, include.source, { prefix: include.prefix, tags: include.tags });
        walk(child, `${prefix}${include.prefix}`, mergeStrings(tags, include.tags), [...dependencies, ...include.dependencies], mergeResponses(responses, include.responses), depth + 1, nextStack, `${mountKey}/${include.key}`, child.node);
      }
    };
    walk(root, '', rootTags, rootDeps, [], 1, [], rootKey, root.node);
  }

  if (nodes.length + edges.length > 9000) throw new Error('FastAPI graph exceeds the combined result limit (9000).');
  if (evidence.length > 10_000) throw new Error('FastAPI evidence exceeds the result limit (10000).');
  if (diagnostics.length > 10_000) throw new Error('FastAPI diagnostics exceed the result limit (10000).');
  return { sourceRevision: snapshot.sourceRevision, nodes, edges, evidence, diagnostics: dedupeDiagnostics(diagnostics) };
}

function collectRouterObjects(context: AnalysisContext, files: FastApiFile[], addNode: (...args: any[]) => GraphNode, addDiagnostic: (code: string, message: string, source?: AnalysisEvidence) => void): RouterObject[] {
  const objects: RouterObject[] = [];
  for (const file of files) for (const assignment of file.assignments) {
    if (assignment.properties.scope !== '') continue;
    const target = expressionName(assignment.properties.target);
    const value = asExpression(assignment.properties.value);
    if (!target || value?.kind !== 'call') continue;
    const source = file.evidenceBySubject.get(assignment.id);
    const offset = source?.startOffset ?? 0;
    const canonical = canonicalFastApiName(value.name ?? '', file, '', offset);
    const kind = canonical === 'fastapi.FastAPI' ? 'application' : canonical === 'fastapi.APIRouter' ? 'router' : undefined;
    if (!kind) continue;
    const args = argsOf(value);
    const keywords = keywordArgs(args);
    const prefixExpression = keywords.get('prefix');
    const prefix = expressionString(prefixExpression);
    const prefixResolved = kind === 'application' || prefixExpression === undefined || prefix !== undefined;
    if (!prefixResolved) addDiagnostic('FASTAPI_DYNAMIC_ROUTER_PREFIX', `Could not statically resolve prefix for router '${target}'.`, source);
    const tags = stringsFromExpression(keywords.get('tags'));
    const dependencies = makeDependencyFacts(keywords.get('dependencies'), file, '', offset, source);
    const responses = responseFacts(keywords.get('responses'));
    const logicalKey = `${file.module}.${target}`;
    const key = `${file.path}#${assignment.id}`;
    const node = addNode(kind === 'application' ? 'fastapi_application' : 'fastapi_router', target, file.path, `${key}/${logicalKey}`, { module: file.module, name: target, ...(kind === 'router' ? { prefix: prefix ?? null, prefixResolved, tags } : {}) }, source, kind === 'application' ? 'fastapi.application' : 'fastapi.router');
    objects.push({ key, logicalKey, sourceNodeId: assignment.id, file, assignment, kind, prefix: prefix ?? '', prefixResolved, tags, dependencies, responses, node });
  }
  return objects;
}

function collectIncludes(files: FastApiFile[], resolveObject: (file: FastApiFile, name: string, scope: string, offset: number) => RouterObject | undefined, addDiagnostic: (code: string, message: string, source?: AnalysisEvidence) => void): IncludeSpec[] {
  const includes: IncludeSpec[] = [];
  for (const file of files) {
    const sources = [...file.nodes.map((node) => ({ node, calls: callsOf(node) }))];
    const seen = new Set<string>();
    for (const { node, calls } of sources) calls.forEach((call, callIndex) => {
      if (!call.callee.endsWith('.include_router')) return;
      const key_ = `${node.id}:${callIndex}:${call.callee}`;
      if (seen.has(key_)) return;
      seen.add(key_);
      const scope = isScopeNode(node) ? String(node.properties.qualifiedName ?? '') : '';
      const offset = offsetAt(file.source, call.line, call.column);
      const ownerName = call.callee.slice(0, -'.include_router'.length);
      const owner = resolveObject(file, ownerName, scope, offset);
      if (!owner) return;
      const positional = call.arguments.filter((arg) => arg.kind === 'positional').map((arg) => arg.expression);
      const childName = expressionName(positional[0]);
      const child = childName ? resolveObject(file, childName, scope, offset) : undefined;
      if (!child) { addDiagnostic('FASTAPI_UNRESOLVED_ROUTER', `Could not resolve router passed to '${call.callee}'.`, file.evidenceBySubject.get(node.id)); }
      const keywords = keywordArgs(call.arguments);
      const prefixExpression = keywords.get('prefix');
      const prefix = prefixExpression === undefined ? '' : expressionString(prefixExpression);
      const source = callEvidence(file.path, call.line, call.column);
      includes.push({ key: `${file.path}:${node.id}:include:${callIndex}`, ownerKey: owner.key, ...(child ? { childKey: child.key, childSourceNodeId: child.sourceNodeId } : {}), file, scope, offset, prefix: prefix ?? '', prefixResolved: prefixExpression === undefined || prefix !== undefined, tags: stringsFromExpression(keywords.get('tags')), dependencies: makeDependencyFacts(keywords.get('dependencies'), file, scope, offset, source), responses: responseFacts(keywords.get('responses')), source });
    });
  }
  return includes;
}

function collectRoutes(files: FastApiFile[], resolveObject: (file: FastApiFile, name: string, scope: string, offset: number) => RouterObject | undefined, namespace: string, addDiagnostic: (code: string, message: string, source?: AnalysisEvidence) => void): RouteSpec[] {
  void namespace;
  const routes: RouteSpec[] = [];
  for (const file of files) for (const handler of file.functions) {
    const source = file.evidenceBySubject.get(handler.id);
    const scope = String(handler.properties.qualifiedName ?? '');
    const offset = source?.startOffset ?? 0;
    let occurrence = 0;
    for (const decorator of decoratorsOf(handler)) {
      const last = decorator.name.split('.').at(-1)!;
      if (!['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace', 'api_route'].includes(last)) continue;
      const ownerName = decorator.name.slice(0, -(last.length + 1));
      const owner = resolveObject(file, ownerName, scope, offset);
      if (!owner) continue;
      const { positional, keywords } = decoratorArguments(decorator);
      const path = expressionString(positional[0]);
      if (path === undefined) { addDiagnostic('FASTAPI_DYNAMIC_ROUTE_PATH', `Route '${scope}' has a non-literal path and was not exposed.`, source); continue; }
      const methodList = strictStringsFromExpression(keywords.get('methods'));
      if (last === 'api_route' && keywords.has('methods') && !methodList) { addDiagnostic('FASTAPI_DYNAMIC_ROUTE_METHODS', `Route '${scope}' has dynamic methods and was not exposed.`, source); continue; }
      let methods = last === 'api_route' ? (methodList ?? []) : [last.toUpperCase()];
      if (last === 'api_route' && !keywords.has('methods')) methods = ['GET'];
      methods = methods.map((method) => method.toUpperCase()).filter((method) => ROUTE_METHODS.has(method));
      if (!methods.length) { addDiagnostic('FASTAPI_DYNAMIC_ROUTE_METHODS', `Route '${scope}' has no supported statically known methods.`, source); continue; }
      const operation = operationFacts(keywords, file, scope, offset, addDiagnostic, source);
      routes.push({ key: `${file.path}:${handler.id}:decorator:${occurrence++}:${last}:${path}`, ownerKey: owner.key, file, handlerFile: file, handler, path, methods, operation, dependencies: makeDependencyFacts(keywords.get('dependencies'), file, scope, offset, source), source, occurrence });
    }
  }
  for (const file of files) for (const sourceNode of file.nodes) {
    const calls = callsOf(sourceNode);
    const scope = isScopeNode(sourceNode) ? String(sourceNode.properties.qualifiedName ?? '') : '';
    calls.forEach((call, callIndex) => {
      if (!call.callee.endsWith('.add_api_route')) return;
      const source = callEvidence(file.path, call.line, call.column);
      const offset = offsetAt(file.source, call.line, call.column);
      const ownerName = call.callee.slice(0, -'.add_api_route'.length);
      const owner = resolveObject(file, ownerName, scope, offset);
      if (!owner) return;
      const positional = call.arguments.filter((arg) => arg.kind === 'positional').map((arg) => arg.expression);
      const keywords = keywordArgs(call.arguments);
      const path = expressionString(positional[0] ?? keywords.get('path'));
      const endpointName = expressionName(positional[1] ?? keywords.get('endpoint'));
      const handlerKey = endpointName ? resolveFastApiSymbol(files, file, endpointName, scope, offset) : undefined;
      const candidates = handlerKey ? files.flatMap((item) => item.functions.filter((fn) => `${String(fn.properties.module)}.${String(fn.properties.qualifiedName)}` === handlerKey).map((fn) => ({ file: item, fn }))) : [];
      if (candidates.length > 1) { addDiagnostic('FASTAPI_AMBIGUOUS_HANDLER', `Endpoint '${endpointName}' has multiple source declarations.`, source); return; }
      const handlerCandidate = candidates[0];
      const handler = handlerCandidate?.fn;
      if (path === undefined || !handler) { addDiagnostic(path === undefined ? 'FASTAPI_DYNAMIC_ROUTE_PATH' : 'FASTAPI_UNRESOLVED_HANDLER', `Could not statically resolve '${call.callee}' path or endpoint.`, source); return; }
      let methods = stringsFromExpression(keywords.get('methods'));
      if (!keywords.has('methods')) methods = ['GET'];
      const methodList = strictStringsFromExpression(keywords.get('methods'));
      if (keywords.has('methods') && !methodList) { addDiagnostic('FASTAPI_DYNAMIC_ROUTE_METHODS', `Route '${endpointName}' has dynamic methods and was not exposed.`, source); return; }
      methods = (methodList ?? methods).map((method) => method.toUpperCase()).filter((method) => ROUTE_METHODS.has(method));
      if (!methods.length) { addDiagnostic('FASTAPI_DYNAMIC_ROUTE_METHODS', `Route '${endpointName}' has no supported statically known methods.`, source); return; }
      routes.push({ key: `${file.path}:${sourceNode.id}:add_api_route:${call.callee}:${callIndex}`, ownerKey: owner.key, file, handlerFile: handlerCandidate!.file, handler, path, methods, operation: operationFacts(keywords, file, scope, offset, addDiagnostic, source), dependencies: makeDependencyFacts(keywords.get('dependencies'), file, scope, offset, source), source, occurrence: callIndex });
    });
  }
  return routes;
}

function projectRoute(context: AnalysisContext, namespace: string, route: RouteSpec, path: string, tags: string[], dependencies: DependencyFact[], parent: GraphNode, routeKey: string, addSourceNode: (file: FastApiFile, node: GraphNode) => GraphNode, addNode: (...args: any[]) => GraphNode, addEdge: (...args: any[]) => void, addDiagnostic: (code: string, message: string, source?: AnalysisEvidence) => void, files: FastApiFile[], config: FastApiConfig) {
  const handler = addSourceNode(route.handlerFile, route.handler);
  const source = route.source ?? route.handlerFile.evidenceBySubject.get(route.handler.id);
  const routeNode = addNode('fastapi_route', route.handler.label, route.handlerFile.path, routeKey, { namespace, path, pathShape: apiPathShape(path), methods: route.methods, tags, ...route.operation, handlerId: handler.id }, source, 'fastapi.route');
  addEdge(parent, routeNode, 'contains', routeKey, source, { path, methods: route.methods });
  addEdge(routeNode, handler, 'handled_by', routeKey, source, { qualifiedName: handler.properties.qualifiedName ?? handler.label });
    for (const method of route.methods) {
    const endpoint = addNode('api_endpoint', `${method} ${path}`, apiEndpointUri(namespace, method, path), `${namespace}/${method}/${path}`, { namespace, method, path, pathShape: apiPathShape(path), tags }, source, 'api.endpoint');
    addEdge(routeNode, endpoint, 'exposes', `${routeKey}:${method}`, source, { method, path });
    if (route.operation.operationId) endpoint.properties = { ...endpoint.properties, operationId: route.operation.operationId };
    addRouteFacts(context, namespace, route, path, endpoint, routeNode, dependencies, routeKey, addSourceNode, addNode, addEdge, addDiagnostic, files, config);
  }
}

function addRouteFacts(context: AnalysisContext, namespace: string, route: RouteSpec, effectivePath: string, endpoint: GraphNode, routeNode: GraphNode, dependencies: DependencyFact[], routeKey: string,
  addSourceNode: (file: FastApiFile, node: GraphNode) => GraphNode, addNode: (...args: any[]) => GraphNode, addEdge: (...args: any[]) => void,
  addDiagnostic: (code: string, message: string, source?: AnalysisEvidence) => void, files: FastApiFile[], config: FastApiConfig) {
  const source = route.handlerFile.evidenceBySubject.get(route.handler.id) ?? route.source;
  const dependencyBudget: DependencyBudget = { visited: new Set(), resolved: new Set() };
  const params = Array.isArray(route.handler.properties.parameters) ? route.handler.properties.parameters as PythonParameterFact[] : [];
  const pathNames = [...effectivePath.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!.split(':')[0]!);
  for (const param of params) {
    const defaultExpr = param.default;
    const scope = String(route.handler.properties.qualifiedName ?? '');
    const markerExpression = findParameterMarker(defaultExpr, route.handlerFile, scope, source?.startOffset ?? 0) ?? findParameterMarker(param.annotation, route.handlerFile, scope, source?.startOffset ?? 0);
    const marker = canonicalCall(markerExpression, route.handlerFile, scope, source?.startOffset ?? 0);
    const defaultName = marker?.split('.').at(-1);
    const explicit = defaultName ? PARAMETER_NAMES.get(`fastapi.${defaultName}`) : undefined;
    const dependency = DEPENDENCY_NAMES.has(marker ?? '');
    if (dependency) continue;
    const paramIn = dependency ? undefined : explicit ?? (pathNames.includes(param.name) ? 'path' : param.annotation ? scalarAnnotation(param.annotation) ? 'query' : 'body' : undefined);
    if (!paramIn && defaultExpr) addDiagnostic('FASTAPI_UNRESOLVED_PARAMETER', `Parameter '${param.name}' has a dynamic or unsupported marker.`, source);
    if (paramIn) {
      const inputKind = paramIn === 'body' || paramIn === 'form' || paramIn === 'file';
      const requiredState = parameterRequired(markerExpression, param.hasDefault);
      const node = addNode(inputKind ? 'api_request_body' : 'api_parameter', param.name, route.handlerFile.path, `${routeKey}/parameter/${param.name}`, {
        name: param.name, in: paramIn, required: requiredState,
        ...(param.annotation ? { annotation: schemaName(param.annotation) } : {}),
        ...(expressionString(keywordArgs(argsOf(markerExpression)).get('alias')) ? { alias: expressionString(keywordArgs(argsOf(markerExpression)).get('alias')) } : {}),
        ...(expressionString(keywordArgs(argsOf(markerExpression)).get('description')) ? { description: expressionString(keywordArgs(argsOf(markerExpression)).get('description')) } : {}),
      }, source, 'api.parameter', explicit ? 'DIRECT' : 'DERIVED');
      addEdge(endpoint, node, 'accepts', `${routeKey}:parameter:${param.name}`, source, { in: paramIn }, explicit ? 'DIRECT' : 'DERIVED');
      const schema = param.annotation ? schemaName(param.annotation) : undefined;
      if (schema) addSchemaReference(schema, route.handlerFile, route.handler, node, routeKey, source, addSourceNode, addNode, addEdge, files);
    }
  }
  const responseName = typeof route.operation.responseModel === 'string' ? route.operation.responseModel : undefined;
  const returnAnnotation = expressionName(route.handler.properties.returnAnnotation);
  const response = responseName ?? returnAnnotation;
  if (response) {
    const node = addNode('api_response', `${route.methods[0]} ${route.path} response`, route.file.path, `${routeKey}/response`, { model: response }, source, 'api.response', responseName ? 'DIRECT' : 'DERIVED');
    addEdge(endpoint, node, 'returns', `${routeKey}:response`, source, {}, responseName ? 'DIRECT' : 'DERIVED');
    addSchemaReference(response, route.handlerFile, route.handler, node, routeKey, source, addSourceNode, addNode, addEdge, files);
  }
  const responseFacts = Array.isArray(route.operation.responseStatuses) ? route.operation.responseStatuses as Array<{ status: string; description?: string; model?: string }> : [];
  for (const responseFact of responseFacts) {
    const status = responseFact.status;
    const node = addNode('api_response', `${status} response`, route.file.path, `${routeKey}/response/${status}`, { statusCode: Number(status) || status, ...(responseFact.description ? { description: responseFact.description } : {}), ...(responseFact.model ? { model: responseFact.model } : {}) }, source, 'api.response');
    addEdge(endpoint, node, 'returns', `${routeKey}:response:${status}`, source);
    if (responseFact.model) addSchemaReference(responseFact.model, route.handlerFile, route.handler, node, routeKey, source, addSourceNode, addNode, addEdge, files);
  }
  for (const fact of dependencies) for (const dep of dependencyExpressions(fact.expression)) {
    const canonical = canonicalCall(dep, fact.file, fact.scope, fact.offset);
    if (canonical !== 'fastapi.Depends' && canonical !== 'fastapi.Security') continue;
    const targetExpr = dep.arguments?.find((arg) => arg.kind === 'positional')?.expression;
    if (resolveSecurityScheme(targetExpr, keywordArgs(argsOf(dep)).get('scopes'), fact.file, endpoint, routeKey, fact.source ?? source, addNode, addEdge, addDiagnostic, canonical === 'fastapi.Security')) continue;
    const targetName = expressionName(targetExpr);
    const symbol = targetName ? resolveFastApiSymbol(files, fact.file, targetName, fact.scope, fact.offset) : undefined;
    const fn = symbol ? uniqueFunction(files, symbol, addDiagnostic, fact.source ?? source) : undefined;
    if (!fn) { addDiagnostic('FASTAPI_UNRESOLVED_DEPENDENCY', 'Could not resolve router-level dependency.', source); continue; }
    countDependency(symbol!, dependencyBudget, config, source);
    const dependencyFile = files.find((item) => item.functions.includes(fn))!;
    const sourceFunction = addSourceNode(dependencyFile, fn);
    addEdge(endpoint, sourceFunction, 'depends_on', `${routeKey}:dependency:${symbol}:${fact.file.path}:${fact.offset}`, fact.source ?? source);
    countDependency(symbol!, dependencyBudget, config, fact.source ?? source);
    addCallsAndReferences(sourceFunction, fn, dependencyFile, routeKey, fact.source ?? source, addSourceNode, addNode, addEdge, files, config, addDiagnostic, dependencyBudget);
  }
  void context; void namespace; void routeNode;
}

function resolveSecurityScheme(expression: PythonExpressionFact | undefined, scopeExpression: PythonExpressionFact | undefined, file: FastApiFile, endpoint: GraphNode, key: string,
  source: AnalysisEvidence | undefined, addNode: (...args: any[]) => GraphNode, addEdge: (...args: any[]) => void, addDiagnostic: (code: string, message: string, source?: AnalysisEvidence) => void, reportMissing = true) {
  const name = expressionName(expression);
  if (!name) return undefined;
  const assignment = file.assignments.filter((node) => node.properties.scope === '' && expressionName(node.properties.target) === name && (file.evidenceBySubject.get(node.id)?.startOffset ?? Number.MAX_SAFE_INTEGER) <= (source?.startOffset ?? Number.MAX_SAFE_INTEGER)).sort((a, b) => (file.evidenceBySubject.get(b.id)?.startOffset ?? 0) - (file.evidenceBySubject.get(a.id)?.startOffset ?? 0))[0];
  const value = asExpression(assignment?.properties.value);
  if (!value || value.kind !== 'call') { if (reportMissing) addDiagnostic('FASTAPI_UNRESOLVED_SECURITY', `Security scheme '${name}' is not a static supported constructor.`, source); return undefined; }
  const assignmentEvidence = assignment ? file.evidenceBySubject.get(assignment.id) : undefined;
  const canonical = canonicalFastApiName(value.name ?? '', file, '', assignmentEvidence?.startOffset ?? 0);
  if (!SECURITY_NAMES.has(canonical)) { if (reportMissing) addDiagnostic('FASTAPI_UNRESOLVED_SECURITY', `Security scheme '${name}' uses an unsupported constructor.`, assignmentEvidence); return undefined; }
  const args = keywordArgs(value.arguments ?? []);
  const publicProperties: Record<string, unknown> = { constructor: canonical, name };
  for (const field of ['scheme_name', 'description', 'scheme', 'bearerFormat', 'auto_error', 'tokenUrl', 'authorizationUrl', 'refreshUrl', 'openIdConnectUrl', 'scopes', 'name', 'in']) {
    const extracted = staticValue(args.get(field), file, '', assignmentEvidence?.startOffset ?? 0);
    if (extracted !== undefined && (extracted === null || ['string', 'number', 'boolean'].includes(typeof extracted) || Array.isArray(extracted))) publicProperties[field] = extracted;
  }
  const node = addNode('api_security_scheme', name, file.path, `security/${name}/${assignment?.id ?? canonical}`, publicProperties, assignmentEvidence, 'api.security_scheme');
  const scopes = stringsFromExpression(scopeExpression);
  const requirement = addNode('api_security_requirement', `Security requirement ${name}`, file.path, `security-requirement/${key}/${name}`, { scheme: name, scopes }, source, 'api.security_requirement');
  addEdge(endpoint, requirement, 'secured_by', `${key}:security:${name}`, source, {}, 'DIRECT');
  addEdge(requirement, node, 'uses_scheme', `${key}:uses-scheme:${name}`, source, {}, 'DIRECT');
  return node;
}

function addSchemaReference(name: string, file: FastApiFile, scopeNode: GraphNode, owner: GraphNode, key: string, source: AnalysisEvidence | undefined,
  addSourceNode: (file: FastApiFile, node: GraphNode) => GraphNode, addNode: (...args: any[]) => GraphNode, addEdge: (...args: any[]) => void, files: FastApiFile[]) {
  const typeNames = schemaTypeNames(name);
  for (const typeName of typeNames) {
    const symbol = resolveFastApiSymbol(files, file, typeName, String(scopeNode.properties.qualifiedName ?? ''), source?.startOffset ?? 0);
    const canonicalType = canonicalFastApiName(typeName, file, String(scopeNode.properties.qualifiedName ?? ''), source?.startOffset ?? 0);
    if (canonicalType.startsWith('typing.') || canonicalType.startsWith('typing_extensions.') || PARAMETER_NAMES.has(canonicalType) || DEPENDENCY_NAMES.has(canonicalType)) continue;
    const matches = symbol ? files.flatMap((item) => item.classes).filter((item) => `${item.properties.module}.${item.properties.qualifiedName}` === symbol) : [];
    if (matches.length === 1) {
      const declarationFile = files.find((item) => item.classes.includes(matches[0]!))!;
      addEdge(owner, addSourceNode(declarationFile, matches[0]!), 'uses_schema', `${key}:schema:${typeName}`, source, { type: name, resolved: true }, 'DERIVED');
    } else {
      const schema = addNode('api_schema_reference', typeName, file.path, `${key}/schema/${typeName}`, { qualifiedName: symbol ?? typeName, type: name, resolved: false, ambiguous: matches.length > 1 }, source, 'api.schema_reference', 'DERIVED');
      addEdge(owner, schema, 'uses_schema', `${key}:schema:${typeName}`, source, { type: name, resolved: false, ambiguous: matches.length > 1 }, 'DERIVED');
    }
  }
}

function addCallsAndReferences(owner: GraphNode, fn: GraphNode, file: FastApiFile, key: string, source: AnalysisEvidence | undefined,
  addSourceNode: (file: FastApiFile, node: GraphNode) => GraphNode, addNode: (...args: any[]) => GraphNode, addEdge: (...args: any[]) => void, files: FastApiFile[], config: FastApiConfig, addDiagnostic: (code: string, message: string, source?: AnalysisEvidence) => void, budget: DependencyBudget) {
  const walk = (currentFile: FastApiFile, current: GraphNode, depth: number) => {
    const currentKey = `${current.properties.module}.${current.properties.qualifiedName}`;
    if (budget.visited.has(currentKey)) return;
    budget.visited.add(currentKey);
    if (depth > config.maxDependencyDepth) throw fatalLimit('FASTAPI_DEPENDENCY_DEPTH_LIMIT', `Dependency traversal exceeded maxDependencyDepth (${config.maxDependencyDepth}).`, source);
    const currentEvidence = currentFile.evidenceBySubject.get(current.id) ?? source;
    const parameters = Array.isArray(current.properties.parameters) ? current.properties.parameters as PythonParameterFact[] : [];
    for (const parameter of parameters) for (const dependency of dependencyExpressions(parameter.default).concat(dependencyExpressions(parameter.annotation))) {
      const canonical = canonicalCall(dependency, currentFile, String(current.properties.qualifiedName ?? ''), currentEvidence?.startOffset ?? 0);
      if (canonical !== 'fastapi.Depends' && canonical !== 'fastapi.Security') continue;
      const target = dependency.arguments?.find((argument) => argument.kind === 'positional')?.expression;
      if (resolveSecurityScheme(target, keywordArgs(argsOf(dependency)).get('scopes'), currentFile, current, key, currentEvidence, addNode, addEdge, addDiagnostic, canonical === 'fastapi.Security')) continue;
      const targetName = expressionName(target);
      const symbol = targetName ? resolveFastApiSymbol(files, currentFile, targetName, String(current.properties.qualifiedName ?? ''), currentEvidence?.startOffset ?? 0) : undefined;
      const next = symbol ? uniqueFunction(files, symbol, addDiagnostic, currentEvidence) : undefined;
      const nextFile = next ? files.find((item) => item.functions.includes(next)) : undefined;
      if (!next || !nextFile) { addDiagnostic('FASTAPI_UNRESOLVED_DEPENDENCY', `Could not resolve dependency '${targetName ?? '<dynamic>'}'.`, currentEvidence); continue; }
      countDependency(symbol!, budget, config, currentEvidence);
      addEdge(current, addSourceNode(nextFile, next), 'depends_on', `${key}:nested-dependency:${symbol}`, currentEvidence, { parameter: parameter.name });
      walk(nextFile, next, depth + 1);
    }
    const refs = Array.isArray(current.properties.references) ? current.properties.references as PythonExpressionFact[] : [];
    for (const ref of refs) {
      const referenceName = expressionName(ref);
      if (!referenceName) continue;
      const symbol = resolveFastApiSymbol(files, currentFile, referenceName, String(current.properties.qualifiedName ?? ''), source?.startOffset ?? 0);
      const candidates = symbol ? files.flatMap((item) => [...item.functions, ...item.classes].filter((node) => `${node.properties.module}.${node.properties.qualifiedName}` === symbol)) : [];
      const target = candidates.length === 1 ? candidates[0] : undefined;
      if (candidates.length > 1) addDiagnostic('FASTAPI_AMBIGUOUS_REFERENCE', `Source reference '${referenceName}' has multiple declarations.`, source);
      const targetFile = target ? files.find((item) => [...item.functions, ...item.classes].includes(target)) : undefined;
      if (target && targetFile) addEdge(owner, addSourceNode(targetFile, target), 'references', `${key}:reference:${symbol}`, source, { name: referenceName }, 'DERIVED');
    }
    for (const call of callsOf(current)) {
      const callOffset = offsetAt(currentFile.source, call.line, call.column);
      const symbol = resolveFastApiSymbol(files, currentFile, call.callee, String(current.properties.qualifiedName ?? ''), callOffset);
      const target = symbol ? uniqueFunction(files, symbol, addDiagnostic, source) : undefined;
      const targetFile = target ? files.find((item) => item.functions.includes(target)) : undefined;
      if (!target || !targetFile) continue;
      countDependency(symbol!, budget, config, currentEvidence);
      addEdge(current, addSourceNode(targetFile, target), 'calls', `${key}:call:${symbol}:${call.line}:${call.column}`, source, { callee: symbol });
      walk(targetFile, target, depth + 1);
    }
  };
  walk(file, fn, 1);
}

type DependencyBudget = { visited: Set<string>; resolved: Set<string> };
function countDependency(symbol: string, budget: DependencyBudget, config: FastApiConfig, source?: AnalysisEvidence) {
  budget.resolved.add(symbol);
  if (budget.resolved.size > config.maxResolvedFunctionsPerRoute) throw fatalLimit('FASTAPI_DEPENDENCY_FUNCTION_LIMIT', `Dependency traversal exceeded maxResolvedFunctionsPerRoute (${config.maxResolvedFunctionsPerRoute}).`, source);
}
function uniqueFunction(files: FastApiFile[], symbol: string, addDiagnostic: (code: string, message: string, source?: AnalysisEvidence) => void, source?: AnalysisEvidence) {
  const candidates = files.flatMap((item) => item.functions.filter((node) => `${node.properties.module}.${node.properties.qualifiedName}` === symbol).map((node) => ({ file: item, node })));
  if (candidates.length > 1) { addDiagnostic('FASTAPI_AMBIGUOUS_DEPENDENCY', `Function '${symbol}' has multiple source declarations.`, source); return undefined; }
  return candidates[0]?.node;
}

function canonicalCall(expression: PythonExpressionFact | undefined, file: FastApiFile, scope: string, offset: number) {
  return expression?.kind === 'call' ? canonicalFastApiName(expression.name ?? '', file, scope, offset) : undefined;
}
function findParameterMarker(expression: PythonExpressionFact | undefined, file: FastApiFile, scope: string, offset: number): PythonExpressionFact | undefined {
  if (!expression) return undefined;
  if (expression.kind === 'call' && (PARAMETER_NAMES.has(canonicalFastApiName(expression.name ?? '', file, scope, offset)) || DEPENDENCY_NAMES.has(canonicalFastApiName(expression.name ?? '', file, scope, offset)))) return expression;
  for (const child of expression.children ?? []) { const found = findParameterMarker(child, file, scope, offset); if (found) return found; }
  for (const argument of expression.arguments ?? []) { const found = findParameterMarker(argument.expression, file, scope, offset); if (found) return found; }
  return undefined;
}
function scalarAnnotation(expression: unknown): boolean { const name = expressionName(expression); return !!name && /^(str|int|float|bool|bytes|UUID|date|datetime)$/.test(name.split('.').at(-1)!); }

function operationFacts(keywords: Map<string, PythonExpressionFact>, file: FastApiFile, scope: string, offset: number, addDiagnostic: (code: string, message: string, source?: AnalysisEvidence) => void, source?: AnalysisEvidence) {
  const result: Record<string, unknown> = {};
  for (const key of ['operation_id', 'summary']) { const value = expressionString(keywords.get(key)); if (value !== undefined) result[key === 'operation_id' ? 'operationId' : key] = value; }
  const status = staticValue(keywords.get('status_code'), file, scope, offset);
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) result.statusCode = status;
  else if (keywords.has('status_code')) addDiagnostic('FASTAPI_DYNAMIC_STATUS_CODE', 'Route status_code was not a supported literal or proven constant.', source);
  for (const key of ['deprecated', 'include_in_schema']) {
    const value = staticValue(keywords.get(key), file, scope, offset);
    if (typeof value === 'boolean') result[key === 'include_in_schema' ? 'includeInSchema' : key] = value;
  }
  const tags = stringsFromExpression(keywords.get('tags'));
  if (keywords.has('tags')) result.routeTags = tags;
  const responseModel = keywords.get('response_model');
  if (responseModel) result.responseModel = schemaName(responseModel);
  const responses = keywords.get('responses');
  if (responses?.kind === 'DictionaryExpression') result.responseStatuses = dictionaryEntries(responses);
  return result;
}

function routeDependencies(route: RouteSpec): DependencyFact[] {
  const result: DependencyFact[] = [];
  const parameters = Array.isArray(route.handler.properties.parameters) ? route.handler.properties.parameters as PythonParameterFact[] : [];
  const scope = String(route.handler.properties.qualifiedName ?? '');
  const source = route.handlerFile.evidenceBySubject.get(route.handler.id);
  const offset = source?.startOffset ?? 0;
  for (const parameter of parameters) {
    for (const expression of dependencyExpressions(parameter.default).concat(dependencyExpressions(parameter.annotation))) result.push({ expression, file: route.handlerFile, scope, offset, source });
  }
  return result;
}

function makeDependencyFacts(expression: PythonExpressionFact | undefined, file: FastApiFile, scope: string, offset: number, source?: AnalysisEvidence): DependencyFact[] {
  return expressionsFromList(expression).map((item) => ({ expression: item, file, scope, offset, source }));
}

function decoratorArguments(decorator: ReturnType<typeof decoratorsOf>[number]) {
  const positional: PythonExpressionFact[] = [];
  const keywords = new Map<string, PythonExpressionFact>();
  for (const argument of decorator.arguments) {
    if (argument.kind === 'keyword') {
      const name = String((argument as unknown as { name?: string }).name ?? '');
      const value = argument.children?.[0];
      if (name && value) keywords.set(name, value);
    } else positional.push(argument);
  }
  return { positional, keywords };
}

function expressionsFromList(expression: PythonExpressionFact | undefined) { return literalList(expression) ?? []; }
function stringsFromExpression(expression: PythonExpressionFact | undefined) { return expressionsFromList(expression).map(expressionString).filter((value): value is string => value !== undefined); }
function strictStringsFromExpression(expression: PythonExpressionFact | undefined): string[] | undefined {
  const values = literalList(expression);
  if (!values) return undefined;
  const strings = values.map(expressionString);
  return strings.every((value): value is string => value !== undefined) ? strings : undefined;
}
function responseFacts(expression: PythonExpressionFact | undefined): ResponseFact[] { return expression?.kind === 'DictionaryExpression' ? dictionaryEntries(expression) : []; }
function mergeResponses(...collections: ResponseFact[][]): ResponseFact[] {
  const byStatus = new Map<string, ResponseFact>();
  for (const collection of collections) for (const response of collection) byStatus.set(response.status, response);
  return [...byStatus.values()].sort((a, b) => a.status.localeCompare(b.status));
}
function parameterRequired(marker: PythonExpressionFact | undefined, hasDefault: boolean): boolean | null {
  if (!marker) return !hasDefault;
  const args = argsOf(marker);
  const explicit = keywordArgs(args).get('default') ?? args.find((arg) => arg.kind === 'positional')?.expression;
  if (!explicit) return true;
  if (explicit.kind === 'Ellipsis') return true;
  if (['string', 'number', 'boolean', 'none'].includes(explicit.literalKind ?? '')) return explicit.literalKind === 'none' ? false : false;
  return null;
}
function dependencyExpressions(expression: PythonExpressionFact | undefined): PythonExpressionFact[] {
  const result: PythonExpressionFact[] = [];
  const visit = (item?: PythonExpressionFact) => {
    if (!item) return;
    if (item.kind === 'call') result.push(item);
    for (const child of item.children ?? []) visit(child);
    for (const argument of argsOf(item)) visit(argument.expression);
  };
  visit(expression);
  return result;
}
function staticValue(expression: PythonExpressionFact | undefined, file: FastApiFile, scope: string, offset: number): JsonValue | undefined {
  const direct = expressionValue(expression);
  if (direct !== undefined) return direct;
  const name = expressionName(expression);
  if (!name || name.includes('.')) return undefined;
  const assignment = file.assignments.filter((node) => node.properties.scope === '' && expressionName(node.properties.target) === name && (file.evidenceBySubject.get(node.id)?.startOffset ?? 0) < offset).sort((a, b) => (file.evidenceBySubject.get(b.id)?.startOffset ?? 0) - (file.evidenceBySubject.get(a.id)?.startOffset ?? 0))[0];
  return assignment ? expressionValue(asExpression(assignment.properties.value)) : undefined;
}
function schemaName(expression: PythonExpressionFact): string {
  const direct = expressionName(expression);
  if (direct) return direct;
  if (expression.kind === 'SubscriptExpression' && expression.children?.length) return `${schemaName(expression.children[0]!)}[${expression.children.slice(1).map(schemaName).join(', ')}]`;
  if (expression.kind.includes('Binary') && expression.children?.length) return expression.children.map(schemaName).join(' | ');
  return expression.children?.map(schemaName).filter(Boolean).join(', ') ?? expression.kind;
}
function schemaTypeNames(type: string): string[] {
  const names = type.match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [];
  const ignored = new Set(['list', 'dict', 'set', 'tuple', 'frozenset', 'Optional', 'Union', 'Annotated', 'Literal', 'Sequence', 'Mapping', 'Collection', 'Iterable', 'str', 'int', 'float', 'bool', 'bytes', 'None', 'Any', 'UUID', 'date', 'datetime', 'typing', 'typing_extensions', 'fastapi', 'Query', 'Path', 'Header', 'Cookie', 'Body', 'Form', 'File', 'Depends', 'Security']);
  return [...new Set(names.filter((name) => !ignored.has(name.split('.').at(-1)!)))];
}
function dictionaryEntries(expression: PythonExpressionFact): Array<{ status: string; description?: string; model?: string }> {
  const children = expression.children ?? [];
  const entries: Array<{ status: string; description?: string; model?: string }> = [];
  for (let index = 0; index + 1 < children.length; index += 2) {
    const key = expressionValue(children[index]);
    if (typeof key !== 'string' && typeof key !== 'number') continue;
    const value = children[index + 1]!;
    const entry: { status: string; description?: string; model?: string } = { status: String(key) };
    if (value.kind === 'DictionaryExpression') {
      const fields = value.children ?? [];
      for (let fieldIndex = 0; fieldIndex + 1 < fields.length; fieldIndex += 2) {
        const field = expressionString(fields[fieldIndex]);
        if (field === 'description') { const description = expressionString(fields[fieldIndex + 1]); if (description) entry.description = description; }
        if (field === 'model') { const model = expressionName(fields[fieldIndex + 1]); if (model) entry.model = model; }
      }
    }
    entries.push(entry);
  }
  return entries;
}
function mergeStrings(a: string[], b: string[]) { const seen = new Set<string>(); return [...a, ...b].filter((value) => !seen.has(value) && !!seen.add(value)); }
function offsetAt(source: string, line: number, column: number) { const lines = source.split('\n'); let offset = 0; for (let index = 0; index < Math.max(0, line - 1) && index < lines.length; index++) offset += lines[index]!.length + 1; return offset + column; }
function callEvidence(uri: string, line: number, column: number): AnalysisEvidence { return { id: '', subjectKind: 'node', subjectId: '', level: 'DIRECT', type: 'fastapi.call', uri, line, column, endLine: line, endColumn: column + 1 }; }
function asExpression(value: unknown): PythonExpressionFact | undefined { return typeof value === 'object' && value !== null ? value as PythonExpressionFact : undefined; }
function isScopeNode(node: GraphNode): boolean { return node.kind === 'python_class' || node.kind === 'python_function' || node.kind === 'python_async_function'; }
function dedupeDiagnostics(items: AnalysisDiagnostic[]) { return [...new Map(items.map((item) => [`${item.code ?? ''}\u0000${item.uri ?? ''}\u0000${item.line ?? ''}\u0000${item.message}`, item])).values()]; }
function fatalLimit(code: string, message: string, source?: AnalysisEvidence) {
  return new AnalysisError('ANALYZER_FAILED', message, [{ code, severity: 'error', message, ...(source?.uri ? { uri: source.uri } : {}), ...(source?.line ? { line: source.line } : {}) }]);
}
