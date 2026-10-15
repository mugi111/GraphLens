import type { AnalysisDiagnostic, AnalysisEvidence } from '../../domain/analyzer.js';
import type { GraphEdge, GraphNode } from '../../domain/graph.js';

export type PythonSourceConfig = {
  includeStubs: boolean;
  excludes: string[];
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

export type PythonSourceFile = { path: string; bytes: Buffer; hash: string; source: string };
export type PythonSourceFacts = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: AnalysisEvidence[];
  diagnostics: AnalysisDiagnostic[];
  imports: PythonImportFact[];
};
export type PythonExpressionFact = { kind: string; name?: string; property?: string; literalKind?: string; children?: PythonExpressionFact[] };
export type PythonParameterFact = { name: string; kind: 'positional_or_keyword' | 'positional_only' | 'keyword_only' | 'var_positional' | 'var_keyword'; annotation?: PythonExpressionFact; hasDefault: boolean };
export type PythonCallFact = { callee: string; arguments: Array<{ kind: 'positional' | 'keyword'; keyword?: string; literalKind: string }>; line: number; column: number };
export type PythonDecoratorFact = { name: string; arguments: PythonExpressionFact[] };
export type PythonImportFact = { file: string; module: string; imported?: string; alias?: string; relativeLevel: number; occurrence?: number; line: number; column: number; endLine: number; endColumn: number; startOffset: number; endOffset: number };

export const DEFAULT_PYTHON_SOURCE_CONFIG: PythonSourceConfig = {
  includeStubs: true,
  excludes: [],
  maxFiles: 5000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

export const PYTHON_SOURCE_LIMITS = {
  maxFiles: 5000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxContributions: 9000,
} as const;
