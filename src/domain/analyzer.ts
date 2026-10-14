import type { GraphEdge, GraphNode, Workspace } from './graph.js';

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
  signal?: { aborted: boolean };
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
