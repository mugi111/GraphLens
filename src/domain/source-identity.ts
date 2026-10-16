import type { AnalysisInputGeneration } from './analyzer.js';

export type SourceCatalogFile = {
  fileId: string;
  repositoryKey: string;
  relativePath: string;
  contentDigest: { algorithm: 'sha256'; encoding: 'utf8-text'; value: string; providerVersion: string };
};

export type SourceCatalogSymbol = {
  nodeId: string;
  upstreamId: string;
  kind: string;
  relativePath: string;
  name: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

export type SourceCatalogSnapshot = {
  workspaceId: string;
  input: AnalysisInputGeneration & { analyzerId: 'builtin.codegraph' };
  repositoryKey: string;
  files: readonly SourceCatalogFile[];
  symbols: readonly SourceCatalogSymbol[];
};

/** Workspace-bound immutable reader for the active, successful CodeGraph generation. */
export type SourceCatalogReader = {
  snapshot(maxItems?: number): SourceCatalogSnapshot | undefined;
};
