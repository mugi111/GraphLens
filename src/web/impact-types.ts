export type ImpactNode = {
  id: string; scope: 'workspace' | 'global'; workspaceId?: string; kind: string; label: string;
  properties: Record<string, unknown>; level: 'DIRECT' | 'DERIVED' | 'INFERRED'; distance: number;
  impactRole: 'target' | 'dependent' | 'dependency';
};
export type ImpactEdge = {
  id: string; scope: 'workspace' | 'cross-workspace'; sourceId: string; targetId: string;
  sourceWorkspaceId?: string; targetWorkspaceId?: string; kind: string; level: 'DIRECT' | 'DERIVED' | 'INFERRED';
  properties: Record<string, unknown>; evidence: Array<{ id: string; subjectId: string; type: string; level: string; sources: Array<{ workspaceId: string; analyzerId: string; generationId: number; nodeId: string; evidenceIds: string[] }>; sourceReferences?: Array<{ workspaceId: string; analyzerId: string; generationId: number; evidenceIds: string[] }>; sourceLocationsUnavailable?: boolean }>;
};
export type ImpactPath = { nodeId: string; nodeIds: string[]; edgeIds: string[]; workspaceIds: string[]; level: 'DIRECT' | 'DERIVED' | 'INFERRED' };
export type GenerationRef = { workspaceId: string; analyzerId: string; generationId: number; runId: string; sourceRevision?: string; completedAt: string };
export type ImpactResult = {
  scope: { workspaceIds: string[]; workspaces: Array<{ id: string; name: string }>; missingArchitectureWorkspaceIds: string[] };
  snapshot: { id: string; generations: GenerationRef[]; inputGenerations: Array<{ workspaceId: string; analyzerId: string; generationId: number }> };
  query: { node: string; direction: 'dependents' | 'dependencies' | 'both'; depth: number; includeInferred: boolean };
  target: { id: string; scope: 'workspace' | 'global'; workspaceId?: string; kind: string; label: string; properties: Record<string, unknown>; level: string };
  summary: { impactedNodeCount: number; edgeCount: number; workspaceCount: number; maxDistance: number; inferredPathCount: number };
  nodes: ImpactNode[]; edges: ImpactEdge[]; paths: ImpactPath[]; findings: ImpactNode[];
  evidence?: Array<{ id: string; subjectKind: 'node' | 'edge'; subjectId: string; type: string; level: string; sources: Array<{ workspaceId: string; analyzerId: string; generationId: number; nodeId: string; evidenceIds: string[] }>; sourceReferences?: Array<{ workspaceId: string; analyzerId: string; generationId: number; evidenceIds: string[] }>; sourceLocationsUnavailable?: boolean }>;
  diagnostics?: Array<{ code?: string; severity: string; message: string; uri?: string; line?: number; detail?: unknown }>;
};
export type RootPage = { scope: { missingArchitectureWorkspaceIds: string[] }; rootIds: string[]; nodes: Array<{ id: string; scope: string; workspaceId?: string; kind: string; label: string; properties: Record<string, unknown>; level: string }>; edges: Array<{ id: string; sourceId: string; targetId: string; scope: string; kind: string; level: string; properties: Record<string, unknown>; evidence: unknown[] }>; page: { nextCursor?: string; totalRootCount: number } };
