import { AnalysisError, type AnalysisContext, type AnalysisDiagnostic, type AnalysisEvidence, type Analyzer, type AnalysisResult } from '../../domain/analyzer.js';
import { GraphIdentityFactory } from '../../core/graph-identity.js';
import type { GraphEdge, GraphNode } from '../../domain/graph.js';
import { canonicalSqlAlchemyName, collectSqlAlchemyFiles, collectSqlAlchemySource, expressionName, localAssignmentValue, sqlAlchemyConfig } from './sqlalchemy-source-collector.js';
import type { SqlAlchemyCollectedFile, SqlAlchemyModelFact } from './sqlalchemy-source-types.js';

const identity = new GraphIdentityFactory();

export const sqlAlchemyAnalyzer: Analyzer = {
  descriptor: { id: 'builtin.sqlalchemy', version: '1.0.0', apiVersion: '1', capabilities: ['graph', 'evidence', 'diagnostics'] },
  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    try {
      const config = sqlAlchemyConfig(context.config);
      const snapshot = await collectSqlAlchemySource(context);
      const files = collectSqlAlchemyFiles(snapshot);
      const models = collectModels(files);
      return projectModels(context, config.databaseNamespace, snapshot.sourceRevision, models, snapshot.diagnostics);
    } catch (error) {
      if (error instanceof AnalysisError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new AnalysisError('ANALYZER_FAILED', message, [{ code: /databaseNamespace/i.test(message) ? 'SQLALCHEMY_INVALID_CONFIG' : 'SQLALCHEMY_ANALYSIS_FAILED', severity: 'error', message }]);
    }
  },
};

function collectModels(files: SqlAlchemyCollectedFile[]): SqlAlchemyModelFact[] {
  const allClasses = files.flatMap((file) => file.classes.map((node) => ({ file, node, path: file.path, module: String(node.properties.module), qualifiedName: String(node.properties.qualifiedName), label: node.label })));
  const classByLocal = new Map(allClasses.map((item) => [`${item.module}.${item.qualifiedName}`, item]));
  const rootVariables = new Set<string>();
  const rootClasses = new Set<string>();
  for (const file of files) {
    for (const assignment of file.assignments) {
      const target = expressionName(assignment.properties.target);
      if (!target || assignment.properties.scope !== '') continue;
      if (calls(assignment).some((call) => {
        const canonical = canonicalSqlAlchemyName(call.callee, file.imports);
        return canonical === 'sqlalchemy.orm.declarative_base' || canonical === 'sqlalchemy.orm.registry';
      })) rootVariables.add(`${moduleForAssignment(assignment)}.${target}`);
    }
    for (const klass of file.classes) {
      const key = `${String(klass.properties.module)}.${String(klass.properties.qualifiedName)}`;
      if (classBases(klass).some((base) => canonicalSqlAlchemyName(base, file.imports) === 'sqlalchemy.orm.DeclarativeBase')) rootClasses.add(key);
    }
  }
  const models = new Map<string, SqlAlchemyModelFact>();
  const rootBases = new Set([...rootVariables, ...rootClasses]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of allClasses) {
      const key = `${item.module}.${item.qualifiedName}`;
      if (rootClasses.has(key) || models.has(key)) continue;
      const bases = classBases(item.node);
      const isDerived = bases.some((base) => {
        const canonical = canonicalSqlAlchemyName(base, item.file.imports);
        return rootBases.has(`${item.module}.${canonical}`) || rootBases.has(canonical) || models.has(`${item.module}.${base}`) || classByLocal.has(`${item.module}.${base}`) && models.has(`${item.module}.${base}`);
      });
      if (!isDerived) continue;
      const tableAssignment = localAssignmentValue(item.file.assignments, '__tablename__', item.qualifiedName);
      const tableName = literalString(tableAssignment?.properties.value);
      if (!tableName) {
        if (bases.some((base) => models.has(`${item.module}.${base}`))) {
          const inherited = bases.map((base) => models.get(`${item.module}.${base}`)).find(Boolean);
          if (inherited) { models.set(key, { ...inherited, classId: item.node.id, label: item.label, qualifiedName: item.qualifiedName, bases, sourceEvidence: item.file.evidenceBySubject.get(item.node.id), columns: [] }); changed = true; }
        }
        continue;
      }
      const schema = tableSchema(item.file.assignments, item.qualifiedName);
      models.set(key, { classId: item.node.id, path: item.path, module: item.module, qualifiedName: item.qualifiedName, label: item.label, tableName, schema, bases, sourceEvidence: item.file.evidenceBySubject.get(item.node.id), tableEvidence: item.file.evidenceBySubject.get(tableAssignment!.id), columns: [] });
      changed = true;
    }
  }
  return [...models.values()].filter((model) => model.tableName).sort((a, b) => lexical(`${a.module}.${a.qualifiedName}`, `${b.module}.${b.qualifiedName}`));
}

function projectModels(context: AnalysisContext, databaseNamespace: string, sourceRevision: string, models: SqlAlchemyModelFact[], diagnostics: AnalysisDiagnostic[]): AnalysisResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const evidence: AnalysisEvidence[] = [];
  const nodesById = new Map<string, GraphNode>();
  const edgesById = new Set<string>();
  const addNode = (path: string, kind: string, label: string, key: string, properties: Record<string, unknown>, source?: AnalysisEvidence, type = 'sqlalchemy.mapping') => {
    const id = identity.node(context.workspace.id, `sqlalchemy://${path}#${key}`, kind);
    const existing = nodesById.get(id);
    if (existing) return existing;
    const node = { id, workspaceId: context.workspace.id, kind, label, properties };
    nodesById.set(id, node);
    nodes.push(node);
    evidence.push(projectEvidence('node', id, source, type, key));
    return nodes.at(-1)!;
  };
  const addEdge = (from: GraphNode, to: GraphNode, kind: string, source?: AnalysisEvidence, key = kind, level: 'DIRECT' | 'DERIVED' = 'DERIVED') => {
    const id = identity.edge(context.workspace.id, from.id, to.id, kind);
    if (edgesById.has(id)) return;
    edgesById.add(id);
    edges.push({ id, workspaceId: context.workspace.id, sourceId: from.id, targetId: to.id, kind, properties: {} });
    evidence.push(projectEvidence('edge', id, source, `sqlalchemy.${kind}`, key, level));
  };
  for (const model of models) {
    const sourceClass = addNode(model.path, 'sqlalchemy_source_class', model.label, `class/${model.qualifiedName}`, { module: model.module, qualifiedName: model.qualifiedName }, model.sourceEvidence, 'python.class');
    const modelNode = addNode(model.path, 'sqlalchemy_model', model.label, `model/${model.module}.${model.qualifiedName}`, { module: model.module, qualifiedName: model.qualifiedName, databaseNamespace, tableName: model.tableName, schema: model.schema ?? null }, model.sourceEvidence);
    addEdge(sourceClass, modelNode, 'maps_to', model.sourceEvidence, `model/${model.qualifiedName}`, 'DIRECT');
    const tableKey = `table/${model.schema ? `${model.schema}.` : ''}${model.tableName}`;
    const table = addNode(databaseNamespace, 'sqlalchemy_table', `${model.schema ? `${model.schema}.` : ''}${model.tableName}`, tableKey, { databaseNamespace, schema: model.schema ?? null, tableName: model.tableName }, model.tableEvidence ?? model.sourceEvidence, 'sqlalchemy.table');
    addEdge(modelNode, table, 'contains', model.tableEvidence ?? model.sourceEvidence, tableKey);
  }
  if (nodes.length + edges.length > 9000) throw new Error('SQLAlchemy contributions exceed the combined limit (9000).');
  if (evidence.length > 10_000) throw new Error('SQLAlchemy evidence exceeds the result limit (10000).');
  return { sourceRevision, nodes, edges, evidence, diagnostics };
}

function classBases(node: GraphNode): string[] { return Array.isArray(node.properties.bases) ? node.properties.bases.map(expressionName).filter((name): name is string => !!name) : []; }
function calls(node: GraphNode): Array<{ callee: string }> { return Array.isArray(node.properties.calls) ? node.properties.calls.filter((call): call is { callee: string } => !!call && typeof call.callee === 'string') : []; }
function literalString(value: unknown): string | undefined { if (isObject(value) && value.literalKind === 'string' && typeof value.value === 'string') return value.value; return undefined; }
function tableSchema(assignments: GraphNode[], scope: string): string | undefined {
  const assignment = localAssignmentValue(assignments, '__table_args__', scope);
  const stack: unknown[] = [assignment?.properties.value];
  while (stack.length) { const value = stack.pop(); if (!isObject(value)) continue; if (value.kind === 'DictionaryExpression' && Array.isArray(value.children)) { for (let i = 0; i + 1 < value.children.length; i += 2) { const key = value.children[i]; const item = value.children[i + 1]; if (isObject(key) && key.value === 'schema' && isObject(item) && typeof item.value === 'string') return item.value; } } if (Array.isArray(value.children)) stack.push(...value.children); }
  return undefined;
}
function moduleForAssignment(node: GraphNode) { return String(node.properties.module); }
function projectEvidence(subjectKind: 'node' | 'edge', subjectId: string, source: AnalysisEvidence | undefined, type: string, anchor: string, level: 'DIRECT' | 'DERIVED' = 'DIRECT'): AnalysisEvidence {
  const stable = `${type}:${anchor}`;
  return { id: identity.node(subjectId, `evidence:${subjectKind}`, stable), subjectKind, subjectId, level, type, ...(source?.uri ? { uri: source.uri } : {}), ...(source?.line ? { line: source.line } : {}), ...(source?.column ? { column: source.column } : {}), ...(source?.endLine ? { endLine: source.endLine } : {}), ...(source?.endColumn ? { endColumn: source.endColumn } : {}), ...(source?.startOffset !== undefined ? { startOffset: source.startOffset } : {}), ...(source?.endOffset !== undefined ? { endOffset: source.endOffset } : {}) };
}
function isObject(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function lexical(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
