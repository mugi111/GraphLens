import { AnalysisError, type AnalysisDiagnostic, type Analyzer, type AnalysisContext, type AnalysisResult } from '../../domain/analyzer.js';

export const pythonSourceAnalyzer: Analyzer = {
  descriptor: { id: 'builtin.python-source', version: '1.0.0', apiVersion: '1', capabilities: ['graph', 'evidence', 'diagnostics'] },
  async analyze(_context: AnalysisContext): Promise<AnalysisResult> { throw new AnalysisError('ANALYZER_RETIRED', 'builtin.python-source is retired. Run builtin.codegraph, then the semantic analyzers that consume its source catalog.'); },
};
