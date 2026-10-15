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
  primaryKey?: boolean | null;
  nullable?: boolean | null;
  unique?: boolean | null;
  index?: boolean | null;
  foreignKeys: Array<{ target: string; sourceEvidence?: AnalysisEvidence }>;
  relationships: Array<{ target?: string; targetKind?: 'class' | 'literal' | 'annotation' | 'unresolved'; backPopulates?: string; backref?: string; uselist?: boolean | null; sourceEvidence?: AnalysisEvidence }>;
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
  constraints: SqlAlchemyConstraintFact[];
  relationships: SqlAlchemyRelationshipFact[];
};
export type SqlAlchemyConstraintFact = { kind: 'primary_key' | 'unique' | 'foreign_key' | 'index'; name?: string; columns: string[]; references: string[]; sourceEvidence?: AnalysisEvidence };
export type SqlAlchemyRelationshipFact = { name: string; target?: string; targetKind: 'class' | 'literal' | 'annotation' | 'unresolved'; backPopulates?: string; backref?: string; uselist?: boolean | null; sourceEvidence?: AnalysisEvidence };
export type SqlAlchemyCollectedFile = {
  path: string;
  imports: SqlAlchemyImportBinding;
  classes: GraphNode[];
  assignments: GraphNode[];
  evidenceBySubject: Map<string, AnalysisEvidence>;
};

export type SqlAlchemyExpression = PythonExpressionFact;
