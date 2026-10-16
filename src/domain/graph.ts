export type GraphNode = {
  id: string;
  workspaceId: string;
  kind: string;
  label: string;
  properties: Record<string, unknown>;
  evidence?: Evidence[];
  analyzerId?: string;
  generationId?: number;
  level?: 'DIRECT' | 'DERIVED' | 'INFERRED';
};

export type GraphEdge = {
  id: string;
  workspaceId: string;
  sourceId: string;
  targetId: string;
  kind: string;
  properties: Record<string, unknown>;
  evidence?: Evidence[];
  analyzerId?: string;
  generationId?: number;
  level?: 'DIRECT' | 'DERIVED' | 'INFERRED';
};

export type Evidence = {
  id?: string;
  subjectKind?: 'node' | 'edge';
  subjectId?: string;
  type: string;
  uri?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  startOffset?: number;
  endOffset?: number;
  detail?: string;
  level?: 'DIRECT' | 'DERIVED' | 'INFERRED';
  provenance?: Record<string, unknown>;
  inputGenerations?: string[];
  confidence?: number;
  analyzerId?: string;
  generationId?: number;
};

export type GraphSnapshot = {
  workspace: Workspace;
  nodes: GraphNode[];
  edges: GraphEdge[];
  source: 'codegraph';
};

export type Workspace = { id: string; path: string; name: string };

export type Capability = { supported: boolean; detail: string };
export type CodeGraphStatus = {
  configured: boolean;
  connected: boolean;
  fullEnumeration: Capability;
  detail: string;
};
