import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import type { AnalysisDiagnostic, AnalysisResult, Analyzer, JsonValue } from '../../domain/analyzer.js';
import type { GraphEdge, GraphNode } from '../../domain/graph.js';

const CODEGRAPH_VERSION = '1.6.2';
const SCHEMA_VERSION = 15;
const EXTRACTION_VERSION = 28;
const MAX_ITEMS = 10_000;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FIELD_BYTES = 10_000;
const FILE_ONLY_LANGUAGES = ['yaml', 'twig', 'properties'] as const;
const SUPPORTED_LANGUAGES = 'typescript javascript tsx jsx arkts python go rust java c cpp csharp razor php ruby swift kotlin dart svelte vue astro liquid pascal scala lua luau objc r solidity nix yaml twig xml properties cfml cfscript cfquery cobol vbnet erlang terraform'.split(' ');

type DbCounts = { nodes: number; edges: number; files: number; fileOnly: number; bytes: number; oversizedFields: number; invalidJsonFields: number; pending: number; failed: number; parserErrors: number; zeroNodeFiles: number; warningFiles: number };
type FileIssue = { code?: string; severity?: string };
type NodeRecord = {
  id: string; kind: string; name: string; qualifiedName: string; filePath: string; language: string;
  startLine: number; endLine: number; startColumn: number; endColumn: number; docstring?: string;
  signature?: string; visibility?: string; isExported?: boolean; isAsync?: boolean; isStatic?: boolean;
  isAbstract?: boolean; decorators?: string[]; typeParameters?: string[]; returnType?: string; updatedAt?: number;
};
type EdgeRecord = { id: number; source: string; target: string; kind: string; metadata?: Record<string, unknown>; line?: number; col?: number; provenance?: string };
type FileRecord = { path: string; contentHash: string; language: string; size: number; modifiedAt: number; indexedAt: number; nodeCount: number; errors?: FileIssue[]; generated?: boolean };
type ReadonlyDb = { prepare(sql: string): { get(...values: unknown[]): any; all(...values: unknown[]): any[] }; exec(sql: string): void };
type CodeGraphSdk = {
  getCodeGraphDir(path: string): string;
  getDatabasePath(path: string): string;
  DatabaseConnection: { open(path: string, options: { readOnly: true }): { readonly readOnly: boolean; getDb(): ReadonlyDb; getSchemaVersion(): { version: number } | null; close(): void } };
  QueryBuilder: new(db: ReadonlyDb) => { getMetadata(key: string): string | null; getAllFiles(): FileRecord[]; getAllNodes(): NodeRecord[] };
};

export function createCodeGraphSnapshotAnalyzer(sdkPackageRoot: string): Analyzer {
  const sdk = loadCodeGraphSdk(sdkPackageRoot);
  return {
    descriptor: { id: 'builtin.codegraph', version: CODEGRAPH_VERSION, apiVersion: '1', capabilities: ['graph', 'evidence', 'diagnostics'] },
    async analyze({ workspace, signal }): Promise<AnalysisResult> {
    if (signal?.aborted) throw new Error('CodeGraph snapshot ingestion was cancelled.');
    assertSupportedRuntime();
    const directory = sdk.getCodeGraphDir(workspace.path);
    const databasePath = resolve(sdk.getDatabasePath(workspace.path));
    const relativeDatabasePath = relative(resolve(directory), databasePath);
    if (!relativeDatabasePath || relativeDatabasePath === '..' || relativeDatabasePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativeDatabasePath)) throw new Error('CodeGraph database path is outside its project directory.');
    const lock = acquireSnapshotLock(directory);
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

      const counts = readHealthCounts(db);
      validateOutputBudget(counts);
      validateSnapshotHealth(counts);
      if (signal?.aborted) throw new Error('CodeGraph snapshot ingestion was cancelled.');
      const sourceHash = createHash('sha256').update(`${CODEGRAPH_VERSION}:${SCHEMA_VERSION}:${EXTRACTION_VERSION}:`);
      const fileRecords = query.getAllFiles() as FileRecord[];
      for (const file of fileRecords) sourceHash.update(`${file.path}\0${file.contentHash}\0${file.language}\0${file.nodeCount}\0${file.generated ?? false}\0${JSON.stringify(file.errors ?? [])}\n`);
      const nodes = query.getAllNodes() as NodeRecord[];
      const edges = db.prepare('SELECT id,source,target,kind,metadata,line,col,provenance FROM edges ORDER BY id').all() as EdgeRecord[];
      if (nodes.length !== counts.nodes || edges.length !== counts.edges || fileRecords.length !== counts.files) throw new Error('CodeGraph counts changed while reading the snapshot.');

      const graphNodes: GraphNode[] = [];
      const graphEdges: GraphEdge[] = [];
      const evidence: AnalysisResult['evidence'] = [];
      const mapped = new Map<string, string>();
      for (const node of nodes) {
        const id = stableId(workspace.id, 'node', node.id);
        mapped.set(node.id, id);
        graphNodes.push({
          id, workspaceId: workspace.id, kind: node.kind, label: node.name || node.qualifiedName || node.id,
          properties: jsonRecord({
            codegraphId: node.id, qualifiedName: node.qualifiedName, filePath: node.filePath, language: node.language,
            startLine: node.startLine, endLine: node.endLine, startColumn: node.startColumn, endColumn: node.endColumn,
            docstring: node.docstring, signature: node.signature, visibility: node.visibility,
            isExported: node.isExported, isAsync: node.isAsync, isStatic: node.isStatic, isAbstract: node.isAbstract,
            decorators: node.decorators, typeParameters: node.typeParameters, returnType: node.returnType,
          }),
          evidence: [{ type: 'codegraph.symbol', uri: node.filePath, ...(node.startLine > 0 ? { line: node.startLine } : {}), detail: `Indexed by CodeGraph ${CODEGRAPH_VERSION}.` }],
        });
        evidence.push(toAnalysisEvidence({ type: 'codegraph.symbol', uri: node.filePath, ...(node.startLine > 0 ? { line: node.startLine } : {}), detail: `Indexed by CodeGraph ${CODEGRAPH_VERSION}.` }, 'node', id, 0));
      }
      for (const file of fileRecords) {
        if (!FILE_ONLY_LANGUAGES.includes(file.language as (typeof FILE_ONLY_LANGUAGES)[number])) continue;
        const id = stableId(workspace.id, 'file', file.path);
        graphNodes.push({ id, workspaceId: workspace.id, kind: 'file', label: file.path, properties: jsonRecord({ filePath: file.path, language: file.language, contentHash: file.contentHash, size: file.size, generated: file.generated ?? false }), evidence: [{ type: 'codegraph.file', uri: file.path, detail: `File-level CodeGraph record; ${file.language} has no symbol extraction.` }] });
        evidence.push(toAnalysisEvidence({ type: 'codegraph.file', uri: file.path, detail: `File-level CodeGraph record; ${file.language} has no symbol extraction.` }, 'node', id, 0));
      }
      for (const edge of edges) {
        const sourceId = mapped.get(edge.source), targetId = mapped.get(edge.target);
        if (!sourceId || !targetId) throw new Error(`CodeGraph edge ${edge.id} refers to a missing endpoint.`);
        const id = stableId(workspace.id, 'edge', `${edge.id}:${edge.source}:${edge.target}:${edge.kind}`);
        graphEdges.push({ id, workspaceId: workspace.id, sourceId, targetId, kind: edge.kind, properties: jsonRecord({ codegraphId: edge.id, metadata: edge.metadata, line: edge.line, column: edge.col, provenance: edge.provenance }), evidence: [{ type: 'codegraph.relationship', ...(edge.line && edge.line > 0 ? { line: edge.line } : {}), detail: `Indexed by CodeGraph ${CODEGRAPH_VERSION}.` }] });
        evidence.push(toAnalysisEvidence({ type: 'codegraph.relationship', ...(edge.line && edge.line > 0 ? { line: edge.line } : {}), detail: `Indexed by CodeGraph ${CODEGRAPH_VERSION}.` }, 'edge', id, 0));
      }
      for (const node of graphNodes.sort((a, b) => a.id.localeCompare(b.id))) sourceHash.update(`n\0${JSON.stringify(node)}\n`);
      for (const edge of graphEdges.sort((a, b) => a.id.localeCompare(b.id))) sourceHash.update(`e\0${JSON.stringify(edge)}\n`);
      const diagnostics: AnalysisDiagnostic[] = [];
      if (counts.failed) diagnostics.push({ code: 'CODEGRAPH_UNRESOLVED_REFERENCES', severity: 'warning', message: `${counts.failed} references remain unresolved after CodeGraph resolution.` });
      if (counts.warningFiles) diagnostics.push({ code: 'CODEGRAPH_FILE_WARNINGS', severity: 'warning', message: `${counts.warningFiles} files contain warning-only CodeGraph skip markers.` });
      if (fileRecords.length === 0 && counts.nodes === 0) diagnostics.push({ code: 'CODEGRAPH_EMPTY_INDEX', severity: 'warning', message: 'CodeGraph index is complete and contains no files or nodes.' });
      db.exec('COMMIT');
      inTransaction = false;
      return { sourceRevision: sourceHash.digest('hex'), nodes: graphNodes, edges: graphEdges, evidence, diagnostics: diagnostics.map((item) => ({ ...item })) };
    } finally {
      if (connection && inTransaction) { try { connection.getDb().exec('ROLLBACK'); } catch { /* preserve the original failure */ } }
      try { connection?.close(); }
      finally { lock.release(); }
    }
    },
  };
}

function readHealthCounts(db: ReadonlyDb): DbCounts {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM nodes) AS nodes,
      (SELECT COUNT(*) FROM edges) AS edges,
      (SELECT COUNT(*) FROM files) AS files,
      (SELECT COUNT(*) FROM files WHERE language IN ('yaml','twig','properties')) AS file_only,
      (SELECT COUNT(*) FROM unresolved_refs WHERE status='pending') AS pending,
      (SELECT COUNT(*) FROM unresolved_refs WHERE status='failed') AS failed,
      (SELECT COUNT(*) FROM files f, json_each(CASE WHEN json_valid(f.errors) THEN f.errors ELSE '[]' END) e WHERE json_extract(e.value,'$.code')='parser_error') AS parser_errors,
      (SELECT COUNT(*) FROM files f WHERE f.language IN (${SUPPORTED_LANGUAGES.map(() => '?').join(',')}) AND f.language NOT IN ('yaml','twig','properties') AND f.node_count=0 AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(f.errors) THEN f.errors ELSE '[]' END) e)) AS zero_node_files,
      (SELECT COUNT(DISTINCT f.path) FROM files f, json_each(CASE WHEN json_valid(f.errors) THEN f.errors ELSE '[]' END) e WHERE json_extract(e.value,'$.severity')='warning') AS warning_files,
      (SELECT COALESCE(SUM(length(CAST(id AS BLOB))+length(CAST(kind AS BLOB))+length(CAST(name AS BLOB))+length(CAST(qualified_name AS BLOB))+length(CAST(file_path AS BLOB))+length(CAST(language AS BLOB))+length(CAST(COALESCE(docstring,'') AS BLOB))+length(CAST(COALESCE(signature,'') AS BLOB))+length(CAST(COALESCE(decorators,'') AS BLOB))+length(CAST(COALESCE(type_parameters,'') AS BLOB))+length(CAST(COALESCE(return_type,'') AS BLOB))),0) FROM nodes)
      + (SELECT COALESCE(SUM(length(CAST(source AS BLOB))+length(CAST(target AS BLOB))+length(CAST(kind AS BLOB))+length(CAST(COALESCE(metadata,'') AS BLOB))+length(CAST(COALESCE(provenance,'') AS BLOB))),0) FROM edges)
      + (SELECT COALESCE(SUM(length(CAST(path AS BLOB))+length(CAST(content_hash AS BLOB))+length(CAST(language AS BLOB))+length(CAST(COALESCE(errors,'') AS BLOB))),0) FROM files) AS bytes,
      (SELECT COUNT(*) FROM nodes WHERE MAX(length(CAST(id AS BLOB)),length(CAST(kind AS BLOB)),length(CAST(name AS BLOB)),length(CAST(qualified_name AS BLOB)),length(CAST(file_path AS BLOB)),length(CAST(language AS BLOB)),length(CAST(COALESCE(docstring,'') AS BLOB)),length(CAST(COALESCE(signature,'') AS BLOB)),length(CAST(COALESCE(decorators,'') AS BLOB)),length(CAST(COALESCE(type_parameters,'') AS BLOB)),length(CAST(COALESCE(return_type,'') AS BLOB))) > ${MAX_FIELD_BYTES})
      + (SELECT COUNT(*) FROM edges WHERE MAX(length(CAST(source AS BLOB)),length(CAST(target AS BLOB)),length(CAST(kind AS BLOB)),length(CAST(COALESCE(metadata,'') AS BLOB)),length(CAST(COALESCE(provenance,'') AS BLOB))) > ${MAX_FIELD_BYTES})
      + (SELECT COUNT(*) FROM files WHERE MAX(length(CAST(path AS BLOB)),length(CAST(content_hash AS BLOB)),length(CAST(language AS BLOB)),length(CAST(COALESCE(errors,'') AS BLOB))) > ${MAX_FIELD_BYTES}) AS oversized_fields,
      (SELECT COUNT(*) FROM nodes WHERE (decorators IS NOT NULL AND NOT json_valid(decorators)) OR (type_parameters IS NOT NULL AND NOT json_valid(type_parameters)))
      + (SELECT COUNT(*) FROM edges WHERE metadata IS NOT NULL AND NOT json_valid(metadata))
      + (SELECT COUNT(*) FROM files WHERE errors IS NOT NULL AND NOT json_valid(errors)) AS invalid_json_fields
  `).get(...SUPPORTED_LANGUAGES) as Record<string, number>;
  const counts: DbCounts = { nodes: Number(row.nodes), edges: Number(row.edges), files: Number(row.files), fileOnly: Number(row.file_only), bytes: Number(row.bytes), oversizedFields: Number(row.oversized_fields), invalidJsonFields: Number(row.invalid_json_fields), pending: Number(row.pending), failed: Number(row.failed), parserErrors: Number(row.parser_errors), zeroNodeFiles: Number(row.zero_node_files), warningFiles: Number(row.warning_files) };
  return counts;
}

function validateSnapshotHealth(counts: DbCounts): void {
  if (counts.pending > 0) throw new Error(`CodeGraph has ${counts.pending} unresolved references pending; the index is incomplete.`);
  if (counts.parserErrors > 0) throw new Error(`CodeGraph has ${counts.parserErrors} parser initialization errors; reindex with CodeGraph ${CODEGRAPH_VERSION}.`);
  if (counts.zeroNodeFiles > 0) throw new Error(`CodeGraph has ${counts.zeroNodeFiles} supported-language files with no extracted nodes and no recorded extraction error.`);
  if (counts.invalidJsonFields > 0) throw new Error(`CodeGraph contains ${counts.invalidJsonFields} malformed JSON fields.`);
}

function validateOutputBudget(counts: DbCounts): void {
  const totalItems = counts.nodes + counts.edges + counts.fileOnly;
  if (counts.files > MAX_ITEMS) throw new Error(`CodeGraph snapshot has more than ${MAX_ITEMS} source-file records.`);
  if (counts.nodes > MAX_ITEMS || counts.edges > MAX_ITEMS || totalItems > MAX_ITEMS) throw new Error(`CodeGraph snapshot exceeds the ${MAX_ITEMS}-item analyzer limit.`);
  const estimatedDerivedBytes = counts.bytes * 2 + totalItems * 256;
  if (estimatedDerivedBytes > MAX_TOTAL_BYTES) throw new Error(`Estimated CodeGraph snapshot output exceeds the ${MAX_TOTAL_BYTES}-byte aggregate budget.`);
  if (counts.oversizedFields > 0) throw new Error(`CodeGraph snapshot contains fields larger than ${MAX_FIELD_BYTES} bytes.`);
}

function loadCodeGraphSdk(packageRoot: string): CodeGraphSdk {
  const root = resolve(packageRoot);
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { name?: string; version?: string };
  if (packageJson.name !== '@colbymchenry/codegraph' || packageJson.version !== CODEGRAPH_VERSION) throw new Error(`--codegraph-sdk must point to @colbymchenry/codegraph ${CODEGRAPH_VERSION}.`);
  const require = createRequire(resolve(root, '__graphlens_loader__.cjs'));
  return require(root) as CodeGraphSdk;
}

function assertSupportedRuntime(): void {
  const match = /^(\d+)\.(\d+)\./.exec(process.versions.node);
  const major = Number(match?.[1]), minor = Number(match?.[2]);
  if (!(major === 22 && minor >= 5 || major === 23 || major === 24)) throw new Error(`CodeGraph SDK ingestion requires Node.js >=22.5 and <25; current runtime is ${process.versions.node}. GraphLens itself supports Node.js 20.`);
}

export function codeGraphRuntimeSupported(): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(process.versions.node);
  const major = Number(match?.[1]), minor = Number(match?.[2]);
  return major === 22 && minor >= 5 || major === 23 || major === 24;
}

function acquireSnapshotLock(directory: string): { release(): void } {
  const lockPath = resolve(directory, 'graphlens-snapshot.lock');
  const tempPath = resolve(directory, `.graphlens-snapshot.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
  const descriptor = openSync(tempPath, 'wx', 0o600);
  let owned: { dev: number; ino: number };
  try {
    writeFileSync(descriptor, `${process.pid}\n`);
    owned = fstatSync(descriptor);
    linkSync(tempPath, lockPath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* best effort */ }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another GraphLens CodeGraph snapshot is already running for this workspace.');
    throw new Error(`Could not acquire a non-deleting atomic CodeGraph snapshot lock: ${message(error)}`);
  } finally { closeSync(descriptor); }
  try { unlinkSync(tempPath); } catch (error) {
    try { const lockDescriptor = openSync(lockPath, 'r'); try { const current = fstatSync(lockDescriptor); if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(lockPath); } finally { closeSync(lockDescriptor); } } catch { /* keep the lock if ownership cannot be proven */ }
    throw new Error(`Could not finalize the CodeGraph snapshot lock: ${message(error)}`);
  }
  return { release() {
    try { const fd = openSync(lockPath, 'r'); try { const current = fstatSync(fd); if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(lockPath); } finally { closeSync(fd); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } };
}

function stableId(workspaceId: string, type: string, value: string): string { return `codegraph-${createHash('sha256').update(`${workspaceId}\0${type}\0${value}`).digest('hex').slice(0, 40)}`; }
function jsonRecord(value: Record<string, unknown>): Record<string, JsonValue> { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Record<string, JsonValue>; }
function toAnalysisEvidence(value: NonNullable<GraphNode['evidence']>[number], subjectKind: 'node' | 'edge', subjectId: string, index: number) {
  return { id: stableId(subjectId, 'evidence', String(index)), subjectKind, subjectId, level: 'DIRECT' as const, type: value.type, ...(value.uri ? { uri: value.uri } : {}), ...(value.line ? { line: value.line } : {}), ...(value.detail ? { detail: value.detail } : {}) };
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
