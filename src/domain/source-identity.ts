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
  identityVersion: 2;
  provider: 'codegraph';
  providerVersion: '1.6.2';
  /** Raw values exposed by the pinned provider; consumers must not normalize or infer semantics. */
  coordinateConvention: 'provider-raw';
  /** Candidate starts are provider-raw and accepted only after exact start, kind, unique-candidate, and name checks. */
  declarationAnchorConvention: 'provider-raw-start-kind-name-unique';
  workspaceId: string;
  input: AnalysisInputGeneration & { analyzerId: 'builtin.codegraph' };
  sourceRevision: string;
  repositoryKey: string;
  files: readonly SourceCatalogFile[];
  symbols: readonly SourceCatalogSymbol[];
};

/** Workspace-bound immutable reader for the active, successful CodeGraph generation. */
export type SourceCatalogReader = {
  snapshot(maxItems?: number): SourceCatalogSnapshot | undefined;
};
