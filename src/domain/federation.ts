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
