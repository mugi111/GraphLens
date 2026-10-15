import { AnalysisError, type AnalysisContext, type AnalysisDiagnostic, type AnalysisEvidence, type Analyzer, type AnalysisResult } from '../../domain/analyzer.js';
import type { GraphEdge, GraphNode } from '../../domain/graph.js';
import { apiEndpointUri, apiPathShape } from '../../core/api-identity.js';
import { GraphIdentityFactory } from '../../core/graph-identity.js';
import type { Node as YamlNode } from 'yaml';
import { readOpenApiSnapshot, openApiConfig } from './openapi-source.js';
import { diagnosticsForDocument, pairs, parseOpenApiDocument, property, scalar, seq, type OpenApiDocument } from './openapi-document.js';

const ids = new GraphIdentityFactory();
const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const MAX_CONTRIBUTIONS = 9000;
const MAX_EVIDENCE = 10_000;
const MAX_REF_DEPTH = 32;

export const openApiAnalyzer: Analyzer = {
  descriptor: { id: 'builtin.openapi', version: '1.0.0', apiVersion: '1', capabilities: ['graph', 'evidence', 'diagnostics'] },
  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    try { return await analyze(context); }
    catch (error) {
      if (error instanceof AnalysisError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const code = /apiNamespace|include|excludes|maxFiles|maxFileBytes|maxTotalBytes|Unsupported OpenAPI option/.test(message) ? 'OPENAPI_INVALID_CONFIG' : /exceeds|limit|inventory/i.test(message) ? 'OPENAPI_LIMIT_EXCEEDED' : /UTF-8/i.test(message) ? 'OPENAPI_INVALID_ENCODING' : 'OPENAPI_ANALYSIS_FAILED';
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
  const addEvidence = (subjectKind: 'node' | 'edge', subjectId: string, type: string, doc: OpenApiDocument, source: AnalysisEvidence | undefined, anchor: string) => {
    const id = ids.node(subjectId, `evidence:${subjectKind}`, `${type}:${anchor}`);
    if (evidenceSet.has(id)) return;
    evidenceSet.add(id); evidence.push({ ...(source ?? { id: '', subjectKind, subjectId, level: 'DIRECT', type }), id, subjectKind, subjectId }); enforce();
  };
  const addNode = (doc: OpenApiDocument, kind: string, key: string, label: string, props: Record<string, unknown>, source: AnalysisEvidence | undefined, level: 'DIRECT' | 'DERIVED' = 'DIRECT') => {
    const id = ids.node(context.workspace.id, `openapi://${encodeURIComponent(doc.file.path)}#${key}`, kind);
    let node = nodeMap.get(id);
    if (!node) { node = { id, workspaceId: context.workspace.id, kind, label, properties: props }; nodeMap.set(id, node); nodes.push(node); }
    addEvidence('node', id, `openapi.${kind}`, doc, source, key); enforce(); return node;
  };
  const addEdge = (doc: OpenApiDocument, from: GraphNode, to: GraphNode, kind: string, key: string, source?: AnalysisEvidence, props: Record<string, unknown> = {}, level: 'DIRECT' | 'DERIVED' = 'DIRECT') => {
    const id = ids.edge(context.workspace.id, from.id, to.id, kind);
    if (edgeSet.has(id)) return;
    edgeSet.add(id); edges.push({ id, workspaceId: context.workspace.id, sourceId: from.id, targetId: to.id, kind, properties: props });
    addEvidence('edge', id, `openapi.${kind}`, doc, source, key); enforce();
  };

  const documents: OpenApiDocument[] = [];
  for (const file of snapshot.files) {
    const document = parseOpenApiDocument(file);
    const version = document.value.openapi;
    if (typeof version !== 'string' || !/^3\.(?:0|1|2)(?:\.\d+)?$/.test(version)) { diagnostics.push(...diagnosticsForDocument(file)); continue; }
    documents.push(document);
  }
  for (const doc of documents) projectDocument(doc, config.apiNamespace, addNode, addEdge, addDiag, property, pairs, scalar, seq);
  // Resolve only in-memory JSON Pointers. External and malformed references remain explicit nodes.
  for (const doc of documents) resolveReferences(doc, nodes, addNode, addEdge, addDiag);
  enforce();
  return { sourceRevision: snapshot.sourceRevision, nodes, edges, evidence, diagnostics };

  function projectDocument(doc: OpenApiDocument, namespace: string, node: typeof addNode, edge: typeof addEdge, diag: typeof addDiag, get: typeof property, mapPairs: typeof pairs, getScalar: typeof scalar, getSeq: typeof seq) {
    const root = node(doc, 'openapi_document', 'document', doc.file.path, { path: doc.file.path, openapi: doc.value.openapi, title: stringAt(doc, doc.root, ['info', 'title']), version: stringAt(doc, doc.root, ['info', 'version']) }, doc.evidence(doc.root, 'document'));
    const components = get(doc.root, 'components');
    for (const [name, schema] of mapPairs(get(components, 'schemas'))) {
      const props: Record<string, unknown> = { name };
      for (const key of ['type', 'format', 'description', 'title', 'nullable', 'deprecated', 'readOnly', 'writeOnly', 'enum', 'required', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'additionalProperties']) {
        const v = valueAt(schema, key); if (safeValue(v)) props[key] = v;
      }
      if (typeof valueAt(schema, '$ref') === 'string') props.ref = valueAt(schema, '$ref');
      const schemaNode = node(doc, 'openapi_schema', `components/schemas/${escapePointer(name)}`, name, props, doc.evidence(schema, 'schema'));
      edge(doc, root, schemaNode, 'contains', `schema:${name}`, doc.evidence(schema, 'schema'));
      for (const [propertyName, propertyNode] of mapPairs(get(schema, 'properties'))) {
        const property = node(doc, 'api_schema_property', `components/schemas/${escapePointer(name)}/properties/${escapePointer(propertyName)}`, propertyName, safeProperties(propertyNode), doc.evidence(propertyNode, 'schema-property'));
        edge(doc, schemaNode, property, 'contains', `schema-property:${name}:${propertyName}`, doc.evidence(propertyNode, 'schema-property'));
        const ref = valueAt(propertyNode, '$ref');
        if (typeof ref === 'string') { const reference = node(doc, 'api_schema_reference', `refs/${hash(ref)}`, ref, { ref }, doc.evidence(propertyNode, 'schema-reference')); edge(doc, property, reference, 'uses_schema', `schema-ref:${name}:${propertyName}`, doc.evidence(propertyNode, 'schema-reference')); }
      }
    }
    const paths = get(doc.root, 'paths');
    for (const [path, pathItem] of mapPairs(paths)) {
      if (!path.startsWith('/')) { diag('OPENAPI_INVALID_PATH', `Path '${path}' must begin with '/'.`, doc.file.path); continue; }
      for (const [method, operation] of mapPairs(pathItem)) {
        if (!methods.has(method.toLowerCase())) continue;
        const upperMethod = method.toUpperCase();
        const uri = apiEndpointUri(namespace, upperMethod, path);
        const endpoint = node(doc, 'api_endpoint', uri, `${upperMethod} ${path}`, { namespace, method: upperMethod, path, pathShape: apiPathShape(path), operationId: valueAt(operation, 'operationId'), summary: valueAt(operation, 'summary'), description: valueAt(operation, 'description'), deprecated: valueAt(operation, 'deprecated'), tags: stringArray(valueAt(operation, 'tags')) }, doc.evidence(operation, 'operation'));
        edge(doc, root, endpoint, 'contains', `operation:${upperMethod}:${path}`, doc.evidence(operation, 'operation'));
        for (const [index, parameter] of getSeq(get(operation, 'parameters')).entries()) projectParameter(parameter, `${path}/${upperMethod}/parameters/${index}`, endpoint);
        const requestBody = get(operation, 'requestBody');
        if (requestBody) projectBody(requestBody, `${path}/${upperMethod}/requestBody`, endpoint, 'api_request_body', 'accepts');
        for (const [status, response] of mapPairs(get(operation, 'responses'))) projectBody(response, `${path}/${upperMethod}/responses/${escapePointer(status)}`, endpoint, 'api_response', 'returns', status);
      }
    }
    function projectParameter(parameter: YamlNode, key: string, endpoint: GraphNode) {
      const name = valueAt(parameter, 'name'), location = valueAt(parameter, 'in');
      const p = node(doc, 'api_parameter', key, typeof name === 'string' ? name : 'parameter', { ...(typeof name === 'string' ? { name } : {}), ...(typeof location === 'string' ? { in: location } : {}), required: valueAt(parameter, 'required'), description: valueAt(parameter, 'description'), style: valueAt(parameter, 'style'), explode: valueAt(parameter, 'explode') }, doc.evidence(parameter, 'parameter'));
      edge(doc, endpoint, p, 'accepts', key, doc.evidence(parameter, 'parameter'));
      const schema = get(parameter, 'schema'); if (schema) addSchemaReference(schema, p, key);
      for (const [contentType, media] of mapPairs(get(parameter, 'content'))) { const bodySchema = get(media, 'schema'); if (bodySchema) addSchemaReference(bodySchema, p, `${key}/${contentType}`); }
    }
    function projectBody(body: YamlNode, key: string, endpoint: GraphNode, kind: string, edgeKind: string, status?: string) {
      const target = node(doc, kind, key, status ?? (kind === 'api_request_body' ? 'request body' : 'response'), { ...(status ? { status } : {}), description: valueAt(body, 'description'), required: valueAt(body, 'required') }, doc.evidence(body, kind));
      edge(doc, endpoint, target, edgeKind, key, doc.evidence(body, kind));
      for (const [contentType, media] of mapPairs(get(body, 'content'))) { const schema = get(media, 'schema'); if (schema) addSchemaReference(schema, target, `${key}/${contentType}`); }
    }
    function addSchemaReference(schema: YamlNode, owner: GraphNode, key: string) {
      const ref = valueAt(schema, '$ref');
      if (typeof ref === 'string') { const target = node(doc, 'api_schema_reference', `refs/${hash(ref)}`, ref, { ref }, doc.evidence(schema, 'schema-reference')); edge(doc, owner, target, 'uses_schema', key, doc.evidence(schema, 'schema-reference')); }
      else { const typ = valueAt(schema, 'type'); if (typeof typ === 'string') { const inline = node(doc, 'openapi_schema', `${key}/inline`, typ, safeProperties(schema), doc.evidence(schema, 'inline-schema')); edge(doc, owner, inline, 'uses_schema', key, doc.evidence(schema, 'inline-schema')); } }
    }
    function valueAt(node: YamlNode | undefined, key: string): unknown { return safeValue(getScalar(get(node, key))) ? getScalar(get(node, key)) : undefined; }
    function safeProperties(node: YamlNode): Record<string, unknown> { const out: Record<string, unknown> = {}; for (const [key, value] of mapPairs(node)) { const v = value.toJSON(); if (safeValue(v)) out[key] = v; } return out; }
  }
}

function resolveReferences(doc: OpenApiDocument, nodes: GraphNode[], addNode: (doc: OpenApiDocument, kind: string, key: string, label: string, props: Record<string, unknown>, source?: AnalysisEvidence, level?: 'DIRECT' | 'DERIVED') => GraphNode, addEdge: (doc: OpenApiDocument, from: GraphNode, to: GraphNode, kind: string, key: string, source?: AnalysisEvidence, props?: Record<string, unknown>, level?: 'DIRECT' | 'DERIVED') => void, addDiag: (code: string, message: string, uri?: string, line?: number) => void) {
  const byRef = new Map<string, GraphNode>();
  for (const node of nodes) if (node.workspaceId && node.kind === 'openapi_schema' && typeof node.properties.name === 'string') byRef.set(`#/components/schemas/${escapePointer(node.properties.name)}`, node);
  for (const node of [...nodes]) if (node.kind === 'api_schema_reference' && typeof node.properties.ref === 'string') {
    const ref = node.properties.ref;
    if (!ref.startsWith('#/')) { addDiag('OPENAPI_EXTERNAL_REF_UNRESOLVED', `Reference '${ref}' was not followed because only local JSON Pointers are supported.`, doc.file.path); continue; }
    let decoded: string;
    try { decoded = ref.slice(2).split('/').map((part) => decodePointer(part)).join('/'); } catch { addDiag('OPENAPI_INVALID_REF', `Reference '${ref}' has invalid JSON Pointer escaping.`, doc.file.path); continue; }
    const target = byRef.get(ref);
    if (target) addEdge(doc, node, target, 'references', `resolve:${ref}`, undefined, { ref, resolved: true }, 'DERIVED');
    else { addNode(doc, 'api_schema_reference', `unresolved/${hash(ref)}`, ref, { ref, resolved: false, pointer: decoded }, undefined, 'DERIVED'); addDiag('OPENAPI_LOCAL_REF_UNRESOLVED', `Local reference '${ref}' does not resolve to a discovered schema.`, doc.file.path); }
  }
}
function stringAt(doc: OpenApiDocument, root: YamlNode, path: string[]) { let current: YamlNode | undefined = root; for (const part of path) current = property(current, part); const value = scalar(current); return typeof value === 'string' ? value : undefined; }
function valueAt(node: YamlNode, key: string) { return scalar(property(node, key)); }
function safeValue(value: unknown): value is string | number | boolean | null | string[] { return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (Array.isArray(value) && value.length <= 256 && value.every((item) => typeof item === 'string')); }
function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 256) : undefined; }
function safeProperties(node: YamlNode) { const value = node.toJSON(); return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => safeValue(item))) : {}; }
function escapePointer(value: string) { return value.replace(/~/g, '~0').replace(/\//g, '~1'); }
function decodePointer(value: string) { if (/~(?![01])/.test(value)) throw new Error('bad pointer'); return value.replace(/~1/g, '/').replace(/~0/g, '~'); }
function hash(value: string) { return idsHash(value); }
function idsHash(value: string) { return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128); }
