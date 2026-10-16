import { createHash } from 'node:crypto';
import type { AnalysisContext, AnalysisDiagnostic, AnalysisEvidence } from '../../domain/analyzer.js';
import type { SourceCatalogSnapshot } from '../../domain/source-identity.js';
import type { GraphEdge, GraphNode } from '../../domain/graph.js';
import { GraphIdentityFactory } from '../../core/graph-identity.js';
const ids = new GraphIdentityFactory();

/** Enforces the v2 source contract before a semantic analyzer emits cross-analyzer facts. */
export function requireSourceCatalog(context: AnalysisContext, files: Array<{ path: string; source: string; bytes: Buffer; hash: string }>): SourceCatalogSnapshot {
  const catalog = context.sourceCatalogReader?.snapshot();
  if (!catalog || catalog.identityVersion !== 2 || catalog.provider !== 'codegraph' || catalog.providerVersion !== '1.6.2' || catalog.coordinateConvention !== 'provider-raw' || catalog.declarationAnchorConvention !== 'provider-raw-start-kind-name-unique' || catalog.workspaceId !== context.workspace.id || catalog.input.analyzerId !== 'builtin.codegraph') {
    throw new Error('A current CodeGraph 1.6.2 identity-v2 source catalog is required. Run builtin.codegraph for this workspace first.');
  }
  const byPath = new Map(catalog.files.map((file) => [file.relativePath, file]));
  for (const file of files) {
    const entry = byPath.get(file.path);
    if (!entry) throw new Error(`CodeGraph source catalog is missing scanned file '${file.path}'.`);
    const providerTextDigest = createHash('sha256').update(file.bytes.toString('utf8')).digest('hex');
    const rawByteDigest = createHash('sha256').update(file.bytes).digest('hex');
    const providerDigest = entry.contentDigest.value.toLowerCase();
    if (file.hash !== rawByteDigest || entry.repositoryKey !== catalog.repositoryKey || entry.contentDigest.algorithm !== 'sha256' || entry.contentDigest.encoding !== 'utf8-text' || providerDigest !== providerTextDigest) throw new Error(`CodeGraph source catalog is stale or does not use the required UTF-8 text digest for '${file.path}'.`);
    if (!/^[a-f0-9]{64}$/.test(file.hash)) throw new Error(`Raw-byte digest is invalid for '${file.path}'.`);
  }
  return catalog;
}

/** Binds semantic output revisions to effective options, raw/text digests, and one exact CodeGraph generation. */
export function semanticSourceRevision(analyzerId: string, contractVersion: string, config: unknown, files: Array<{ path: string; source: string; bytes: Buffer; hash: string }>, catalog: SourceCatalogSnapshot, scanRevision?: string): string {
  const catalogFiles = new Map(catalog.files.map((file) => [file.relativePath, file]));
  const inputs = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map((file) => {
    const entry = catalogFiles.get(file.path);
    if (!entry) throw new Error(`CodeGraph source catalog is missing scanned file '${file.path}'.`);
    return { path: file.path, rawByteSha256: file.hash, utf8TextSha256: createHash('sha256').update(file.bytes.toString('utf8')).digest('hex'), providerTextSha256: entry.contentDigest.value.toLowerCase() };
  });
  const identity = { analyzerId, contractVersion, config: canonical(config), scanRevision: scanRevision ?? null, codeGraph: { generationId: catalog.input.generationId, sourceRevision: catalog.sourceRevision ?? null }, files: inputs };
  return `${analyzerId}-v2:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}
/** Remaps only unique provider starts matching a parser declaration anchor; evidence retains its full parser range. */
export function adoptDeclarationIdentities(workspaceId: string, catalog: SourceCatalogSnapshot, nodes: GraphNode[], edges: GraphEdge[], evidence: AnalysisEvidence[], diagnostics: AnalysisDiagnostic[]) {
  const replacements = new Map<string, string>();
  const evidenceByNode = new Map(evidence.filter((item) => item.subjectKind === 'node').map((item) => [item.subjectId, item]));
  const fileByPath = new Map(catalog.files.map((file) => [file.relativePath, file]));
  for (const node of nodes) {
    if (node.kind !== 'python_class' && node.kind !== 'python_function' && node.kind !== 'python_async_function') continue;
    node.properties.sourceMapping = 'unverified';
    const source = evidenceByNode.get(node.id);
    const path = node.properties.path;
    if (!source || typeof path !== 'string' || !fileByPath.has(path)) continue;
    const compatible = node.kind === 'python_class' ? new Set(['code.class']) : new Set(['code.function']);
    const anchor = node.properties.declarationAnchor;
    if (!anchor || typeof anchor !== 'object' || (anchor as Record<string, unknown>).supported !== true || !Number.isInteger((anchor as Record<string, unknown>).line) || !Number.isInteger((anchor as Record<string, unknown>).column)) {
      diagnostics.push({ code: 'CODEGRAPH_SOURCE_ANCHOR_UNVERIFIED', severity: 'warning', message: `Source declaration '${node.label}' in '${path}' has no supported declaration start anchor.`, uri: path, line: source.line });
      continue;
    }
    const { line, column } = anchor as { line: number; column: number };
    const matches = catalog.symbols.filter((symbol) => symbol.relativePath === path && compatible.has(symbol.kind) && symbol.startLine === line && symbol.startColumn === column);
    if (matches.length !== 1 || matches[0]!.name !== node.label) {
      diagnostics.push({ code: matches.length > 1 ? 'CODEGRAPH_SOURCE_ANCHOR_AMBIGUOUS' : 'CODEGRAPH_SOURCE_ANCHOR_UNVERIFIED', severity: 'warning', message: `Source declaration '${node.label}' in '${path}' has no unique exact CodeGraph declaration anchor.`, uri: path, line: source.line });
      node.properties.sourceMapping = 'unverified';
      continue;
    }
    replacements.set(node.id, matches[0]!.nodeId);
    node.properties.codegraphKind = matches[0]!.kind;
    node.properties.sourceMapping = 'mapped';
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

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
