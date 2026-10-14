export { createApp } from './http/app.js';
export { GraphStore } from './infrastructure/sqlite/graph-store.js';
export { CodeGraphAdapter } from './infrastructure/codegraph/adapter.js';
export { GraphIdentityFactory, canonicalUri } from './core/graph-identity.js';
export type { Analyzer, AnalyzerCapability, AnalyzerDescriptor, AnalysisContext, AnalysisDiagnostic, AnalysisEvidence, AnalysisResult, EvidenceLevel, JsonValue } from './domain/analyzer.js';
export type { Evidence, GraphEdge, GraphNode, GraphSnapshot, Workspace } from './domain/graph.js';
