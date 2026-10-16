import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open as openFile, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import type { AnalysisContext, AnalysisDiagnostic, AnalysisEvidence, Analyzer, AnalysisResult, JsonValue } from '../../domain/analyzer.js';
import type { GraphEdge, GraphNode } from '../../domain/graph.js';
import { apiEndpointUri } from '../../core/api-identity.js';
import { GraphIdentityFactory } from '../../core/graph-identity.js';
import { requireSourceCatalog, semanticSourceRevision, SourceMappingUsage } from './source-catalog-adoption.js';

const ids = new GraphIdentityFactory();
const extensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
const MAX_FILES = 2000, MAX_FILE_BYTES = 1024 * 1024, MAX_TOTAL_BYTES = 16 * 1024 * 1024, MAX_REQUESTS = 1000;
const MAX_DIRECTORY_ENTRIES = 20_000, MAX_DIRECTORY_DEPTH = 64, MAX_AST_VISITS = 1_000_000, MAX_AST_DEPTH = 512, MAX_DIAGNOSTICS = 5000;
type FileRecord = { path: string; bytes: Buffer; hash: string };

export const frontendHttpAnalyzer: Analyzer = {
  descriptor: { id: 'builtin.frontend-http', version: '1.0.0', apiVersion: '1', capabilities: ['graph', 'evidence', 'diagnostics'] },
  async analyze(context): Promise<AnalysisResult> {
    const config = readConfig(context.config);
    const root = await realpath(context.workspace.path);
    const files = await inventory(root, config.frontendPaths);
    const before = signature(files);
    const decodedSources = files.map((file) => {
      let source: string;
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); }
      catch { throw new Error(`Frontend source '${file.path}' is not valid UTF-8.`); }
      return { file, source };
    });
    const sourceCatalog = requireSourceCatalog(context, decodedSources.map(({ file, source }) => ({ path: file.path, source, bytes: file.bytes, hash: file.hash })));
    const catalogFiles = new Map(sourceCatalog.files.map((file) => [file.relativePath, file]));
    const nodes: GraphNode[] = [], edges: GraphEdge[] = [], evidence: AnalysisEvidence[] = [], diagnostics: AnalysisDiagnostic[] = [];
    const sourceMappingUsage = new SourceMappingUsage();
    const nodeMap = new Map<string, GraphNode>();
    const addNode = (kind: string, key: string, label: string, properties: Record<string, unknown>) => {
      const id = kind === 'frontend_file' ? catalogFiles.get(key)?.fileId ?? ids.node(context.workspace.id, key, kind) : ids.node(context.workspace.id, key, kind);
      let node = nodeMap.get(id);
      if (!node) { node = { id, workspaceId: context.workspace.id, kind: kind === 'frontend_file' ? 'file' : kind, label, properties }; nodeMap.set(id, node); nodes.push(node); }
      return node;
    };
    const addEdge = (from: GraphNode, to: GraphNode, kind: string, key: string) => {
      const id = ids.relationship(context.workspace.id, from.id, to.id, kind);
      if (!edges.some((edge) => edge.id === id)) edges.push({ id, workspaceId: context.workspace.id, sourceId: from.id, targetId: to.id, kind, properties: {} });
      return id;
    };
    const addEvidence = (subjectKind: 'node' | 'edge', subjectId: string, key: string, file: string, line: number, type: string, level: 'DIRECT' | 'DERIVED' = 'DIRECT', provenance?: Record<string, JsonValue>) => {
      const id = ids.node(subjectId, `evidence:${subjectKind}`, `${type}:${file}:${key}`);
      evidence.push({ id, subjectKind, subjectId, level, type, uri: file, line, ...(provenance ? { provenance } : {}) });
    };
    let requests = 0;
    for (const { file, source } of decodedSources) {
      const scriptKind = file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : file.path.endsWith('.jsx') ? ts.ScriptKind.JSX : file.path.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
      const ast = ts.createSourceFile(file.path, source, ts.ScriptTarget.Latest, true, scriptKind);
      const parseDiagnostics = (ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
      if (parseDiagnostics.length) {
        const diagnostic = parseDiagnostics[0]!;
        throw new Error(`Frontend source '${file.path}' has a parse error at line ${lineOfDiagnostic(ast, diagnostic)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}.`);
      }
      const fileNode = addNode('frontend_file', file.path, file.path, { path: file.path });
      sourceMappingUsage.record(`file:${catalogFiles.get(file.path)!.fileId}`, 'mapped');
      addEvidence('node', fileNode.id, `file:${file.path}`, file.path, 1, 'frontend.file');
      const astBudget = { visits: 0 };
      const shadowed = hasFetchBinding(ast, file.path, astBudget);
      const axiosNames = axiosBindings(ast, file.path, astBudget);
      visitAstBounded(ast, file.path, astBudget, (node, depth) => {
        if (isAxiosCall(node, axiosNames)) diag('FRONTEND_HTTP_AXIOS_UNSUPPORTED', 'Axios request candidate found; only direct fetch calls are supported.', file.path, lineOf(ast, node));
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
          const first = node.arguments[0];
          if (!first || !ts.isStringLiteralLike(first)) { diag('FRONTEND_HTTP_DYNAMIC_URL', 'fetch URL is not a static string; request omitted.', file.path, lineOf(ast, node)); }
          else if (shadowed) { diag('FRONTEND_HTTP_SHADOWED_FETCH', 'fetch is shadowed or may be shadowed in this file; request omitted.', file.path, lineOf(ast, node)); }
          else {
            const path = first.text;
            const methodResult = fetchMethod(node);
            if (!path.startsWith('/') || path.startsWith('//') || /[%\s?#\u0000-\u001f\u007f]/.test(path) || path.includes('\\') || path.split('/').some((segment) => segment === '.' || segment === '..')) diag('FRONTEND_HTTP_UNSUPPORTED_URL', 'Only a canonical root-relative literal fetch URL without percent escapes, whitespace, query, fragment, dot segments, or control characters is supported.', file.path, lineOf(ast, node));
            else if (methodResult.error) diag('FRONTEND_HTTP_DYNAMIC_METHOD', methodResult.error, file.path, lineOf(ast, node));
            else {
              if (++requests > MAX_REQUESTS) throw new Error(`Frontend HTTP requests exceed the result limit (${MAX_REQUESTS}).`);
              const method = methodResult.method!;
              const requestKey = `${file.path}#fetch:${node.getStart(ast)}`;
              const request = addNode('frontend.http_request', requestKey, `${method} ${path}`, { path, method, filePath: file.path, offset: node.getStart(ast) });
              const endpoint = addNode('api_endpoint', apiEndpointUri(config.apiNamespace, method, path), `${method} ${path}`, { namespace: config.apiNamespace, method, path });
              const line = lineOf(ast, node);
              addEvidence('node', request.id, requestKey, file.path, line, 'frontend.http_request');
              const namespaceProvenance = { apiNamespace: config.apiNamespace, reason: 'Configured namespace maps the literal frontend request to the shared API endpoint identity.' };
              addEvidence('node', endpoint.id, `${requestKey}:endpoint`, file.path, line, 'frontend.api_endpoint_consumer', 'DERIVED', namespaceProvenance);
              const containment = addEdge(fileNode, request, 'contains', `${requestKey}:file`);
              addEvidence('edge', containment, `${requestKey}:file`, file.path, line, 'frontend.contains_request');
              const relation = addEdge(request, endpoint, 'http_request', `${requestKey}:http_request`);
              addEvidence('edge', relation, `${requestKey}:http_request`, file.path, line, 'frontend.http_request', 'DERIVED', namespaceProvenance);
            }
          }
        }
      });
    }
    const after = await inventory(root, config.frontendPaths);
    if (signature(after) !== before) throw new Error('Frontend source inventory or content changed during analysis.');
    const sourceRevision = semanticSourceRevision('builtin.frontend-http', 'frontend-http-codegraph-v2+typescript-scan-v1+identity-map-v1', config, decodedSources.map(({ file, source }) => ({ ...file, source })), sourceCatalog);
    if (context.sourceRevision !== undefined && context.sourceRevision !== sourceRevision) throw new Error('Computed frontend HTTP source revision does not match the requested revision.');
    return { sourceRevision, inputGenerations: [{ analyzerId: 'builtin.codegraph', generationId: sourceCatalog.input.generationId }], sourceMappingSummary: sourceMappingUsage.summary(sourceCatalog.input.generationId), nodes, edges, evidence, diagnostics };

    function diag(code: string, message: string, uri: string, line: number) {
      if (diagnostics.length >= MAX_DIAGNOSTICS) throw new Error(`Frontend HTTP diagnostics exceed ${MAX_DIAGNOSTICS}.`);
      diagnostics.push({ code, severity: 'warning', message, uri, line });
    }
  },
};

function readConfig(config: AnalysisContext['config']) {
  const frontendPaths = config.frontendPaths;
  const apiNamespace = config.apiNamespace;
  if (!Array.isArray(frontendPaths) || frontendPaths.length === 0 || frontendPaths.some((path) => typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).includes('..'))) throw new Error('frontendPaths must be a non-empty array of workspace-relative file or directory paths.');
  if (typeof apiNamespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(apiNamespace) || apiNamespace === 'default') throw new Error('apiNamespace must be explicitly set to a non-default API namespace.');
  for (const key of Object.keys(config)) if (!['frontendPaths', 'apiNamespace'].includes(key)) throw new Error(`Unsupported frontend HTTP option '${key}'.`);
  return { frontendPaths: [...new Set(frontendPaths as string[])].sort(), apiNamespace };
}

async function inventory(root: string, selected: string[]): Promise<FileRecord[]> {
  const output: FileRecord[] = [];
  const seen = new Set<string>();
  let directoryEntries = 0, totalBytes = 0;
  for (const item of selected) {
    const absolute = resolve(root, item), rel = relative(root, absolute);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Selected frontend path '${item}' must be inside the workspace.`);
    await assertNoSymlinkAncestors(root, absolute);
    await assertCanonicalContained(root, absolute);
    await walk(absolute);
  }
  output.sort((a, b) => a.path.localeCompare(b.path));
  return output;
  async function walk(path: string, depth = 0) {
    if (depth > MAX_DIRECTORY_DEPTH) throw new Error(`Frontend directory depth exceeds ${MAX_DIRECTORY_DEPTH}.`);
    await assertNoSymlinkAncestors(root, path);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Selected frontend path '${path}' contains a symlink.`);
    if (info.isDirectory()) {
      const entries = [];
      const directory = await opendir(path);
      for await (const entry of directory) {
        if (++directoryEntries > MAX_DIRECTORY_ENTRIES) throw new Error(`Frontend directory inventory exceeds ${MAX_DIRECTORY_ENTRIES} entries.`);
        entries.push(entry);
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) await walk(resolve(path, entry.name), depth + 1);
      return;
    }
    if (!info.isFile()) throw new Error(`Selected frontend path '${path}' is not a regular file or directory.`);
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (!extensions.has(ext)) return;
    const filePath = relative(root, path).split(sep).join('/');
    if (seen.has(filePath)) return;
    await assertCanonicalContained(root, path);
    if (info.size > MAX_FILE_BYTES) throw new Error(`Frontend source '${filePath}' exceeds ${MAX_FILE_BYTES} bytes.`);
    const bytes = await readStableBoundedFile(root, path, filePath, info);
    if (output.length >= MAX_FILES) throw new Error(`Frontend source inventory exceeds ${MAX_FILES} files.`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Frontend source inventory exceeds ${MAX_TOTAL_BYTES} bytes.`);
    output.push({ path: filePath, bytes, hash: createHash('sha256').update(bytes).digest('hex') });
    seen.add(filePath);
  }
}
async function readStableBoundedFile(root: string, path: string, filePath: string, pathStat: Awaited<ReturnType<typeof lstat>>) {
  const canonicalBefore = await realpath(path);
  assertInside(root, canonicalBefore, path);
  const handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    assertSameFile(pathStat, opened, path);
    if (!opened.isFile() || opened.size > MAX_FILE_BYTES) throw new Error(`Frontend source '${filePath}' is not a stable regular file within the size limit.`);
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new Error(`Frontend source '${filePath}' changed or ended during reading.`);
      offset += result.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, bytes.length)).bytesRead !== 0) throw new Error(`Frontend source '${filePath}' grew beyond its checked size during reading.`);
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    const canonicalAfter = await realpath(path);
    assertSameFile(opened, after, path);
    assertSameFile(after, pathAfter, path);
    assertInside(root, canonicalAfter, path);
    if (canonicalBefore !== canonicalAfter) throw new Error(`Frontend source '${filePath}' changed canonical path during reading.`);
    return bytes;
  } finally {
    await handle.close();
  }
}
function assertSameFile(left: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number | bigint; ctimeMs: number | bigint }, right: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number | bigint; ctimeMs: number | bigint }, path: string) {
  if (left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size || left.mtimeMs !== right.mtimeMs || left.ctimeMs !== right.ctimeMs) throw new Error(`Frontend path '${path}' changed identity or metadata during analysis.`);
}
async function assertNoSymlinkAncestors(root: string, path: string) {
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Frontend path '${path}' is outside the workspace.`);
  const segments = rel.split(sep);
  if (segments.length > MAX_DIRECTORY_DEPTH) throw new Error(`Frontend path depth exceeds ${MAX_DIRECTORY_DEPTH}.`);
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Frontend path '${current}' contains a symlink ancestor.`);
  }
}
async function assertCanonicalContained(root: string, path: string) {
  const canonical = await realpath(path);
  assertInside(root, canonical, path);
}
function assertInside(root: string, canonical: string, original: string) {
  const rel = relative(root, canonical);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Frontend path '${original}' resolves outside the workspace.`);
}
function signature(files: FileRecord[]) { return files.map((file) => `${file.path.length}:${file.path}:${file.bytes.length}:${file.hash}`).join('\n'); }
function lineOf(ast: ts.SourceFile, node: ts.Node) { return ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1; }
function lineOfDiagnostic(ast: ts.SourceFile, diagnostic: ts.Diagnostic) { return ast.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1; }
function isAxiosCall(node: ts.Node, axiosNames: Set<string>) {
  if (!ts.isCallExpression(node)) return false;
  let expression = node.expression;
  while (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) expression = expression.expression;
  return ts.isIdentifier(expression) && (expression.text === 'axios' || axiosNames.has(expression.text));
}
type AstBudget = { visits: number };
function visitAstBounded(ast: ts.SourceFile, file: string, budget: AstBudget, callback: (node: ts.Node, depth: number) => void, root: ts.Node = ast, baseDepth = 0) {
  const visit = (node: ts.Node, depth: number) => {
    if (++budget.visits > MAX_AST_VISITS) throw new Error(`Frontend source '${file}' exceeds ${MAX_AST_VISITS} AST visits.`);
    if (depth > MAX_AST_DEPTH) throw new Error(`Frontend source '${file}' exceeds AST depth ${MAX_AST_DEPTH}.`);
    callback(node, depth);
    ts.forEachChild(node, (child) => visit(child, depth + 1));
  };
  visit(root, baseDepth);
}
function axiosBindings(ast: ts.SourceFile, file: string, budget: AstBudget) {
  const names = new Set<string>();
  visitAstBounded(ast, file, budget, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'axios' && node.importClause) {
      if (node.importClause.name) names.add(node.importClause.name.text);
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) names.add(item.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'require') {
      const argument = node.initializer.arguments[0];
      if (argument && ts.isStringLiteralLike(argument) && argument.text === 'axios') names.add(node.name.text);
    }
  });
  return names;
}
function hasFetchBinding(ast: ts.SourceFile, file: string, budget: AstBudget) {
  let found = false;
  visitAstBounded(ast, file, budget, (node, depth) => {
    if (ts.isWithStatement(node)) found = true;
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isBindingElement(node)) {
      const name = (node as ts.NamedDeclaration).name;
      if (name && ts.isIdentifier(name) && name.text === 'fetch') found = true;
    }
    if (ts.isImportSpecifier(node) && node.propertyName?.text === 'fetch') found = true;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && containsFetchIdentifier(node.left, file, budget, depth + 1)) found = true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') found = true;
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if ([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && containsFetchIdentifier(node.operand, file, budget, depth + 1)) found = true;
    }
  });
  return found;
}
function fetchMethod(call: ts.CallExpression): { method?: string; error?: string } {
  const init = call.arguments[1];
  if (!init) return { method: 'GET' };
  if (!ts.isObjectLiteralExpression(init)) return { error: 'fetch options are dynamic; request method omitted.' };
  if (init.properties.some((property) => ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name))) return { error: 'fetch options contain spread or computed properties; request omitted.' };
  if (init.properties.some(isProtoProperty)) return { error: 'fetch options contain a __proto__ property; request omitted.' };
  const methods = init.properties.filter(isMethodProperty);
  if (methods.length > 1) return { error: 'fetch options contain duplicate method properties; request omitted.' };
  const methodProperty = methods[0];
  if (!methodProperty) return { method: 'GET' };
  if (!ts.isPropertyAssignment(methodProperty) || !ts.isStringLiteralLike(methodProperty.initializer)) return { error: 'fetch method is dynamic; request omitted.' };
  const method = methodProperty.initializer.text.toUpperCase();
  if (!['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE'].includes(method)) return { error: 'fetch method is not a supported static HTTP method; request omitted.' };
  return { method };
}
function isMethodProperty(property: ts.ObjectLiteralElementLike) {
  if (ts.isSpreadAssignment(property)) return false;
  return ts.isIdentifier(property.name) && property.name.text === 'method' || ts.isStringLiteralLike(property.name) && property.name.text === 'method';
}
function isProtoProperty(property: ts.ObjectLiteralElementLike) {
  if (ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name)) return false;
  return ts.isIdentifier(property.name) && property.name.text === '__proto__' || ts.isStringLiteralLike(property.name) && property.name.text === '__proto__';
}
function containsFetchIdentifier(node: ts.Node, file: string, budget: AstBudget, depth: number): boolean {
  let found = false;
  visitAstBounded(node.getSourceFile(), file, budget, (candidate) => {
    if (ts.isIdentifier(candidate) && candidate.text === 'fetch') found = true;
    if (ts.isPropertyAccessExpression(candidate) && candidate.name.text === 'fetch') found = true;
    if (ts.isElementAccessExpression(candidate) && candidate.argumentExpression && ts.isStringLiteralLike(candidate.argumentExpression) && candidate.argumentExpression.text === 'fetch') found = true;
  }, node, depth);
  return found;
}
