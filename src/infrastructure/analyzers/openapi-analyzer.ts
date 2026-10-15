import { AnalysisError, type AnalysisContext, type AnalysisDiagnostic, type AnalysisEvidence, type Analyzer, type AnalysisResult } from '../../domain/analyzer.js';
import type { GraphEdge, GraphNode } from '../../domain/graph.js';
import { apiEndpointUri, apiPathShape } from '../../core/api-identity.js';
import { GraphIdentityFactory } from '../../core/graph-identity.js';
import { createHash } from 'node:crypto';
import type { Node as YamlNode } from 'yaml';
import { isMap, isScalar, isSeq } from 'yaml';
import { readOpenApiSnapshot, openApiConfig } from './openapi-source.js';
import { diagnosticsForDocument, pairs, parseOpenApiDocument, property, scalar, seq, type OpenApiDocument } from './openapi-document.js';

const ids = new GraphIdentityFactory();
const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const MAX_CONTRIBUTIONS = 9000;
const MAX_EVIDENCE = 10_000;
const MAX_REF_DEPTH = 64;

export const openApiAnalyzer: Analyzer = {
  descriptor: { id: 'builtin.openapi', version: '1.0.0', apiVersion: '1', capabilities: ['graph', 'evidence', 'diagnostics'] },
  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    try { return await analyze(context); }
    catch (error) {
      if (error instanceof AnalysisError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const code = /apiNamespace|specFiles|discover|maxSpecFiles|maxFileBytes|maxTotalBytes|Unsupported OpenAPI option/.test(message) ? 'OPENAPI_INVALID_CONFIG' : /not a supported OpenAPI|exceeds|limit|inventory/i.test(message) ? 'OPENAPI_INVALID_DOCUMENT' : /UTF-8/i.test(message) ? 'OPENAPI_INVALID_ENCODING' : 'OPENAPI_ANALYSIS_FAILED';
      throw new AnalysisError('ANALYZER_FAILED', message, [{ code, severity: 'error', message }]);
    }
  },
};

async function analyze(context: AnalysisContext): Promise<AnalysisResult> {
  const config = openApiConfig(context.config);
  const snapshot = await readOpenApiSnapshot(context.workspace.path, config, context.sourceRevision);
  const nodes: GraphNode[] = [], edges: GraphEdge[] = [], evidence: AnalysisEvidence[] = [], diagnostics: AnalysisDiagnostic[] = [];
  const nodeMap = new Map<string, GraphNode>(), edgeSet = new Set<string>(), evidenceSet = new Set<string>(), diagnosticSet = new Set<string>();
  const addDiag = (code: string, message: string, uri?: string, line?: number) => {
    const key = `${code}\0${uri ?? ''}\0${line ?? ''}\0${message}`;
    if (diagnosticSet.has(key)) return;
    diagnosticSet.add(key); diagnostics.push({ code, severity: 'warning', message, ...(uri ? { uri } : {}), ...(line ? { line } : {}) });
    enforce();
  };
  const enforce = () => { if (nodes.length + edges.length > MAX_CONTRIBUTIONS) throw new Error('OpenAPI graph exceeds 9000 nodes and edges.'); if (evidence.length > MAX_EVIDENCE) throw new Error('OpenAPI evidence exceeds 10000 items.'); if (diagnostics.length > MAX_EVIDENCE) throw new Error('OpenAPI diagnostics exceed 10000 items.'); };
  const addEvidence = (subjectKind: 'node' | 'edge', subjectId: string, type: string, doc: OpenApiDocument, source: AnalysisEvidence | undefined, anchor: string, level: 'DIRECT' | 'DERIVED' = 'DIRECT') => {
    const id = ids.node(subjectId, `evidence:${subjectKind}`, `${type}:${doc.file.path}:${anchor}`);
    if (evidenceSet.has(id)) return;
    evidenceSet.add(id); evidence.push({ ...(source ?? { id: '', subjectKind, subjectId, level, type }), id, subjectKind, subjectId, level }); enforce();
  };
  const addNode = (doc: OpenApiDocument, kind: string, key: string, label: string, props: Record<string, unknown>, source: AnalysisEvidence | undefined, level: 'DIRECT' | 'DERIVED' = 'DIRECT') => {
    if (label.length > 10_000) throw new Error(`OpenAPI ${kind} label exceeds 10000 characters.`);
    const id = kind === 'api_endpoint' ? ids.node(context.workspace.id, key, kind) : ids.node(context.workspace.id, `openapi://${encodeURIComponent(doc.file.path)}#${key}`, kind);
    let node = nodeMap.get(id);
    const clean = cleanProperties(props);
    if (!node) { node = { id, workspaceId: context.workspace.id, kind, label, properties: clean }; nodeMap.set(id, node); nodes.push(node); }
    else if (kind === 'api_endpoint') mergeEndpoint(node, clean, doc, source);
    addEvidence('node', id, `openapi.${kind}`, doc, source, key, level); enforce(); return node;
  };
  const addEdge = (doc: OpenApiDocument, from: GraphNode, to: GraphNode, kind: string, key: string, source?: AnalysisEvidence, props: Record<string, unknown> = {}, level: 'DIRECT' | 'DERIVED' = 'DIRECT') => {
    const id = ids.edge(context.workspace.id, from.id, to.id, kind);
    if (edgeSet.has(id)) {
      const existing = edges.find((item) => item.id === id)!;
      if (typeof props.mediaType === 'string') {
        const previous = Array.isArray(existing.properties.mediaTypes) ? existing.properties.mediaTypes as string[] : typeof existing.properties.mediaType === 'string' ? [existing.properties.mediaType as string] : [];
        delete existing.properties.mediaType;
        existing.properties.mediaTypes = [...new Set([...previous, props.mediaType])].sort();
      }
      addEvidence('edge', id, `openapi.${kind}`, doc, source, key, level); return;
    }
    edgeSet.add(id); edges.push({ id, workspaceId: context.workspace.id, sourceId: from.id, targetId: to.id, kind, properties: cleanProperties(props) });
    addEvidence('edge', id, `openapi.${kind}`, doc, source, key, level); enforce();
  };
  function mergeEndpoint(node: GraphNode, incoming: Record<string, unknown>, doc: OpenApiDocument, source?: AnalysisEvidence) {
    for (const [key, value] of Object.entries(incoming)) {
      const current = node.properties[key];
      if (current === undefined) node.properties[key] = value;
      else if (JSON.stringify(current) !== JSON.stringify(value)) {
        const conflicts = (node.properties.conflicts && typeof node.properties.conflicts === 'object' ? node.properties.conflicts : {}) as Record<string, unknown>;
        const values = new Map<string, unknown>();
        for (const item of Array.isArray(conflicts[key]) ? conflicts[key] as unknown[] : [current]) values.set(JSON.stringify(item), item);
        values.set(JSON.stringify(value), value);
        conflicts[key] = [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item);
        node.properties.conflicts = conflicts;
        addDiag('OPENAPI_ENDPOINT_CONFLICT', `Documents disagree about '${key}' for endpoint '${node.properties.method} ${node.properties.path}'.`, doc.file.path, source?.line);
      }
    }
  }

  const documents: OpenApiDocument[] = [];
  for (const file of snapshot.files) {
    const document = parseOpenApiDocument(file);
    const version = document.value.openapi;
    if (typeof version !== 'string' || !/^3\.(?:0|1|2)(?:\.\d+)?$/.test(version)) throw new Error(`Selected document '${file.path}' is not a supported OpenAPI 3.0, 3.1, or 3.2 document.`);
    documents.push(document);
  }
  for (const doc of documents) projectDocument(doc, config.apiNamespace, addNode, addEdge, addDiag, property, pairs, scalar, seq);
  // Resolve only in-memory JSON Pointers. External and malformed references remain explicit nodes.
  for (const doc of documents) resolveReferences(doc, nodes, evidence, addNode, addEdge, addDiag);
  enforce();
  return { sourceRevision: snapshot.sourceRevision, nodes, edges, evidence, diagnostics };

  function projectDocument(doc: OpenApiDocument, namespace: string, node: typeof addNode, edge: typeof addEdge, diag: typeof addDiag, get: typeof property, mapPairs: typeof pairs, getScalar: typeof scalar, getSeq: typeof seq) {
    const root = node(doc, 'openapi_document', 'document', doc.file.path, { path: doc.file.path, openapi: doc.value.openapi, title: stringAt(doc, doc.root, ['info', 'title']), version: stringAt(doc, doc.root, ['info', 'version']) }, doc.evidence(doc.root, 'document'));
    const serverSources = new Map<string, AnalysisEvidence>();
    const tagNodes = new Map<string, GraphNode>();
    for (const [index, tag] of getSeq(get(doc.root, 'tags')).entries()) {
      const name = valueAt(tag, 'name'); if (typeof name !== 'string') { diag('OPENAPI_INVALID_TAG', 'Document tag is missing a string name.', doc.file.path); continue; }
      const tagNode = node(doc, 'openapi_tag', `tags/${escapePointer(name)}`, name, { name, description: valueAt(tag, 'description') }, doc.evidence(tag, `tag.${index}`));
      tagNodes.set(name, tagNode); edge(doc, root, tagNode, 'contains', `tag:${name}`, doc.evidence(tag, `tag.${index}`));
    }
    const documentServers = projectServers(get(doc.root, 'servers'), root, 'document/servers');
    const components = get(doc.root, 'components');
    for (const [name, schema] of mapPairs(get(components, 'schemas'))) {
      const props: Record<string, unknown> = { name };
      for (const key of ['type', 'format', 'description', 'title', 'nullable', 'deprecated', 'readOnly', 'writeOnly', 'enum', 'required', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'additionalProperties']) {
        const v = jsonValueAt(schema, key); if (safeValue(v) && !(key === 'additionalProperties' && typeof v === 'object' && v !== null) && schemaSafeValue(key, v)) props[key] = v;
      }
      if (typeof valueAt(schema, '$ref') === 'string') props.ref = valueAt(schema, '$ref');
      props.sourcePath = doc.file.path;
      props.componentType = 'schemas';
      const schemaNode = node(doc, 'openapi_schema', `components/schemas/${escapePointer(name)}`, name, props, doc.evidence(schema, 'schema'));
      edge(doc, root, schemaNode, 'contains', `schema:${name}`, doc.evidence(schema, 'schema'));
      addSchemaReference(schema, schemaNode, `schema:${name}`, undefined, false);
      for (const [propertyName, propertyNode] of mapPairs(get(schema, 'properties'))) {
        const property = node(doc, 'api_schema_property', `components/schemas/${escapePointer(name)}/properties/${escapePointer(propertyName)}`, propertyName, safeProperties(propertyNode), doc.evidence(propertyNode, 'schema-property'));
        edge(doc, schemaNode, property, 'contains', `schema-property:${name}:${propertyName}`, doc.evidence(propertyNode, 'schema-property'));
        addSchemaReference(propertyNode, property, `schema-property:${name}:${propertyName}`, undefined, false);
      }
    }
    const schemes = new Map<string, GraphNode>();
    for (const [name, scheme] of mapPairs(get(components, 'securitySchemes'))) {
      const properties = safeProperties(scheme);
      const safe: Record<string, unknown> = {};
      for (const key of ['type', 'description', 'name', 'in', 'scheme', 'bearerFormat', 'openIdConnectUrl']) if (safeValue(properties[key])) safe[key] = properties[key];
      const flows = get(scheme, 'flows');
      if (flows) {
        const safeFlows: Record<string, unknown> = {};
        for (const [flowName, flow] of mapPairs(flows)) {
          if (!['implicit', 'password', 'clientCredentials', 'authorizationCode'].includes(flowName)) continue;
          const output: Record<string, unknown> = {};
          for (const key of ['authorizationUrl', 'tokenUrl', 'refreshUrl']) { const field = valueAt(flow, key); if (typeof field === 'string') output[key] = field; }
          const scopes: Record<string, string> = {};
          for (const [scope, description] of mapPairs(get(flow, 'scopes'))) { const text = getScalar(description); if (typeof text === 'string') scopes[scope] = text; }
          output.scopes = scopes; safeFlows[flowName] = output;
        }
        safe.flows = safeFlows;
      }
      safe.sourcePath = doc.file.path; safe.componentType = 'securitySchemes'; safe.componentName = name;
      const schemeNode = node(doc, 'api_security_scheme', `components/securitySchemes/${escapePointer(name)}`, name, safe, doc.evidence(scheme, 'security-scheme'));
      schemes.set(name, schemeNode); edge(doc, root, schemeNode, 'contains', `security-scheme:${name}`, doc.evidence(scheme, 'security-scheme'));
    }
    for (const componentType of ['parameters', 'requestBodies', 'responses', 'pathItems']) for (const [name, component] of mapPairs(get(components, componentType))) {
      const kind = componentType === 'parameters' ? 'api_parameter' : componentType === 'requestBodies' ? 'api_request_body' : componentType === 'responses' ? 'api_response' : 'openapi_component';
      const props = safeProperties(component); props.componentName = name; props.sourcePath = doc.file.path; props.componentType = componentType;
      const item = node(doc, kind, `components/${componentType}/${escapePointer(name)}`, name, props, doc.evidence(component, `component.${componentType}`));
      edge(doc, root, item, 'contains', `component:${componentType}:${name}`, doc.evidence(component, `component.${componentType}`));
    }
    collectReferences(doc, root);
    projectSecurity(get(doc.root, 'security'), root, 'document/security');
    const paths = get(doc.root, 'paths');
    for (const [path, pathItem] of mapPairs(paths)) {
      if (!path.startsWith('/')) { diag('OPENAPI_INVALID_PATH', `Path '${path}' must begin with '/'.`, doc.file.path); continue; }
      const resolvedPathItem = dereferencePathItem(pathItem, path);
      if (!resolvedPathItem) continue;
      const pathServers = pairValue(resolvedPathItem, 'servers');
      const pathServerNodes = pathServers ? projectServers(pathServers, root, `paths/${escapePointer(path)}/servers`) : documentServers;
      for (const [method, operation] of resolvedPathItem) {
        if (!methods.has(method.toLowerCase())) continue;
        const upperMethod = method.toUpperCase();
        const uri = apiEndpointUri(namespace, upperMethod, path);
        const endpoint = node(doc, 'api_endpoint', uri, `${upperMethod} ${path}`, { namespace, method: upperMethod, path, pathShape: apiPathShape(path) }, doc.evidence(operation, 'operation'));
        const operationKey = `operations/${upperMethod}/${escapePointer(path)}`;
        const operationSecurity = get(operation, 'security');
        const documentSecurity = get(doc.root, 'security');
        const securityMode = operationSecurity ? isSeq(operationSecurity) ? getSeq(operationSecurity).length === 0 ? 'disabled' : 'declared' : 'invalid' : documentSecurity ? isSeq(documentSecurity) ? getSeq(documentSecurity).length === 0 ? 'disabled' : 'document' : 'invalid' : 'none';
        const sourceOperation = node(doc, 'openapi_operation', operationKey, `${upperMethod} ${path}`, { documentPath: doc.file.path, method: upperMethod, path, operationId: valueAt(operation, 'operationId'), summary: valueAt(operation, 'summary'), description: valueAt(operation, 'description'), deprecated: valueAt(operation, 'deprecated'), tags: arrayAt(operation, 'tags'), securityMode }, doc.evidence(operation, 'operation'));
        edge(doc, root, sourceOperation, 'contains', `operation:${upperMethod}:${path}`, doc.evidence(operation, 'operation'));
        edge(doc, sourceOperation, endpoint, 'exposes', `endpoint:${upperMethod}:${path}`, doc.evidence(operation, 'operation'));
        const operationServers = get(operation, 'servers');
        const applicableServers = operationServers ? projectServers(operationServers, sourceOperation, `paths/${escapePointer(path)}/${upperMethod}/servers`) : pathServerNodes;
        if (!operationServers) for (const server of applicableServers) edge(doc, sourceOperation, server, 'uses_server', `operation-server:${path}:${upperMethod}:${server.id}`, serverSources.get(server.id), {}, 'DERIVED');
        for (const tagName of arrayAt(operation, 'tags') ?? []) {
          let tagNode = tagNodes.get(tagName);
          if (!tagNode) { tagNode = node(doc, 'openapi_tag', `tags/${escapePointer(tagName)}`, tagName, { name: tagName }, doc.evidence(operation, 'operation-tag')); tagNodes.set(tagName, tagNode); }
          edge(doc, sourceOperation, tagNode, 'tagged_as', `tagged:${path}:${upperMethod}:${tagName}`, doc.evidence(operation, 'operation-tag'));
        }
        projectSecurity(operationSecurity ?? documentSecurity, sourceOperation, `${path}/${upperMethod}/security`, !operationSecurity && !!documentSecurity);
        const pathParameters = getSeq(pairValue(resolvedPathItem, 'parameters'));
        const operationParameters = getSeq(get(operation, 'parameters'));
        const mergedParameters = new Map<string, { node: YamlNode; inherited: boolean }>();
        for (const parameter of pathParameters) mergedParameters.set(parameterKey(parameter), { node: parameter, inherited: true });
        for (const parameter of operationParameters) mergedParameters.set(parameterKey(parameter), { node: parameter, inherited: false });
        for (const [index, parameter] of [...mergedParameters.values()].entries()) projectParameter(parameter.node, `${path}/${upperMethod}/parameters/${index}`, sourceOperation, parameter.inherited);
        const requestBody = get(operation, 'requestBody');
        if (requestBody) projectBody(requestBody, `${path}/${upperMethod}/requestBody`, sourceOperation, 'api_request_body', 'accepts');
        for (const [status, response] of mapPairs(get(operation, 'responses'))) projectBody(response, `${path}/${upperMethod}/responses/${escapePointer(status)}`, sourceOperation, 'api_response', 'returns', status);
      }
    }
    function parameterKey(parameter: YamlNode) {
      const ref = valueAt(parameter, '$ref');
      const target = typeof ref === 'string' ? resolveJsonPointer(doc.root, ref) : undefined;
      const source = target ?? parameter;
      return `${valueAt(source, 'in') ?? ''}\0${valueAt(source, 'name') ?? (typeof ref === 'string' ? ref : '')}`;
    }
    function dereferencePathItem(input: YamlNode, path: string): Array<[string, YamlNode]> | undefined {
      const layers: YamlNode[] = [input];
      const seen = new Set<string>();
      let current = input;
      for (let depth = 0; depth < MAX_REF_DEPTH; depth++) {
        const ref = valueAt(current, '$ref');
        if (typeof ref !== 'string') break;
        if (!ref.startsWith('#/')) { diag('OPENAPI_EXTERNAL_REF_UNRESOLVED', `Path item reference '${ref}' was not followed.`, doc.file.path); return undefined; }
        if (seen.has(ref)) { diag('OPENAPI_REF_CYCLE', `Path item reference cycle at '${ref}' was not expanded.`, doc.file.path); return undefined; }
        seen.add(ref);
        const target = resolveJsonPointer(doc.root, ref);
        if (!target || !isMap(target)) { diag('OPENAPI_LOCAL_REF_UNRESOLVED', `Path item reference '${ref}' does not resolve to an object.`, doc.file.path); return undefined; }
        layers.push(target); current = target;
      }
      if (valueAt(current, '$ref') !== undefined) { diag('OPENAPI_REF_DEPTH_LIMIT', `Path item reference depth exceeds ${MAX_REF_DEPTH} at '${path}'.`, doc.file.path); return undefined; }
      const merged = new Map<string, YamlNode>();
      for (const layer of [...layers].reverse()) for (const [key, value] of pairs(layer)) if (key !== '$ref') merged.set(key, value);
      return [...merged.entries()];
    }
    function projectParameter(parameter: YamlNode, key: string, endpoint: GraphNode, inherited = false) {
      const reference = valueAt(parameter, '$ref');
      if (typeof reference === 'string') {
        const referenceNode = addOwnerReference(reference, parameter, endpoint, key);
        const resolved = resolveJsonPointer(doc.root, reference);
        if (!resolved || !isMap(resolved)) { diag('OPENAPI_LOCAL_REF_UNRESOLVED', `Parameter reference '${reference}' is unresolved or does not identify an object.`, doc.file.path); return; }
        parameter = resolved;
      }
      const name = valueAt(parameter, 'name'), location = valueAt(parameter, 'in');
      const contentTypes = mapPairs(get(parameter, 'content')).map(([contentType]) => contentType);
      const p = node(doc, 'api_parameter', key, typeof name === 'string' ? name : 'parameter', { ...(typeof name === 'string' ? { name } : {}), ...(typeof location === 'string' ? { in: location } : {}), required: location === 'path' ? true : valueAt(parameter, 'required'), description: valueAt(parameter, 'description'), style: valueAt(parameter, 'style'), explode: valueAt(parameter, 'explode'), ...(contentTypes.length ? { contentTypes } : {}) }, doc.evidence(parameter, 'parameter'));
      edge(doc, endpoint, p, 'accepts', key, doc.evidence(parameter, 'parameter'), {}, inherited ? 'DERIVED' : 'DIRECT');
      const schema = get(parameter, 'schema'); if (schema) addSchemaReference(schema, p, key);
      for (const [contentType, media] of mapPairs(get(parameter, 'content'))) { const bodySchema = get(media, 'schema'); if (bodySchema) addSchemaReference(bodySchema, p, `${key}/${contentType}`, contentType); }
    }
    function projectSecurity(security: YamlNode | undefined, owner: GraphNode, key: string, inherited = false) {
      if (!security) return;
      if (!isSeq(security)) { diag('OPENAPI_INVALID_SECURITY', `Security value at '${key}' must be an array.`, doc.file.path); return; }
      for (const [index, requirement] of getSeq(security).entries()) {
        if (!isMap(requirement)) { diag('OPENAPI_INVALID_SECURITY', `Security requirement '${key}/${index}' must be an object.`, doc.file.path); continue; }
        const reqNode = node(doc, 'api_security_requirement', `${key}/${index}`, `security alternative ${index + 1}`, { alternative: index }, doc.evidence(requirement, 'security-requirement'), inherited ? 'DERIVED' : 'DIRECT');
        edge(doc, owner, reqNode, 'secured_by', `${key}/${index}`, doc.evidence(requirement, 'security-requirement'), {}, inherited ? 'DERIVED' : 'DIRECT');
        for (const [schemeName, scopesNode] of mapPairs(requirement)) {
          const target = schemes.get(schemeName);
          const unresolved = !target;
          const actual = target ?? node(doc, 'api_security_scheme', `unresolved-security/${hash(schemeName)}`, schemeName, { name: schemeName, resolved: false }, doc.evidence(requirement, 'unresolved-security-scheme'));
          if (unresolved) diag('OPENAPI_SECURITY_SCHEME_UNRESOLVED', `Security requirement references unknown scheme '${schemeName}'.`, doc.file.path);
          const validScopes = isSeq(scopesNode);
          if (!validScopes) diag('OPENAPI_INVALID_SECURITY', `Scopes for security scheme '${schemeName}' must be an array.`, doc.file.path);
          const scopes = getSeq(scopesNode).map((scope) => getScalar(scope));
          if (scopes.length > 256) throw new Error(`Security scopes for '${schemeName}' exceed 256 entries.`);
          if (scopes.some((scope) => typeof scope !== 'string')) diag('OPENAPI_INVALID_SECURITY', `Scopes for security scheme '${schemeName}' must contain strings.`, doc.file.path);
          edge(doc, reqNode, actual, 'uses_scheme', `${key}/${index}/${schemeName}`, doc.evidence(requirement, 'security-requirement'), { scopes: scopes.filter((scope): scope is string => typeof scope === 'string'), resolved: !unresolved && validScopes && scopes.every((scope) => typeof scope === 'string') }, inherited ? 'DERIVED' : 'DIRECT');
        }
      }
    }
    function projectServers(servers: YamlNode | undefined, owner: GraphNode, key: string): GraphNode[] {
      if (!servers) return [];
      if (!isSeq(servers)) { diag('OPENAPI_INVALID_SERVERS', `Servers at '${key}' must be an array.`, doc.file.path); return []; }
      const result: GraphNode[] = [];
      for (const [index, server] of getSeq(servers).entries()) {
        const url = valueAt(server, 'url');
        if (typeof url !== 'string') { diag('OPENAPI_INVALID_SERVER', `Server at '${key}/${index}' has no literal URL.`, doc.file.path); continue; }
        const serverNode = node(doc, 'openapi_server', `${key}/${index}`, url, { url, description: valueAt(server, 'description') }, doc.evidence(server, 'server'));
        serverSources.set(serverNode.id, doc.evidence(server, 'server')!);
        edge(doc, owner, serverNode, 'uses_server', `${key}/${index}`, doc.evidence(server, 'server'));
        result.push(serverNode);
      }
      return result;
    }
    function projectBody(body: YamlNode, key: string, endpoint: GraphNode, kind: string, edgeKind: string, status?: string) {
      const reference = valueAt(body, '$ref');
      if (typeof reference === 'string') {
        addOwnerReference(reference, body, endpoint, key);
        const resolved = resolveJsonPointer(doc.root, reference);
        if (!resolved || !isMap(resolved)) { diag('OPENAPI_LOCAL_REF_UNRESOLVED', `${kind} reference '${reference}' is unresolved or does not identify an object.`, doc.file.path); return; }
        body = resolved;
      }
      const content = get(body, 'content');
      const contentTypes = mapPairs(content).map(([contentType]) => contentType);
      const target = node(doc, kind, key, status ?? (kind === 'api_request_body' ? 'request body' : 'response'), { ...(status ? { status } : {}), description: valueAt(body, 'description'), required: valueAt(body, 'required'), ...(contentTypes.length ? { contentTypes } : {}) }, doc.evidence(body, kind));
      edge(doc, endpoint, target, edgeKind, key, doc.evidence(body, kind));
      for (const [contentType, media] of mapPairs(content)) { const schema = get(media, 'schema'); if (schema) addSchemaReference(schema, target, `${key}/${contentType}`, contentType); }
    }
    function addSchemaReference(schema: YamlNode, owner: GraphNode, key: string, mediaType?: string, createInline = true) {
      const seen = new Set<YamlNode>();
      const walk = (current: YamlNode, suffix: string, depth: number) => {
        if (seen.has(current)) return;
        seen.add(current);
        if (depth > MAX_REF_DEPTH) { diag('OPENAPI_SCHEMA_DEPTH_LIMIT', `Schema nesting exceeds ${MAX_REF_DEPTH} at '${key}'.`, doc.file.path); return; }
        const ref = valueAt(current, '$ref');
        if (typeof ref === 'string') { const target = node(doc, 'api_schema_reference', `refs/${hash(ref)}`, ref, { ref, referenceKind: 'static', sourcePath: doc.file.path }, doc.evidence(current, 'schema-reference')); edge(doc, owner, target, 'uses_schema', `${key}${suffix}`, doc.evidence(current, 'schema-reference'), mediaType ? { mediaType } : {}); }
        const typ = jsonValueAt(current, 'type');
        if (depth === 0 && createInline && typeof ref !== 'string') {
          const properties = isScalar(current) ? { schemaValue: scalar(current) } : safeProperties(current);
          const inline = node(doc, 'openapi_schema', `${key}/inline`, Array.isArray(typ) ? 'union schema' : typeof typ === 'string' ? typ : 'inline schema', properties, doc.evidence(current, 'inline-schema'));
          edge(doc, owner, inline, 'uses_schema', key, doc.evidence(current, 'inline-schema'), mediaType ? { mediaType } : {});
        }
        for (const keyword of ['items', 'additionalProperties', 'not']) { const child = get(current, keyword); if (child) walk(child, `${suffix}/${keyword}`, depth + 1); }
        for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) for (const [index, child] of getSeq(get(current, keyword)).entries()) walk(child, `${suffix}/${keyword}/${index}`, depth + 1);
        for (const [name, child] of mapPairs(get(current, 'properties'))) walk(child, `${suffix}/properties/${escapePointer(name)}`, depth + 1);
      };
      walk(schema, '', 0);
    }
    function collectReferences(document: OpenApiDocument, owner: GraphNode) {
      const walk = (current: YamlNode, pointer: string, depth: number) => {
        if (depth > 64) throw new Error(`Reference traversal exceeds depth 64 in '${document.file.path}'.`);
        if (isMap(current)) {
          for (const [name, child] of pairs(current)) {
            const childPointer = `${pointer}/${escapePointer(name)}`;
            if (name === '$ref' || name === '$dynamicRef') {
              const ref = getScalar(child);
              if (typeof ref === 'string') {
              const reference = node(document, 'api_schema_reference', `refs/${hash(ref)}`, ref, { ref, referenceKind: name === '$dynamicRef' ? 'dynamic' : 'static', sourcePath: document.file.path }, document.evidence(child, 'reference'));
                edge(document, owner, reference, 'references', `ref:${childPointer}`, document.evidence(child, 'reference'));
              }
            } else walk(child, childPointer, depth + 1);
          }
        } else if (isSeq(current)) {
          for (const [index, child] of getSeq(current).entries()) walk(child, `${pointer}/${index}`, depth + 1);
        }
      };
      walk(document.root, '', 0);
    }
    function addOwnerReference(ref: string, sourceNode: YamlNode, owner: GraphNode, key: string) {
      const referenceNode = node(doc, 'api_schema_reference', `refs/${hash(ref)}`, ref, { ref, referenceKind: 'static', sourcePath: doc.file.path }, doc.evidence(sourceNode, 'reference'));
      edge(doc, owner, referenceNode, 'references', `owner-ref:${key}`, doc.evidence(sourceNode, 'reference'));
      return referenceNode;
    }
    function valueAt(node: YamlNode | undefined, key: string): unknown { return safeValue(getScalar(get(node, key))) ? getScalar(get(node, key)) : undefined; }
    function jsonValueAt(node: YamlNode | undefined, key: string): unknown { const child = get(node, key); if (!child || !('toJSON' in child)) return undefined; const value = (child as YamlNode & { toJSON(): unknown }).toJSON(); if (!safeValue(value)) throw new Error(`OpenAPI schema property '${key}' exceeds output limits.`); return value; }
    function safeProperties(node: YamlNode): Record<string, unknown> { const allowed = new Set(['type', 'format', 'description', 'title', 'nullable', 'deprecated', 'readOnly', 'writeOnly', 'enum', 'required', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'additionalProperties', 'name', 'in', 'style', 'explode', 'allowEmptyValue', 'allowReserved', 'contentType', 'scheme', 'bearerFormat', 'openIdConnectUrl']); const out: Record<string, unknown> = {}; for (const [key, value] of mapPairs(node)) { if (!allowed.has(key)) continue; const v = value.toJSON(); if (key === 'additionalProperties' && typeof v !== 'boolean') continue; if (!safeValue(v)) throw new Error(`OpenAPI schema property '${key}' exceeds output limits.`); if (!schemaSafeValue(key, v)) continue; out[key] = v; } return out; }
  }
}

function resolveReferences(doc: OpenApiDocument, nodes: GraphNode[], evidence: AnalysisEvidence[], addNode: (doc: OpenApiDocument, kind: string, key: string, label: string, props: Record<string, unknown>, source?: AnalysisEvidence, level?: 'DIRECT' | 'DERIVED') => GraphNode, addEdge: (doc: OpenApiDocument, from: GraphNode, to: GraphNode, kind: string, key: string, source?: AnalysisEvidence, props?: Record<string, unknown>, level?: 'DIRECT' | 'DERIVED') => void, addDiag: (code: string, message: string, uri?: string, line?: number) => void) {
  const byRef = new Map<string, GraphNode>();
  for (const node of nodes) if (node.workspaceId && node.properties.sourcePath === doc.file.path && typeof node.properties.componentType === 'string') {
    const componentName = typeof node.properties.componentName === 'string' ? node.properties.componentName : node.properties.name;
    if (typeof componentName === 'string') byRef.set(`#/components/${node.properties.componentType}/${escapePointer(componentName)}`, node);
  }
  for (const node of [...nodes]) if (node.kind === 'api_schema_reference' && node.properties.sourcePath === doc.file.path && typeof node.properties.ref === 'string') {
    const ref = node.properties.ref;
    const source = evidence.find((item) => item.subjectId === node.id);
    if (node.properties.referenceKind === 'dynamic') { node.properties.resolved = false; node.properties.resolution = 'dynamic-unresolved'; addDiag('OPENAPI_DYNAMIC_REF_UNRESOLVED', `Dynamic reference '${ref}' was not expanded.`, source?.uri ?? doc.file.path, source?.line); continue; }
    if (!ref.startsWith('#/')) { node.properties.resolved = false; node.properties.resolution = 'external'; addDiag('OPENAPI_EXTERNAL_REF_UNRESOLVED', `Reference '${ref}' was not followed because only local JSON Pointers are supported.`, source?.uri ?? doc.file.path, source?.line); continue; }
    let decoded: string;
    try { decoded = ref.slice(2).split('/').map((part) => decodePointer(part)).join('/'); } catch { node.properties.resolved = false; node.properties.resolution = 'invalid-pointer'; addDiag('OPENAPI_INVALID_REF', `Reference '${ref}' has invalid JSON Pointer escaping.`, source?.uri ?? doc.file.path, source?.line); continue; }
    const target = byRef.get(ref);
    node.properties.resolved = !!target;
    node.properties.resolution = target ? 'local' : 'unresolved';
    if (target) addEdge(doc, node, target, 'references', `resolve:${ref}`, source, { ref, resolved: true }, 'DERIVED');
    else { node.properties.pointer = decoded; addDiag('OPENAPI_LOCAL_REF_UNRESOLVED', `Local reference '${ref}' does not resolve to a discovered component.`, source?.uri ?? doc.file.path, source?.line); }
  }
}
function stringAt(doc: OpenApiDocument, root: YamlNode, path: string[]) { let current: YamlNode | undefined = root; for (const part of path) current = property(current, part); const value = scalar(current); return typeof value === 'string' ? value : undefined; }
function valueAt(node: YamlNode, key: string) { return scalar(property(node, key)); }
function pairValue(items: Array<[string, YamlNode]>, key: string) { return items.find(([name]) => name === key)?.[1]; }
function resolveJsonPointer(root: YamlNode, ref: string): YamlNode | undefined {
  if (ref === '#') return root;
  if (!ref.startsWith('#/') || ref.length > 4096) return undefined;
  const tokens = ref.slice(2).split('/');
  if (tokens.length > MAX_REF_DEPTH) return undefined;
  let current: YamlNode = root;
  for (const token of tokens) {
    let key: string; try { key = decodePointer(token); } catch { return undefined; }
    if (isMap(current)) { const found = pairs(current).find(([name]) => name === key); if (!found) return undefined; current = found[1]; }
    else if (isSeq(current) && /^(0|[1-9][0-9]*)$/.test(key)) { const found = seq(current)[Number(key)]; if (!found) return undefined; current = found; }
    else return undefined;
  }
  return current;
}
function safeValue(value: unknown, depth = 0): value is null | string | number | boolean | unknown[] | Record<string, unknown> { if (depth > 16) return false; if (value === null || typeof value === 'boolean') return true; if (typeof value === 'string') return value.length <= 10_000; if (typeof value === 'number') return Number.isFinite(value); if (Array.isArray(value)) return value.length <= 10_000 && value.every((item) => safeValue(item, depth + 1)); if (value && typeof value === 'object') { const entries = Object.entries(value); return entries.length <= 10_000 && entries.every(([key, item]) => key.length <= 10_000 && safeValue(item, depth + 1)); } return false; }
function schemaSafeValue(key: string, value: unknown) { if (key === 'type' || key === 'required') return typeof value === 'string' || Array.isArray(value) && value.every((item) => typeof item === 'string'); if (key === 'enum') return Array.isArray(value) && value.every((item) => item === null || ['string', 'boolean', 'number'].includes(typeof item)); return safeValue(value); }
function arrayAt(node: YamlNode, key: string) { const value = property(node, key); if (!value) return undefined; if (!('items' in value) || !Array.isArray((value as { items?: unknown }).items)) throw new Error(`OpenAPI '${key}' must be a string array.`); const result = (value as { items: YamlNode[] }).items.map((item) => scalar(item)); if (result.length > 256 || result.some((item) => typeof item !== 'string' || item.length > 10_000)) throw new Error(`OpenAPI string array '${key}' is invalid or exceeds its limits.`); return result as string[]; }
function safeProperties(node: YamlNode) { const value = node.toJSON(); const allowed = new Set(['type', 'format', 'description', 'title', 'nullable', 'deprecated', 'readOnly', 'writeOnly', 'enum', 'required', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'additionalProperties', 'name', 'in', 'style', 'explode', 'allowEmptyValue', 'allowReserved', 'contentType', 'scheme', 'bearerFormat', 'openIdConnectUrl']); if (!value || typeof value !== 'object' || Array.isArray(value)) return {}; const result: Record<string, unknown> = {}; for (const [key, item] of Object.entries(value)) { if (!allowed.has(key) || key === 'additionalProperties' && typeof item !== 'boolean') continue; if (!safeValue(item)) throw new Error(`OpenAPI property '${key}' exceeds output limits.`); result[key] = item; } return result; }
function cleanProperties(value: Record<string, unknown>) { const result: Record<string, unknown> = {}; for (const [key, item] of Object.entries(value)) { if (item === undefined) continue; if (!safeValue(item)) throw new Error(`OpenAPI graph property '${key}' exceeds output limits.`); result[key] = item; } return result; }
function escapePointer(value: string) { return value.replace(/~/g, '~0').replace(/\//g, '~1'); }
function decodePointer(value: string) { if (/~(?![01])/.test(value)) throw new Error('bad pointer'); return value.replace(/~1/g, '/').replace(/~0/g, '~'); }
function hash(value: string) { return idsHash(value); }
function idsHash(value: string) { return createHash('sha256').update(value).digest('hex'); }
