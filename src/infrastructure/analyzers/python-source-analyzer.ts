import { AnalysisError, type AnalysisDiagnostic, type Analyzer, type AnalysisContext, type AnalysisResult } from '../../domain/analyzer.js';
import type { GraphNode } from '../../domain/graph.js';
import { pythonSourceRevision } from './python-source-content.js';
import { parsePythonSourceFile } from './python-source-parser.js';
import { readStablePythonSources, pythonSourceConfig } from './python-source-scanner.js';
import { resolvePythonImports } from './python-source-resolver.js';
import { PYTHON_SOURCE_LIMITS } from './python-source-types.js';

export const pythonSourceAnalyzer: Analyzer = {
  descriptor: { id: 'builtin.python-source', version: '1.0.0', apiVersion: '1', capabilities: ['graph', 'evidence', 'diagnostics'] },
  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    try { return await analyzePythonSource(context); }
    catch (error) {
      if (error instanceof AnalysisError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const code = classify(message);
      throw new AnalysisError('ANALYZER_FAILED', message, [{ code, severity: 'error', message }]);
    }
  },
};

async function analyzePythonSource(context: AnalysisContext): Promise<AnalysisResult> {
  const config = pythonSourceConfig(context.config);
  const files = await readStablePythonSources(context.workspace.path, config);
  const sourceRevision = pythonSourceRevision(config, files);
  if (context.sourceRevision !== undefined && context.sourceRevision !== sourceRevision) {
    const message = 'Computed Python source revision does not match the requested revision.';
    throw new AnalysisError('INVALID_RESULT', message, [{ code: 'SOURCE_REVISION_MISMATCH', severity: 'error', message }]);
  }
  const nodes: GraphNode[] = [];
  const edges: AnalysisResult['edges'] = [];
  const evidence: AnalysisResult['evidence'] = [];
  const diagnostics: AnalysisDiagnostic[] = [];
  const imports = [];
  for (const file of files) {
    const parsed = parsePythonSourceFile(context.workspace, file);
    nodes.push(...parsed.nodes);
    edges.push(...parsed.edges);
    evidence.push(...parsed.evidence);
    diagnostics.push(...parsed.diagnostics);
    imports.push(...parsed.imports);
    assertCapacity(nodes.length, edges.length, diagnostics.length);
  }
  const resolution = resolvePythonImports(context.workspace, imports, nodes);
  nodes.push(...resolution.nodes);
  edges.push(...resolution.edges);
  evidence.push(...resolution.evidence);
  assertCapacity(nodes.length, edges.length, diagnostics.length);
  return { sourceRevision, nodes, edges, evidence, diagnostics };
}

function assertCapacity(nodes: number, edges: number, diagnostics: number) {
  if (nodes + edges > PYTHON_SOURCE_LIMITS.maxContributions) throw new Error(`Python source contributions exceed the combined limit (${PYTHON_SOURCE_LIMITS.maxContributions}).`);
  if (diagnostics > 10_000) throw new Error('Python source diagnostics exceed the result limit.');
}

function classify(message: string) {
  if (/UTF-8/i.test(message)) return 'PYTHON_SOURCE_INVALID_ENCODING';
  if (/exceeds max|combined limit|result limit/i.test(message)) return 'PYTHON_SOURCE_LIMIT_EXCEEDED';
  if (/changed during|changed while|inventory changed/i.test(message)) return 'PYTHON_SOURCE_CHANGED_DURING_SCAN';
  if (/workspace root/i.test(message)) return 'PYTHON_SOURCE_INVALID_ROOT';
  if (/option|includeStubs|excludes|maxFiles|maxFileBytes|maxTotalBytes/i.test(message)) return 'PYTHON_SOURCE_INVALID_CONFIG';
  return 'PYTHON_SOURCE_SCAN_FAILED';
}
