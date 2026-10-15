import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AnalysisDiagnostic, AnalysisResult, Analyzer, AnalysisEvidence, JsonValue } from '../../domain/analyzer.js';
import type { EvidenceLevel, GraphEdge, GraphNode } from '../../domain/graph.js';

const CODEGRAPH_VERSION = '1.6.2';
const SCHEMA_VERSION = 15;
const EXTRACTION_VERSION = 28;
const MAX_ITEMS = 10_000;
const MAX_CONTRIBUTIONS = 9_000;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FIELD_BYTES = 10_000;
const FILE_ONLY_LANGUAGES = ['yaml', 'twig', 'properties'] as const;
const SUPPORTED_LANGUAGES = 'typescript javascript tsx jsx arkts python go rust java c cpp csharp razor php ruby swift kotlin dart svelte vue astro liquid pascal scala lua luau objc r solidity nix yaml twig xml properties cfml cfscript cfquery cobol vbnet erlang terraform'.split(' ');

type DbCounts = { nodes: number; edges: number; files: number; pending: number; failed: number; bytes: number; oversizedFields: number; directoryPotential: number };
type FileIssue = { code?: string; severity?: string; message?: string; line?: number; column?: number };
type NodeRecord = {
  id: string; kind: string; name: string; qualified_name: string; file_path: string; language: string;
  start_line: number; end_line: number; start_column: number; end_column: number; signature?: string; visibility?: string;
  is_exported?: number; is_async?: number; is_static?: number; is_abstract?: number; decorators?: string; type_parameters?: string;
  return_type?: string; updated_at?: number;
};
type EdgeRecord = { id: number; source: string; target: string; kind: string; metadata?: string; line?: number; col?: number; provenance?: string };
type FileRecord = { path: string; content_hash: string; language: string; size: number; modified_at: number; indexed_at: number; node_count: number; errors?: string; generated?: number };
type ReadonlyDb = { prepare(sql: string): { get(...values: unknown[]): any; iterate(...values: unknown[]): Iterable<any> }; exec(sql: string): void };
type CodeGraphSdk = {
  getCodeGraphDir(path: string): string;
  getDatabasePath(path: string): string;
  DatabaseConnection: { open(path: string, options: { readOnly: true }): { readonly readOnly: boolean; getDb(): ReadonlyDb; getSchemaVersion(): { version: number } | null; close(): void } };
  QueryBuilder: new(db: ReadonlyDb) => { getMetadata(key: string): string | null };
};

export function createCodeGraphSnapshotAnalyzer(sdkPackageRoot: string): Analyzer {
  let sdk: CodeGraphSdk | undefined;
  return {
    descriptor: { id: 'builtin.codegraph', version: CODEGRAPH_VERSION, apiVersion: '1', capabilities: ['graph', 'evidence', 'diagnostics'] },
    async analyze({ workspace, signal }): Promise<AnalysisResult> {
      if (signal?.aborted) throw new Error('CodeGraph snapshot ingestion was cancelled.');
      assertSupportedRuntime();
      sdk ??= loadCodeGraphSdk(sdkPackageRoot);
      const directory = sdk.getCodeGraphDir(workspace.path);
      const databasePath = resolve(sdk.getDatabasePath(workspace.path));
      const relativeDatabasePath = relative(resolve(directory), databasePath);
      if (!relativeDatabasePath || relativeDatabasePath === '..' || relativeDatabasePath.startsWith(`..${sep}`) || isAbsolute(relativeDatabasePath)) throw new Error('CodeGraph database path is outside its project directory.');
      const lock = acquireSnapshotLock(join(directory, 'codegraph.lock'));
      let connection: ReturnType<typeof sdk.DatabaseConnection.open> | undefined;
      let inTransaction = false;
      try {
        connection = sdk.DatabaseConnection.open(databasePath, { readOnly: true });
        const db = connection.getDb();
        db.exec('PRAGMA query_only = ON');
        db.exec('BEGIN');
        inTransaction = true;
        if (signal?.aborted) throw new Error('CodeGraph snapshot ingestion was cancelled.');
        if (!connection.readOnly) throw new Error('CodeGraph SDK did not open the database read-only.');
        if (connection.getSchemaVersion()?.version !== SCHEMA_VERSION) throw new Error(`CodeGraph schema must be ${SCHEMA_VERSION}.`);
        const query = new sdk.QueryBuilder(db);
        const extraction = Number(query.getMetadata('indexed_with_extraction_version'));
        if (extraction !== EXTRACTION_VERSION) throw new Error(`CodeGraph extraction version must be ${EXTRACTION_VERSION}; reindex with CodeGraph ${CODEGRAPH_VERSION}.`);
        const state = query.getMetadata('index_state');
        if (state !== 'complete') throw new Error(`CodeGraph index is not complete (state: ${state ?? 'unknown'}). Reindex with CodeGraph ${CODEGRAPH_VERSION}.`);
        if (query.getMetadata('synthesis_pending') === '1') throw new Error('CodeGraph synthesis is pending; finish synthesis before importing the snapshot.');

        const counts = readScalarPreflight(db);
        validateInputBudget(counts);
        if (counts.directoryPotential > MAX_CONTRIBUTIONS) throw new Error('CodeGraph source paths exceed the derived directory budget.');
        if (counts.pending) throw new Error(`CodeGraph has ${counts.pending} unresolved references pending; the index is incomplete.`);
        const files = readBounded<FileRecord>(db, `SELECT path, content_hash, language, size, modified_at, indexed_at, node_count, errors, generated FROM files ORDER BY path LIMIT ?`, counts.files, 'files');
        const normalizedFiles = files.map((file) => ({ ...file, normalizedPath: normalizeRelativePath(file.path) }));
        const directories = makeDirectories(normalizedFiles.map((file) => file.normalizedPath));
        validateContributionBudget(counts, directories.size);
        const nodes = readBounded<NodeRecord>(db, `SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, signature, visibility, is_exported, is_async, is_static, is_abstract, decorators, type_parameters, return_type, updated_at FROM nodes ORDER BY id LIMIT ?`, counts.nodes, 'nodes');
        const edges = readBounded<EdgeRecord>(db, `SELECT id, source, target, kind, metadata, line, col, provenance FROM edges ORDER BY id LIMIT ?`, counts.edges, 'edges');
        if (signal?.aborted) throw new Error('CodeGraph snapshot ingestion was cancelled.');

        const diagnostics: AnalysisDiagnostic[] = [];
        const fileIssues = new Map<string, FileIssue[]>();
        for (const file of normalizedFiles) {
          const issues = parseJsonArray<FileIssue>(file.errors, `errors for ${file.normalizedPath}`);
          fileIssues.set(file.normalizedPath, issues);
          for (const issue of issues) {
            if (issue.code === 'parser_error') throw new Error(`CodeGraph parser initialization error in ${file.normalizedPath}; reindex with CodeGraph ${CODEGRAPH_VERSION}.`);
            if (issue.code === 'parse_error') diagnostics.push({ code: 'CODEGRAPH_PARSE_ERROR', severity: 'warning', message: issue.message ?? `CodeGraph could not parse ${file.normalizedPath}.`, uri: file.normalizedPath, ...(issue.line ? { line: issue.line } : {}) });
          }
          if (SUPPORTED_LANGUAGES.includes(file.language) && !FILE_ONLY_LANGUAGES.includes(file.language as (typeof FILE_ONLY_LANGUAGES)[number]) && file.node_count === 0 && !issues.length) throw new Error(`CodeGraph has a supported-language file with no extracted nodes and no recorded extraction error: ${file.normalizedPath}.`);
        }
        for (const node of nodes) { parseJsonArray(node.decorators, `decorators for ${node.id}`); parseJsonArray(node.type_parameters, `type parameters for ${node.id}`); }
        for (const edge of edges) parseJsonObject(edge.metadata, `metadata for edge ${edge.id}`);
        const health = readHealthJsonCounts(db);
        if (health.invalidJsonFields) throw new Error(`CodeGraph contains ${health.invalidJsonFields} malformed JSON fields.`);
        if (counts.failed) diagnostics.push({ code: 'CODEGRAPH_UNRESOLVED_REFERENCES', severity: 'warning', message: `${counts.failed} references remain unresolved after CodeGraph resolution.` });
        if (health.warningFiles) diagnostics.push({ code: 'CODEGRAPH_FILE_WARNINGS', severity: 'warning', message: `${health.warningFiles} files contain warning-only CodeGraph skip markers.` });
        if (files.length === 0 && nodes.length === 0) diagnostics.push({ code: 'CODEGRAPH_EMPTY_INDEX', severity: 'warning', message: 'CodeGraph index is complete and contains no files or nodes.' });

        const graphNodes: GraphNode[] = [];
        const graphEdges: GraphEdge[] = [];
        const evidence: AnalysisEvidence[] = [];
        const outputMeter = new SerializedBudget(diagnostics);
        const sourceHash = createHash('sha256').update(`${CODEGRAPH_VERSION}:${SCHEMA_VERSION}:${EXTRACTION_VERSION}:`);
        const fileIds = new Map<string, string>();
        const mapped = new Map<string, string>();
        const nodeFilePaths = new Map<string, string>();
        const addNode = (node: GraphNode, ev: AnalysisEvidence) => { outputMeter.addNode(node); outputMeter.addEvidence(ev); graphNodes.push(node); evidence.push(ev); };
        const addEdge = (edge: GraphEdge, ev: AnalysisEvidence) => { outputMeter.addEdge(edge); outputMeter.addEvidence(ev); graphEdges.push(edge); evidence.push(ev); };
        const workspaceNodeId = stableId(workspace.id, 'workspace', workspace.id);
        addNode({ id: workspaceNodeId, workspaceId: workspace.id, kind: 'workspace', label: workspace.name.normalize('NFC'), properties: { workspacePath: workspace.path.normalize('NFC') }, level: 'DIRECT' }, evidenceFor('codegraph.workspace', 'node', workspaceNodeId, 'DIRECT', workspace.path));
        const directoryIds = new Map<string, string>();
        for (const path of [...directories].sort()) {
          const id = stableId(workspace.id, 'directory', path); directoryIds.set(path, id);
          addNode({ id, workspaceId: workspace.id, kind: 'directory', label: path.split('/').at(-1)!, properties: { path }, level: 'DERIVED' }, evidenceFor('codegraph.directory', 'node', id, 'DERIVED', path));
        }
        for (const file of normalizedFiles) {
          const id = stableId(workspace.id, 'file', file.normalizedPath); fileIds.set(file.normalizedPath, id);
          const warningCodes = (fileIssues.get(file.normalizedPath) ?? []).filter((issue) => issue.severity === 'warning').map((issue) => issue.code).filter(Boolean);
          addNode({ id, workspaceId: workspace.id, kind: 'file', label: file.normalizedPath, properties: jsonRecord({ path: file.normalizedPath, language: file.language, contentHash: file.content_hash, size: file.size, generated: Boolean(file.generated), warningCodes }), level: 'DIRECT' }, evidenceFor('codegraph.file', 'node', id, 'DIRECT', file.normalizedPath));
        }
        for (const node of nodes) {
          const normalizedPath = normalizeRelativePath(node.file_path);
          nodeFilePaths.set(node.id, normalizedPath);
          const fileId = fileIds.get(normalizedPath);
          if (!fileId && node.kind === 'file') throw new Error(`CodeGraph file node has no matching file record: ${normalizedPath}.`);
          const id = node.kind === 'file' ? fileId! : stableId(workspace.id, 'node', node.id);
          mapped.set(node.id, id);
          if (node.kind === 'file') continue;
          const kind = normalizeNodeKind(node.kind);
          const ev = evidenceFor('codegraph.symbol', 'node', id, 'DIRECT', normalizedPath, node.start_line, { codegraphId: node.id });
          addNode({ id, workspaceId: workspace.id, kind, label: node.name || node.qualified_name || node.id, properties: jsonRecord({ codegraphId: node.id, upstreamKind: isKnownNodeKind(node.kind) ? undefined : node.kind, qualifiedName: node.qualified_name, filePath: normalizedPath, language: node.language, startLine: node.start_line, endLine: node.end_line, startColumn: node.start_column, endColumn: node.end_column, signature: node.signature, visibility: node.visibility, isExported: bool(node.is_exported), isAsync: bool(node.is_async), isStatic: bool(node.is_static), isAbstract: bool(node.is_abstract), decorators: parseJsonArray(node.decorators, `decorators for ${node.id}`), typeParameters: parseJsonArray(node.type_parameters, `type parameters for ${node.id}`), returnType: node.return_type }), evidence: [{ type: ev.type, uri: ev.uri, ...(ev.line ? { line: ev.line } : {}), level: ev.level }], level: 'DIRECT' }, ev);
        }
        for (const edge of edges) {
          const sourceId = mapped.get(edge.source) ?? fileIds.get(nodeFilePaths.get(edge.source) ?? '');
          const targetId = mapped.get(edge.target) ?? fileIds.get(nodeFilePaths.get(edge.target) ?? '');
          if (!sourceId || !targetId) throw new Error(`CodeGraph edge ${edge.id} refers to a missing endpoint.`);
          const kind = normalizeEdgeKind(edge.kind);
          const level = edgeLevel(edge);
          const id = stableId(workspace.id, 'edge', `${edge.id}:${edge.source}:${edge.target}:${edge.kind}`);
          const ev = evidenceFor('codegraph.relationship', 'edge', id, level, nodeFilePaths.get(edge.source), edge.line, { codegraphId: edge.id, upstreamProvenance: edge.provenance });
          addEdge({ id, workspaceId: workspace.id, sourceId, targetId, kind, properties: jsonRecord({ codegraphId: edge.id, upstreamKind: isKnownEdgeKind(edge.kind) ? undefined : edge.kind, metadata: parseJsonObject(edge.metadata, `metadata for edge ${edge.id}`), line: edge.line, column: edge.col, provenance: edge.provenance }), evidence: [{ type: ev.type, ...(ev.uri ? { uri: ev.uri } : {}), ...(ev.line ? { line: ev.line } : {}), level: ev.level }], level }, ev);
        }
        for (const file of normalizedFiles) {
          const segments = file.normalizedPath.split('/');
          const fileId = fileIds.get(file.normalizedPath)!;
          const parentPath = segments.slice(0, -1).join('/');
          addDerivedContains(parentPath ? directoryIds.get(parentPath)! : workspaceNodeId, fileId, file.normalizedPath);
        }
        for (const path of [...directories].sort()) {
          const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
          addDerivedContains(parent ? directoryIds.get(parent)! : workspaceNodeId, directoryIds.get(path)!, path);
        }
        for (const node of graphNodes.sort((a, b) => a.id.localeCompare(b.id))) sourceHash.update(`n\0${JSON.stringify(node)}\n`);
        for (const edge of graphEdges.sort((a, b) => a.id.localeCompare(b.id))) sourceHash.update(`e\0${JSON.stringify(edge)}\n`);
        db.exec('COMMIT'); inTransaction = false;
        return { sourceRevision: sourceHash.digest('hex'), nodes: graphNodes, edges: graphEdges, evidence, diagnostics };

        function addDerivedContains(sourceId: string, targetId: string, path: string): void {
          const id = stableId(workspace.id, 'contains', `${sourceId}:${targetId}`);
          const ev = evidenceFor('codegraph.contains', 'edge', id, 'DERIVED', path, undefined, { derivedFrom: 'CodeGraph file paths' });
          addEdge({ id, workspaceId: workspace.id, sourceId, targetId, kind: 'contains', properties: { derived: true }, evidence: [{ type: ev.type, uri: path, level: ev.level }], level: 'DERIVED' }, ev);
        }
      } finally {
        if (connection && inTransaction) { try { connection.getDb().exec('ROLLBACK'); } catch { /* preserve the original failure */ } }
        try { connection?.close(); } finally { lock.release(); }
      }
    },
  };
}

function readScalarPreflight(db: ReadonlyDb): DbCounts {
  const row = db.prepare(`SELECT
    (SELECT COUNT(*) FROM nodes) nodes, (SELECT COUNT(*) FROM edges) edges, (SELECT COUNT(*) FROM files) files,
    (SELECT COUNT(*) FROM unresolved_refs WHERE status='pending') pending, (SELECT COUNT(*) FROM unresolved_refs WHERE status='failed') failed,
    (SELECT COALESCE(SUM(length(CAST(id AS BLOB))+length(CAST(kind AS BLOB))+length(CAST(name AS BLOB))+length(CAST(qualified_name AS BLOB))+length(CAST(file_path AS BLOB))+length(CAST(language AS BLOB))+length(CAST(COALESCE(signature,'') AS BLOB))+length(CAST(COALESCE(visibility,'') AS BLOB))+length(CAST(COALESCE(decorators,'') AS BLOB))+length(CAST(COALESCE(type_parameters,'') AS BLOB))+length(CAST(COALESCE(return_type,'') AS BLOB))),0) FROM nodes)
    + (SELECT COALESCE(SUM(length(CAST(source AS BLOB))+length(CAST(target AS BLOB))+length(CAST(kind AS BLOB))+length(CAST(COALESCE(metadata,'') AS BLOB))+length(CAST(COALESCE(provenance,'') AS BLOB))),0) FROM edges)
    + (SELECT COALESCE(SUM(length(CAST(path AS BLOB))+length(CAST(content_hash AS BLOB))+length(CAST(language AS BLOB))+length(CAST(COALESCE(errors,'') AS BLOB))),0) FROM files) bytes,
    (SELECT COALESCE(SUM(length(path)-length(replace(path,'/',''))),0) FROM files) directoryPotential,
    (SELECT COUNT(*) FROM nodes WHERE MAX(length(CAST(id AS BLOB)),length(CAST(kind AS BLOB)),length(CAST(name AS BLOB)),length(CAST(qualified_name AS BLOB)),length(CAST(file_path AS BLOB)),length(CAST(language AS BLOB)),length(CAST(COALESCE(signature,'') AS BLOB)),length(CAST(COALESCE(visibility,'') AS BLOB)),length(CAST(COALESCE(decorators,'') AS BLOB)),length(CAST(COALESCE(type_parameters,'') AS BLOB)),length(CAST(COALESCE(return_type,'') AS BLOB))) > ${MAX_FIELD_BYTES})
    + (SELECT COUNT(*) FROM edges WHERE MAX(length(CAST(source AS BLOB)),length(CAST(target AS BLOB)),length(CAST(kind AS BLOB)),length(CAST(COALESCE(metadata,'') AS BLOB)),length(CAST(COALESCE(provenance,'') AS BLOB))) > ${MAX_FIELD_BYTES})
    + (SELECT COUNT(*) FROM files WHERE MAX(length(CAST(path AS BLOB)),length(CAST(content_hash AS BLOB)),length(CAST(language AS BLOB)),length(CAST(COALESCE(errors,'') AS BLOB))) > ${MAX_FIELD_BYTES}) oversizedFields`).get() as Record<string, number>;
  return Object.fromEntries(['nodes','edges','files','pending','failed','bytes','oversizedFields','directoryPotential'].map((key) => [key, Number(row[key])])) as unknown as DbCounts;
}

function readHealthJsonCounts(db: ReadonlyDb): { invalidJsonFields: number; warningFiles: number } {
  const row = db.prepare(`SELECT
    (SELECT COUNT(*) FROM nodes WHERE (decorators IS NOT NULL AND NOT json_valid(decorators)) OR (type_parameters IS NOT NULL AND NOT json_valid(type_parameters)))
    + (SELECT COUNT(*) FROM edges WHERE metadata IS NOT NULL AND NOT json_valid(metadata))
    + (SELECT COUNT(*) FROM files WHERE errors IS NOT NULL AND NOT json_valid(errors)) invalid,
    (SELECT COUNT(DISTINCT f.path) FROM files f, json_each(CASE WHEN json_valid(f.errors) THEN f.errors ELSE '[]' END) e WHERE json_extract(e.value,'$.severity')='warning') warningFiles`).get() as { invalid: number; warningFiles: number };
  return { invalidJsonFields: Number(row.invalid), warningFiles: Number(row.warningFiles) };
}

function validateInputBudget(counts: DbCounts): void {
  if (counts.files > MAX_ITEMS || counts.nodes > MAX_ITEMS || counts.edges > MAX_ITEMS) throw new Error(`CodeGraph snapshot exceeds the ${MAX_ITEMS}-row input limit.`);
  if (counts.bytes > MAX_TOTAL_BYTES) throw new Error(`CodeGraph snapshot input exceeds the ${MAX_TOTAL_BYTES}-byte aggregate limit.`);
  if (counts.oversizedFields) throw new Error(`CodeGraph snapshot contains fields larger than ${MAX_FIELD_BYTES} bytes.`);
}
function validateContributionBudget(counts: DbCounts, directories: number): void {
  const nodeCount = 1 + directories + counts.files + counts.nodes;
  const edgeCount = directories + counts.files + counts.edges;
  if (nodeCount + edgeCount > MAX_CONTRIBUTIONS || nodeCount + edgeCount > MAX_ITEMS) throw new Error(`Derived CodeGraph snapshot exceeds the ${MAX_CONTRIBUTIONS}-contribution limit.`);
  if (nodeCount + edgeCount > MAX_ITEMS) throw new Error(`Derived CodeGraph snapshot exceeds the ${MAX_ITEMS}-item limit.`);
}
function readBounded<T>(db: ReadonlyDb, sql: string, count: number, name: string): T[] {
  const output: T[] = [];
  for (const row of db.prepare(sql).iterate(count + 1)) {
    if (output.length === count) throw new Error(`CodeGraph ${name} changed while reading the snapshot.`);
    output.push(row as T);
  }
  if (output.length !== count) throw new Error(`CodeGraph ${name} count changed while reading the snapshot.`);
  return output;
}
function parseJsonArray<T>(raw: string | undefined, label: string): T[] {
  if (!raw) return [];
  try { const parsed: unknown = JSON.parse(raw); if (Array.isArray(parsed)) return parsed as T[]; } catch { /* reported below */ }
  throw new Error(`CodeGraph contains malformed JSON for ${label}.`);
}
function parseJsonObject(raw: string | undefined, label: string): Record<string, unknown> {
  if (!raw) return {};
  try { const parsed: unknown = JSON.parse(raw); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch { /* reported below */ }
  throw new Error(`CodeGraph contains malformed JSON for ${label}.`);
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').normalize('NFC');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new Error(`CodeGraph contains a non-relative file path: ${value}.`);
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error(`CodeGraph contains an unsafe file path: ${value}.`);
  return segments.join('/');
}
function makeDirectories(paths: string[]): Set<string> {
  const result = new Set<string>();
  for (const path of paths) { const segments = path.split('/'); for (let i = 1; i < segments.length; i++) result.add(segments.slice(0, i).join('/')); }
  return result;
}
function isKnownNodeKind(kind: string): boolean { return ['class','function','method','interface','protocol','file','route','workspace','directory','module','package','enum','struct','type','variable','constant','property'].includes(kind.toLowerCase()); }
function normalizeNodeKind(kind: string): string {
  const value = kind.toLowerCase();
  const known: Record<string,string> = { class:'code.class', function:'code.function', method:'code.function', interface:'code.interface', protocol:'code.interface', file:'file', route:'api.endpoint', workspace:'workspace', directory:'directory', module:'code.module', package:'code.package', enum:'code.enum', struct:'code.struct', type:'code.type', variable:'code.variable', constant:'code.constant', property:'code.property' };
  return known[value] ?? `codegraph.${safeKind(kind)}`;
}
function isKnownEdgeKind(kind: string): boolean { return ['contains','imports','calls','depends_on','implements','inherits','references','maps_to','foreign_key','http_request','exports','extends','type_of','returns','instantiates','overrides','decorates','navigates'].includes(kind.toLowerCase()); }
function normalizeEdgeKind(kind: string): string { const value = kind.toLowerCase(); if (value === 'extends') return 'inherits'; return isKnownEdgeKind(kind) ? value : `codegraph.${safeKind(kind)}`; }
function safeKind(kind: string): string { const normalized = kind.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, ''); return normalized || 'unknown'; }
function edgeLevel(edge: EdgeRecord): EvidenceLevel {
  const provenance = (edge.provenance ?? '').toLowerCase();
  const metadata = parseJsonObject(edge.metadata, `metadata for edge ${edge.id}`);
  if (provenance.includes('heuristic') || provenance.includes('inferred') || metadata.inferred === true) return 'INFERRED';
  if (metadata.synthesizedBy || provenance.includes('synthes')) return 'DERIVED';
  return 'DIRECT';
}
function bool(value: number | undefined): boolean | undefined { return value === undefined ? undefined : value !== 0; }
function evidenceFor(type: string, subjectKind: 'node' | 'edge', subjectId: string, level: EvidenceLevel, uri?: string, line?: number, provenance?: Record<string, unknown>): AnalysisEvidence {
  return { id: stableId(subjectId, 'evidence', type), subjectKind, subjectId, level, type, ...(uri ? { uri } : {}), ...(line && line > 0 ? { line } : {}), ...(provenance ? { provenance: jsonRecord(provenance) } : {}) };
}
function loadCodeGraphSdk(packageRoot: string): CodeGraphSdk {
  const root = resolve(packageRoot);
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { name?: string; version?: string };
  if (packageJson.name !== '@colbymchenry/codegraph' || packageJson.version !== CODEGRAPH_VERSION) throw new Error(`--codegraph-sdk must point to @colbymchenry/codegraph ${CODEGRAPH_VERSION}.`);
  const require = createRequire(resolve(root, '__graphlens_loader__.cjs'));
  return require(root) as CodeGraphSdk;
}
function assertSupportedRuntime(): void {
  if (!codeGraphRuntimeSupported()) throw new Error(`CodeGraph SDK ingestion requires Node.js >=22.5 and <25; current runtime is ${process.versions.node}. GraphLens itself supports Node.js 20.`);
}
export function codeGraphRuntimeSupported(): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(process.versions.node); const major = Number(match?.[1]), minor = Number(match?.[2]);
  return major === 22 && minor >= 5 || major === 23 || major === 24;
}
function acquireSnapshotLock(lockPath: string): { release(): void } {
  const directory = resolve(lockPath, '..');
  const tempPath = resolve(directory, `.codegraph.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
  const descriptor = openSync(tempPath, 'wx', 0o600);
  let owned: { dev: number; ino: number };
  try { writeFileSync(descriptor, `${process.pid}\n`); owned = fstatSync(descriptor); linkSync(tempPath, lockPath); }
  catch (error) { try { unlinkSync(tempPath); } catch { /* best effort */ } if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another CodeGraph writer owns codegraph.lock.'); throw new Error(`Could not acquire the non-deleting atomic CodeGraph lock: ${message(error)}`); }
  finally { closeSync(descriptor); }
  try { unlinkSync(tempPath); } catch (error) { try { const fd = openSync(lockPath, 'r'); try { const current = fstatSync(fd); if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(lockPath); } finally { closeSync(fd); } } catch { /* keep lock if ownership cannot be proven */ } throw new Error(`Could not finalize CodeGraph lock: ${message(error)}`); }
  return { release() { try { const fd = openSync(lockPath, 'r'); try { const current = fstatSync(fd); if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(lockPath); } finally { closeSync(fd); } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } } };
}
class SerializedBudget {
  private bytes: number;
  private readonly counts = { nodes: 0, edges: 0, evidence: 0 };
  constructor(diagnostics: AnalysisDiagnostic[]) { this.bytes = Buffer.byteLength(JSON.stringify({ sourceRevision: '0'.repeat(64), nodes: [], edges: [], evidence: [], diagnostics })); }
  addNode(value: GraphNode): void { this.add('nodes', value); }
  addEdge(value: GraphEdge): void { this.add('edges', value); }
  addEvidence(value: AnalysisEvidence): void { this.add('evidence', value); }
  private add(key: 'nodes' | 'edges' | 'evidence', value: unknown): void {
    const valueBytes = Buffer.byteLength(JSON.stringify(value));
    const next = this.bytes + valueBytes + (this.counts[key] ? 1 : 0);
    if (next > MAX_TOTAL_BYTES) throw new Error(`Serialized CodeGraph analyzer result exceeds ${MAX_TOTAL_BYTES} bytes.`);
    this.bytes = next;
    this.counts[key]++;
  }
}
function stableId(workspaceId: string, type: string, value: string): string { return `codegraph-${createHash('sha256').update(`${workspaceId}\0${type}\0${value}`).digest('hex').slice(0, 40)}`; }
function jsonRecord(value: Record<string, unknown>): Record<string, JsonValue> { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Record<string, JsonValue>; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
