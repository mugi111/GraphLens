export type GraphNode = {
  id: string;
  workspaceId: string;
  kind: string;
  label: string;
  properties: Record<string, unknown>;
  evidence?: Evidence[];
};

export type GraphEdge = {
  id: string;
  workspaceId: string;
  sourceId: string;
  targetId: string;
  kind: string;
  properties: Record<string, unknown>;
};

export type Evidence = { type: string; uri?: string; line?: number; detail?: string };

export type GraphSnapshot = {
  workspace: Workspace;
  nodes: GraphNode[];
  edges: GraphEdge[];
  source: 'codegraph' | 'demo';
};

export type Workspace = { id: string; path: string; name: string };

export type Capability = { supported: boolean; detail: string };
export type CodeGraphStatus = {
  configured: boolean;
  connected: boolean;
  fullEnumeration: Capability;
  detail: string;
};
