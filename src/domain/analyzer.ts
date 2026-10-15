import type { GraphEdge, GraphNode, Workspace } from './graph.js';

/** IDs owned by GraphLens itself and unavailable to installed packages. */
export const BUILTIN_ANALYZER_IDS = ['builtin.demo', 'builtin.codegraph', 'builtin.python-source', 'builtin.sqlalchemy', 'builtin.fastapi', 'builtin.openapi'] as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type AnalyzerCapability =
  | 'graph'
  | 'evidence'
  | 'diagnostics';

/** Public compatibility contract for an analyzer implementation. */
export type AnalyzerDescriptor = {
  id: string;
  version: string;
  apiVersion: string;
  capabilities: AnalyzerCapability[];
};

/** JSON-serializable input supplied to an analyzer. */
export type AnalysisContext = {
  workspace: Workspace;
  sourceRevision?: string;
  config: Record<string, JsonValue>;
  /** Optional read-only access to active, workspace-scoped analyzer generations. */
  architectureInputProvider?: ArchitectureInputProvider;
  signal?: { aborted: boolean };
};

export type AnalysisInputGeneration = { analyzerId: string; generationId: number };
export type ArchitectureInputGeneration = AnalysisInputGeneration & {
  sourceRevision?: string;
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  evidence: readonly AnalysisEvidence[];
  diagnostics: readonly AnalysisDiagnostic[];
};
export type ArchitectureInputSnapshot = { workspaceId: string; generations: readonly ArchitectureInputGeneration[] };
export type ArchitectureInputProvider = {
  /** Reads only the requested active generations in one workspace-scoped snapshot. */
  snapshot(workspaceId: string, analyzerIds: readonly string[]): ArchitectureInputSnapshot;
};

export type EvidenceLevel = 'DIRECT' | 'DERIVED' | 'INFERRED';
export type EvidenceSubjectKind = 'node' | 'edge';

export type AnalysisEvidence = {
  /** Stable analyzer-provided identity, preserved across generations. */
  id: string;
  subjectKind: EvidenceSubjectKind;
  subjectId: string;
  level: EvidenceLevel;
  type: string;
  uri?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  startOffset?: number;
  endOffset?: number;
  detail?: string;
  provenance?: Record<string, JsonValue>;
  inputGenerations?: string[];
  confidence?: number;
};

export type AnalysisDiagnostic = {
  code?: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  uri?: string;
  line?: number;
  detail?: Record<string, JsonValue>;
};

export type AnalysisResult = {
  /** Content-derived revision computed by source analyzers. */
  sourceRevision?: string;
  /** Exact active generations consumed to derive this result. */
  inputGenerations?: AnalysisInputGeneration[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: AnalysisEvidence[];
  diagnostics: AnalysisDiagnostic[];
};

export type Analyzer = {
  descriptor: AnalyzerDescriptor;
  analyze(context: AnalysisContext): Promise<AnalysisResult>;
};

/** Machine-readable failures returned by the analyzer host. */
export type AnalysisErrorCode =
  | 'ANALYZER_NOT_FOUND'
  | 'API_VERSION_UNSUPPORTED'
  | 'DUPLICATE_ANALYZER'
  | 'INVALID_DESCRIPTOR'
  | 'WORKSPACE_NOT_FOUND'
  | 'RUN_ALREADY_ACTIVE'
  | 'PROCESS_INTERRUPTED'
  | 'ANALYZER_FAILED'
  | 'INVALID_RESULT'
  | 'PERSISTENCE_FAILED';

export class AnalysisError extends Error {
  constructor(public readonly code: AnalysisErrorCode, message: string, public readonly diagnostics: AnalysisDiagnostic[] = []) {
    super(message);
    this.name = 'AnalysisError';
  }
}
