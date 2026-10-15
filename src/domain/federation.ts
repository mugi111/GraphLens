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
  inputGenerations: Array<{ analyzerId: string; generationId: number }>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: AnalysisEvidence[];
  diagnostics: AnalysisDiagnostic[];
};

export type CrossWorkspaceSnapshot = {
  snapshotId: string;
  requestedWorkspaceIds: string[];
  generations: WorkspaceArchitectureSnapshot[];
  missingArchitectureWorkspaceIds: string[];
};
