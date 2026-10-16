import type { GraphEdge, GraphNode, Workspace } from './graph.js';
import type { SourceCatalogReader } from './source-identity.js';

/** IDs owned by GraphLens itself and unavailable to installed packages. */
export const BUILTIN_ANALYZER_IDS = ['builtin.demo', 'builtin.codegraph', 'builtin.python-source', 'builtin.sqlalchemy', 'builtin.fastapi', 'builtin.openapi', 'builtin.frontend-http', 'builtin.architecture'] as const;

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
  architectureInputProvider?: ArchitectureInputReader;
  /** Bounded read-only access to the active CodeGraph source catalog for this workspace. */
  sourceCatalogReader?: SourceCatalogReader;
  signal?: { aborted: boolean };
};

export type AnalysisInputGeneration = { analyzerId: string; generationId: number };
export type SourceMappingSummary = {
  contractVersion: 'source-mapping-summary-v1';
  input: { analyzerId: 'builtin.codegraph'; generationId: number };
  counts: { mapped: number; unresolved: number; unverified: number; ambiguous: number; unsupported: number };
};
export type ArchitectureInputGeneration = AnalysisInputGeneration & {
  sourceRevision?: string;
  identityVersion?: number;
  inputGenerations?: readonly AnalysisInputGeneration[];
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  evidence: readonly AnalysisEvidence[];
  diagnostics: readonly AnalysisDiagnostic[];
};
export type ArchitectureInputSnapshot = { workspaceId: string; generations: readonly ArchitectureInputGeneration[]; missingAnalyzerIds: readonly string[] };
export type ArchitectureInputProvider = {
  /** Reads only the requested active generations in one workspace-scoped snapshot. */
  snapshot(workspaceId: string, analyzerIds: readonly string[]): ArchitectureInputSnapshot;
};
/** Workspace-bound read-only view exposed to analyzer implementations. */
export type ArchitectureInputReader = {
  snapshot(analyzerIds: readonly string[]): ArchitectureInputSnapshot;
};

export type EvidenceLevel = 'DIRECT' | 'DERIVED' | 'INFERRED';
export type EvidenceSubjectKind = 'node' | 'edge';

export type AnalysisEvidence = {
  /** Stable analyzer-provided identity, preserved across generations. */
  id: string;
  subjectKind: EvidenceSubjectKind;
  subjectId: string;
  /** Exact active contribution owner attached by GraphLens storage projections. */
  analyzerId?: string;
  generationId?: number;
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
  /** Optional bounded summary of source bindings used by this semantic output. */
  sourceMappingSummary?: SourceMappingSummary;
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
  | 'ANALYZER_RETIRED'
  | 'API_VERSION_UNSUPPORTED'
  | 'DUPLICATE_ANALYZER'
  | 'INVALID_DESCRIPTOR'
  | 'WORKSPACE_NOT_FOUND'
  | 'RUN_ALREADY_ACTIVE'
  | 'PROCESS_INTERRUPTED'
  | 'ANALYZER_FAILED'
  | 'INVALID_RESULT'
  | 'PERSISTENCE_FAILED'
  | 'INPUT_GENERATION_UNAVAILABLE'
  | 'INPUT_GENERATION_CHANGED'
  | 'INPUT_GENERATION_CYCLE';

export class AnalysisError extends Error {
  constructor(public readonly code: AnalysisErrorCode, message: string, public readonly diagnostics: AnalysisDiagnostic[] = []) {
    super(message);
    this.name = 'AnalysisError';
  }
}
