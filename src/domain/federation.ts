import type { AnalysisDiagnostic, AnalysisEvidence } from './analyzer.js';
import type { GraphEdge, GraphNode } from './graph.js';

export type ArchitectureGenerationRef = {
  workspaceId: string;
  analyzerId: 'builtin.architecture';
  generationId: number;
  runId: string;
  sourceRevision?: string;
  completedAt: string;
};

export type WorkspaceArchitectureSnapshot = {
  workspace: { id: string; name: string };
  generation: ArchitectureGenerationRef;
  inputGenerations: ReadonlyArray<{ analyzerId: string; generationId: number }>;
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  evidence: readonly AnalysisEvidence[];
  diagnostics: readonly AnalysisDiagnostic[];
};

export type CrossWorkspaceSnapshot = {
  snapshotId: string;
  requestedWorkspaceIds: readonly string[];
  generations: readonly WorkspaceArchitectureSnapshot[];
  missingArchitectureWorkspaceIds: readonly string[];
};

export type ApiContractKey = { namespace: string; method: string; path: string };

export type SystemNode =
  | { scope: 'workspace'; workspaceId: string; id: string; kind: string; label: string; properties: Record<string, unknown>; level: 'DIRECT' | 'DERIVED' | 'INFERRED' }
  | { scope: 'global'; id: string; kind: 'api_contract'; label: string; properties: ApiContractKey; level: 'DERIVED' };

export type CrossWorkspaceEvidence = {
  id: string;
  subjectKind: 'node' | 'edge';
  subjectId: string;
  level: 'DERIVED' | 'INFERRED';
  type: string;
  sources: ReadonlyArray<{ workspaceId: string; analyzerId: string; generationId: number; nodeId: string; evidenceIds: readonly string[] }>;
  /** Original file evidence resolved through the selected architecture evidence provenance and its recorded input generations. */
  sourceReferences?: ReadonlyArray<{ workspaceId: string; analyzerId: string; generationId: number; evidenceIds: readonly string[] }>;
  sourceLocationsUnavailable?: boolean;
  detail?: string;
};

export type ArchitectureEdgeKind = 'implements_contract' | 'architecture_contract_finding' | 'exposes' | 'handled_by' | 'depends_on' | 'calls' | 'references' | 'accepts' | 'returns' | 'uses_schema' | 'secured_by' | 'uses_scheme' | 'maps_to' | 'contains' | 'accesses_model' | 'http_request';

export type SystemEdge = {
  id: string;
  scope: 'workspace' | 'cross-workspace';
  sourceId: string;
  targetId: string;
  sourceWorkspaceId?: string;
  targetWorkspaceId?: string;
  kind: ArchitectureEdgeKind | 'provides_contract' | 'defines_contract' | 'consumes_contract';
  level: 'DIRECT' | 'DERIVED' | 'INFERRED';
  properties: Record<string, unknown>;
  evidence: readonly CrossWorkspaceEvidence[];
};

export type CrossWorkspaceResolution = {
  snapshotId: string;
  requestedWorkspaceIds: readonly string[];
  missingArchitectureWorkspaceIds: readonly string[];
  nodes: readonly SystemNode[];
  edges: readonly SystemEdge[];
  diagnostics: readonly AnalysisDiagnostic[];
};
