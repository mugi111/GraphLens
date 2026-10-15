import type { AnalysisDiagnostic, AnalysisEvidence } from '../../domain/analyzer.js';
import type { GraphEdge, GraphNode } from '../../domain/graph.js';
import type { PythonExpressionFact } from './python-source-types.js';

export type SqlAlchemyConfig = { databaseNamespace: string };
export type SqlAlchemyResult = { sourceRevision: string; nodes: GraphNode[]; edges: GraphEdge[]; evidence: AnalysisEvidence[]; diagnostics: AnalysisDiagnostic[] };
export type SqlAlchemyImportBinding = Map<string, string>;
export type SqlAlchemyColumnFact = {
  name: string;
  targetId: string;
  assignmentId: string;
  typeName?: string;
  primaryKey?: boolean;
  nullable?: boolean;
  unique?: boolean;
  index?: boolean;
  foreignKeys: Array<{ target: string; evidenceId: string }>;
  relationships: Array<{ target?: string; backPopulates?: string; backref?: string; uselist?: boolean; evidenceId: string }>;
  sourceEvidence?: AnalysisEvidence;
};
export type SqlAlchemyModelFact = {
  classId: string;
  path: string;
  module: string;
  qualifiedName: string;
  label: string;
  tableName: string;
  schema?: string;
  bases: string[];
  sourceEvidence?: AnalysisEvidence;
  tableEvidence?: AnalysisEvidence;
  columns: SqlAlchemyColumnFact[];
};
export type SqlAlchemyCollectedFile = {
  path: string;
  imports: SqlAlchemyImportBinding;
  classes: GraphNode[];
  assignments: GraphNode[];
  evidenceBySubject: Map<string, AnalysisEvidence>;
};

export type SqlAlchemyExpression = PythonExpressionFact;
