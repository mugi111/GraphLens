import { createHash } from 'node:crypto';
import type { AnalysisContext, AnalysisDiagnostic, AnalysisEvidence } from '../../domain/analyzer.js';
import type { SourceCatalogSnapshot } from '../../domain/source-identity.js';
import type { GraphNode } from '../../domain/graph.js';
import { GraphIdentityFactory } from '../../core/graph-identity.js';
const ids = new GraphIdentityFactory();

/** Enforces the v2 source contract before a semantic analyzer emits cross-analyzer facts. */
export function requireSourceCatalog(context: AnalysisContext, files: Array<{ path: string; source: string; hash: string }>): SourceCatalogSnapshot {
  const catalog = context.sourceCatalogReader?.snapshot();
  if (!catalog || catalog.identityVersion !== 2 || catalog.provider !== 'codegraph' || catalog.providerVersion !== '1.6.2' || catalog.coordinateConvention !== 'provider-raw' || catalog.declarationAnchorConvention !== 'exact-tuple-runtime-validation-only' || catalog.workspaceId !== context.workspace.id || catalog.input.analyzerId !== 'builtin.codegraph') {
    throw new Error('A current CodeGraph 1.6.2 identity-v2 source catalog is required. Run builtin.codegraph for this workspace first.');
  }
  const byPath = new Map(catalog.files.map((file) => [file.relativePath, file]));
  for (const file of files) {
    const entry = byPath.get(file.path);
    if (!entry) throw new Error(`CodeGraph source catalog is missing scanned file '${file.path}'.`);
    const providerTextDigest = createHash('sha256').update(Buffer.from(file.source, 'utf8')).digest('hex');
    const rawByteDigest = createHash('sha256').update(file.bytes).digest('hex');
    const providerDigest = entry.contentDigest.value.toLowerCase();
    if (file.hash !== rawByteDigest || entry.repositoryKey !== catalog.repositoryKey || (providerDigest !== providerTextDigest && providerDigest !== rawByteDigest)) throw new Error(`CodeGraph source catalog is stale or uses an unsupported digest for '${file.path}'.`);
    if (!/^[a-f0-9]{64}$/.test(file.hash)) throw new Error(`Raw-byte digest is invalid for '${file.path}'.`);
  }
  return catalog;
}
/** Remaps only exact declaration anchors; ambiguous or absent declarations remain semantic-only facts. */
export function adoptDeclarationIdentities(workspaceId: string, catalog: SourceCatalogSnapshot, nodes: GraphNode[], edges: GraphEdge[], evidence: AnalysisEvidence[], diagnostics: AnalysisDiagnostic[]) {
  const replacements = new Map<string, string>();
  const evidenceByNode = new Map(evidence.filter((item) => item.subjectKind === 'node').map((item) => [item.subjectId, item]));
  const fileByPath = new Map(catalog.files.map((file) => [file.relativePath, file]));
  for (const node of nodes) {
    if (node.kind !== 'python_class' && node.kind !== 'python_function' && node.kind !== 'python_async_function') continue;
    const source = evidenceByNode.get(node.id);
    const path = node.properties.path;
    if (!source || typeof path !== 'string' || !fileByPath.has(path)) continue;
    const compatible = node.kind === 'python_class' ? new Set(['code.class']) : new Set(['code.function']);
    const matches = catalog.symbols.filter((symbol) => symbol.relativePath === path && compatible.has(symbol.kind) && symbol.startLine === source.line && symbol.startColumn === source.column && symbol.endLine === source.endLine && symbol.endColumn === source.endColumn);
    if (matches.length !== 1 || matches[0]!.name !== node.label) {
      diagnostics.push({ code: matches.length > 1 ? 'CODEGRAPH_SOURCE_ANCHOR_AMBIGUOUS' : 'CODEGRAPH_SOURCE_ANCHOR_UNVERIFIED', severity: 'warning', message: `Source declaration '${node.label}' in '${path}' has no unique exact CodeGraph declaration anchor.`, uri: path, line: source.line });
      node.properties.sourceMapping = 'unverified';
      continue;
    }
    replacements.set(node.id, matches[0]!.nodeId);
    node.properties.codegraphKind = matches[0]!.kind;
  }
  for (const node of nodes) if (replacements.has(node.id)) node.id = replacements.get(node.id)!;
  const edgeIds = new Map<string, string>();
  for (const edge of edges) {
    const oldId = edge.id, sourceId = edge.sourceId, targetId = edge.targetId;
    edge.sourceId = replacements.get(sourceId) ?? sourceId;
    edge.targetId = replacements.get(targetId) ?? targetId;
    if (sourceId !== edge.sourceId || targetId !== edge.targetId) { edge.id = ids.relationship(workspaceId, edge.sourceId, edge.targetId, edge.kind); edgeIds.set(oldId, edge.id); }
  }
  for (const item of evidence) {
    const oldSubject = item.subjectId;
    item.subjectId = item.subjectKind === 'edge' ? edgeIds.get(oldSubject) ?? oldSubject : replacements.get(oldSubject) ?? oldSubject;
    if (oldSubject !== item.subjectId) item.id = ids.node(item.subjectId, `evidence:${item.subjectKind}`, item.type);
  }
  return replacements;
}
