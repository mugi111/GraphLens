import { AnalysisError, type AnalysisDiagnostic, type Analyzer, type AnalysisContext, type AnalysisResult } from '../../domain/analyzer.js';
import { collectPythonSourceSnapshot } from './python-source-snapshot.js';

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
  const snapshot = await collectPythonSourceSnapshot(context);
  return { sourceRevision: snapshot.sourceRevision, nodes: snapshot.nodes, edges: snapshot.edges, evidence: snapshot.evidence, diagnostics: snapshot.diagnostics };
}

function classify(message: string) {
  if (/UTF-8/i.test(message)) return 'PYTHON_SOURCE_INVALID_ENCODING';
  if (/exceeds|combined limit|result limit|directory count|inventory/i.test(message)) return 'PYTHON_SOURCE_LIMIT_EXCEEDED';
  if (/changed during|changed while|inventory changed/i.test(message)) return 'PYTHON_SOURCE_CHANGED_DURING_SCAN';
  if (/workspace root/i.test(message)) return 'PYTHON_SOURCE_INVALID_ROOT';
  if (/option|includeStubs|excludes|maxFiles|maxFileBytes|maxTotalBytes/i.test(message)) return 'PYTHON_SOURCE_INVALID_CONFIG';
  return 'PYTHON_SOURCE_SCAN_FAILED';
}
