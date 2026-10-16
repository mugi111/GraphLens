import type { AnalysisContext, AnalysisDiagnostic, AnalysisEvidence } from '../../domain/analyzer.js';
import type { GraphEdge, GraphNode } from '../../domain/graph.js';
import { pythonSourceRevision } from './python-source-content.js';
import { parsePythonSourceFile, type ParsedPythonFile } from './python-source-parser.js';
import { readStablePythonSources, pythonSourceConfig } from './python-source-scanner.js';
import { resolvePythonImports } from './python-source-resolver.js';
import { PYTHON_SOURCE_LIMITS, type PythonSourceConfig, type PythonSourceFile } from './python-source-types.js';
import { adoptDeclarationIdentities, requireSourceCatalog } from './source-catalog-adoption.js';
import type { SourceCatalogSnapshot } from '../../domain/source-identity.js';

export type PythonSourceSnapshot = {
  sourceRevision: string;
  scanConfig: PythonSourceConfig;
  files: PythonSourceFile[];
  parsedFiles: Array<{ file: PythonSourceFile; parsed: ParsedPythonFile }>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: AnalysisEvidence[];
  diagnostics: AnalysisDiagnostic[];
  sourceCatalog: SourceCatalogSnapshot;
};

/** Read and parse one bounded Python snapshot for static analyzers. This does not run a generation. */
export async function collectPythonSourceSnapshot(context: AnalysisContext): Promise<PythonSourceSnapshot> {
  const config = pythonSourceConfig(context.config);
  const files = await readStablePythonSources(context.workspace.path, config);
  const sourceRevision = pythonSourceRevision(config, files);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const evidence: AnalysisEvidence[] = [];
  const diagnostics: AnalysisDiagnostic[] = [];
  const imports = [];
  let evidenceCount = 0;
  let importCount = 0;
  const parsedFiles: PythonSourceSnapshot['parsedFiles'] = [];
  for (const file of files) {
    const parsed = parsePythonSourceFile(context.workspace, file);
    parsedFiles.push({ file, parsed });
    nodes.push(...parsed.nodes);
    edges.push(...parsed.edges);
    evidence.push(...parsed.evidence);
    diagnostics.push(...parsed.diagnostics);
    imports.push(...parsed.imports);
    evidenceCount += parsed.evidence.length;
    importCount += parsed.imports.length;
    assertCapacity(nodes.length, edges.length, diagnostics.length);
    if (evidenceCount > 10_000) throw new Error('Python source evidence exceeds the result limit (10000).');
    if (importCount > 10_000) throw new Error('Python source import facts exceed the result limit (10000).');
  }
  const resolution = resolvePythonImports(context.workspace, imports, nodes);
  nodes.push(...resolution.nodes);
  edges.push(...resolution.edges);
  evidence.push(...resolution.evidence);
  assertCapacity(nodes.length, edges.length, diagnostics.length);
  if (evidence.length > 10_000) throw new Error('Python source evidence exceeds the result limit (10000).');
  const sourceCatalog = requireSourceCatalog(context, files);
  const replacements = adoptDeclarationIdentities(context.workspace.id, sourceCatalog, nodes, edges, evidence, diagnostics);
  for (const imported of imports) imported.ownerId = replacements.get(imported.ownerId) ?? imported.ownerId;
  for (const item of parsedFiles) {
    for (const imported of item.parsed.imports) imported.ownerId = replacements.get(imported.ownerId) ?? imported.ownerId;
  }
  return { sourceRevision, scanConfig: config, files, parsedFiles, nodes, edges, evidence, diagnostics, sourceCatalog };
}

function assertCapacity(nodes: number, edges: number, diagnostics: number) {
  if (nodes + edges > PYTHON_SOURCE_LIMITS.maxContributions) throw new Error(`Python source contributions exceed the combined limit (${PYTHON_SOURCE_LIMITS.maxContributions}).`);
  if (diagnostics > 10_000) throw new Error('Python source diagnostics exceed the result limit.');
}
