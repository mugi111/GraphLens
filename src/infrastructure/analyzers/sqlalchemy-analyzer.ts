import { AnalysisError, type AnalysisContext, type AnalysisDiagnostic, type AnalysisEvidence, type Analyzer, type AnalysisResult } from '../../domain/analyzer.js';
import { GraphIdentityFactory } from '../../core/graph-identity.js';
import type { GraphEdge, GraphNode } from '../../domain/graph.js';
import { canonicalSqlAlchemyName, collectSqlAlchemyFiles, collectSqlAlchemySource, expressionName, localAssignmentValue, sqlAlchemyConfig } from './sqlalchemy-source-collector.js';
import type { SqlAlchemyCollectedFile, SqlAlchemyModelFact } from './sqlalchemy-source-types.js';
import type { PythonExpressionFact } from './python-source-types.js';

const identity = new GraphIdentityFactory();

export const sqlAlchemyAnalyzer: Analyzer = {
  descriptor: { id: 'builtin.sqlalchemy', version: '1.0.0', apiVersion: '1', capabilities: ['graph', 'evidence', 'diagnostics'] },
  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    try {
      const config = sqlAlchemyConfig(context.config);
      const snapshot = await collectSqlAlchemySource(context);
      const files = collectSqlAlchemyFiles(snapshot);
      const diagnostics = [...snapshot.diagnostics];
      const models = collectModels(files, diagnostics);
      return projectModels(context, config.databaseNamespace, snapshot.sourceRevision, files, models, diagnostics);
    } catch (error) {
      if (error instanceof AnalysisError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new AnalysisError('ANALYZER_FAILED', message, [{ code: /databaseNamespace/i.test(message) ? 'SQLALCHEMY_INVALID_CONFIG' : 'SQLALCHEMY_ANALYSIS_FAILED', severity: 'error', message }]);
    }
  },
};

function collectModels(files: SqlAlchemyCollectedFile[], diagnostics: AnalysisDiagnostic[]): SqlAlchemyModelFact[] {
  const allClasses = files.flatMap((file) => file.classes.map((node) => ({ file, node, path: file.path, module: String(node.properties.module), qualifiedName: String(node.properties.qualifiedName), label: node.label })));
  const classByLocal = new Map(allClasses.map((item) => [`${item.module}.${item.qualifiedName}`, item]));
  const rootVariables = new Set<string>();
  const rootClasses = new Set<string>();
  for (const file of files) {
    for (const assignment of file.assignments) {
      const target = expressionName(assignment.properties.target);
      if (!target || assignment.properties.scope !== '') continue;
      const valueName = expressionName(assignment.properties.value);
      if (calls(assignment).some((call) => {
        const canonical = canonicalSqlAlchemyName(call.callee, file.imports);
        return canonical === 'sqlalchemy.orm.declarative_base' || canonical === 'sqlalchemy.ext.declarative.declarative_base';
      }) || valueName?.endsWith('.generate_base') && calls(assignment).some((call) => canonicalSqlAlchemyName(call.callee, file.imports) === 'sqlalchemy.orm.registry')) rootVariables.add(`${moduleForAssignment(assignment)}.${target}`);
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
      const tableAssignment = localAssignmentValue(item.file.assignments, '__tablename__', item.qualifiedName);
      const tableName = literalString(tableAssignment?.properties.value);
      if (!isDerived) {
        if (tableAssignment) diagnostics.push(sourceDiagnostic('SQLALCHEMY_DYNAMIC_BASE', `Could not statically resolve SQLAlchemy base for '${item.qualifiedName}'.`, item.file.evidenceBySubject.get(item.node.id)));
        continue;
      }
      if (tableAssignment && !tableName) {
        diagnostics.push(sourceDiagnostic('SQLALCHEMY_DYNAMIC_TABLE_NAME', `Could not statically resolve table name for '${item.qualifiedName}'.`, item.file.evidenceBySubject.get(tableAssignment.id)));
        continue;
      }
      if (!tableName) {
        if (bases.some((base) => models.has(`${item.module}.${base}`))) {
          const inherited = bases.map((base) => models.get(`${item.module}.${base}`)).find(Boolean);
          if (inherited) { models.set(key, { ...inherited, classId: item.node.id, path: item.path, module: item.module, label: item.label, qualifiedName: item.qualifiedName, bases, sourceEvidence: item.file.evidenceBySubject.get(item.node.id), columns: [], constraints: [] }); changed = true; }
        }
        continue;
      }
      const schema = tableSchema(item.file.assignments, item.qualifiedName);
      models.set(key, { classId: item.node.id, path: item.path, module: item.module, qualifiedName: item.qualifiedName, label: item.label, tableName, schema, bases, sourceEvidence: item.file.evidenceBySubject.get(item.node.id), tableEvidence: item.file.evidenceBySubject.get(tableAssignment!.id), columns: [], constraints: [] });
      changed = true;
    }
  }
  const collected = [...models.values()].filter((model) => model.tableName).sort((a, b) => lexical(`${a.module}.${a.qualifiedName}`, `${b.module}.${b.qualifiedName}`));
  for (const model of collected) {
    const file = files.find((candidate) => candidate.path === model.path)!;
    const seen = new Set<string>();
    for (const assignment of file.assignments.filter((node) => node.properties.scope === model.qualifiedName)) {
      const column = columnFact(assignment, file);
      if (column?.diagnostic) diagnostics.push(column.diagnostic);
      if (column && !seen.has(column.name)) { model.columns.push(column); seen.add(column.name); }
    }
    model.constraints = tableConstraints(file.assignments, model.qualifiedName, file, model.columns);
  }
  return collected;
}

function projectModels(context: AnalysisContext, databaseNamespace: string, sourceRevision: string, files: SqlAlchemyCollectedFile[], models: SqlAlchemyModelFact[], diagnostics: AnalysisDiagnostic[]): AnalysisResult {
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
    const sourceClass = files.flatMap((file) => file.classes).find((node) => node.id === model.classId);
    if (!sourceClass) continue;
    if (!nodesById.has(sourceClass.id)) { nodesById.set(sourceClass.id, sourceClass); nodes.push(sourceClass); }
    if (model.sourceEvidence) evidence.push({ ...model.sourceEvidence, id: identity.node(sourceClass.id, 'evidence:node', 'sqlalchemy.source-class'), subjectId: sourceClass.id, type: 'sqlalchemy.source-class' });
    const modelNode = addNode(model.path, 'sqlalchemy_model', model.label, `model/${model.module}.${model.qualifiedName}`, { module: model.module, qualifiedName: model.qualifiedName, databaseNamespace, tableName: model.tableName, schema: model.schema ?? null }, model.sourceEvidence);
    addEdge(sourceClass, modelNode, 'maps_to', model.sourceEvidence, `model/${model.qualifiedName}`, 'DIRECT');
    const tableKey = `table/${model.schema ? `${model.schema}.` : ''}${model.tableName}`;
    const table = addNode(databaseNamespace, 'sqlalchemy_table', `${model.schema ? `${model.schema}.` : ''}${model.tableName}`, tableKey, { databaseNamespace, schema: model.schema ?? null, tableName: model.tableName }, model.tableEvidence ?? model.sourceEvidence, 'sqlalchemy.table');
    addEdge(modelNode, table, 'contains', model.tableEvidence ?? model.sourceEvidence, tableKey);
    for (const column of model.columns) {
      const key = `column/${model.schema ? `${model.schema}.` : ''}${model.tableName}.${column.name}`;
      const columnNode = addNode(databaseNamespace, 'sqlalchemy_column', column.name, key, { databaseNamespace, tableName: model.tableName, schema: model.schema ?? null, columnName: column.name, typeName: column.typeName ?? null, primaryKey: column.primaryKey ?? null, nullable: column.nullable ?? null, unique: column.unique ?? null, index: column.index ?? null }, column.sourceEvidence, 'sqlalchemy.column');
      addEdge(table, columnNode, 'contains', column.sourceEvidence, key);
    }
    for (const constraint of model.constraints) {
      const key = `constraint/${model.schema ? `${model.schema}.` : ''}${model.tableName}/${constraint.kind}/${constraint.name ?? constraint.columns.join(',')}`;
      const node = addNode(databaseNamespace, 'sqlalchemy_constraint', constraint.name ?? constraint.kind, key, { databaseNamespace, tableName: model.tableName, schema: model.schema ?? null, constraintKind: constraint.kind, columns: constraint.columns, references: constraint.references }, constraint.sourceEvidence, `sqlalchemy.${constraint.kind}`);
      addEdge(table, node, 'contains', constraint.sourceEvidence, key);
    }
  }
  if (nodes.length + edges.length > 9000) throw new Error('SQLAlchemy contributions exceed the combined limit (9000).');
  if (evidence.length > 10_000) throw new Error('SQLAlchemy evidence exceeds the result limit (10000).');
  return { sourceRevision, nodes, edges, evidence, diagnostics };
}

function classBases(node: GraphNode): string[] { return Array.isArray(node.properties.bases) ? node.properties.bases.map(expressionName).filter((name): name is string => !!name) : []; }
type CallFact = { callee: string; arguments?: Array<{ kind: 'positional' | 'keyword'; keyword?: string; expression?: PythonExpressionFact }> };
function calls(node: GraphNode): CallFact[] { return Array.isArray(node.properties.calls) ? node.properties.calls.filter((call): call is CallFact => !!call && typeof call.callee === 'string') : []; }
function columnFact(assignment: GraphNode, file: SqlAlchemyCollectedFile) {
  const name = expressionName(assignment.properties.target);
  if (!name || name.startsWith('__')) return undefined;
  const annotation = asExpression(assignment.properties.annotation);
  const value = asExpression(assignment.properties.value);
  const mappedType = mappedTypeName(annotation, file.imports);
  const valueName = expressionName(value);
  const callFacts = calls(assignment);
  const canonicalCallName = (name: string) => canonicalSqlAlchemyName(name, file.imports);
  if (callFacts.some((call) => canonicalCallName(call.callee) === 'sqlalchemy.orm.relationship')) return undefined;
  const columnCall = callFacts.find((call) => ['sqlalchemy.orm.mapped_column', 'sqlalchemy.Column', 'sqlalchemy.sql.schema.Column'].includes(canonicalCallName(call.callee)));
  if (!mappedType && !columnCall && !['sqlalchemy.orm.mapped_column', 'sqlalchemy.Column', 'sqlalchemy.sql.schema.Column'].includes(canonicalCallName(valueName ?? ''))) return undefined;
  const args = value?.arguments ?? [];
  const kwargs = new Map(args.filter((arg) => arg.kind === 'keyword' && arg.keyword).map((arg) => [arg.keyword!, arg.expression]));
  const dynamicFlags = ['primary_key', 'nullable', 'unique', 'index'].filter((key) => kwargs.has(key) && booleanLiteral(kwargs.get(key)) === undefined);
  const explicitOrDefault = (key: string, fallback: boolean): boolean | null => kwargs.has(key) ? booleanLiteral(kwargs.get(key)) ?? null : fallback;
  const primaryKey = explicitOrDefault('primary_key', false);
  const nullable = kwargs.has('nullable') ? booleanLiteral(kwargs.get('nullable')) ?? null : primaryKey === true ? false : primaryKey === null ? null : mappedType ? !isNonOptionalMappedType(annotation) : true;
  const firstPositional = args.find((arg) => arg.kind === 'positional')?.expression;
  const typeName = mappedType ?? expressionName(firstPositional);
  return { name, targetId: assignment.id, assignmentId: assignment.id, typeName, primaryKey, nullable, unique: explicitOrDefault('unique', false), index: explicitOrDefault('index', false), foreignKeys: [], relationships: [], sourceEvidence: file.evidenceBySubject.get(assignment.id), ...(dynamicFlags.length ? { diagnostic: sourceDiagnostic('SQLALCHEMY_DYNAMIC_COLUMN_OPTION', `Could not statically resolve ${dynamicFlags.join(', ')} for column '${name}'.`, file.evidenceBySubject.get(assignment.id)) } : {}) };
}
function mappedTypeName(annotation: PythonExpressionFact | undefined, imports: Map<string, string>): string | undefined {
  if (!annotation || annotation.kind !== 'member' || !annotation.children?.[0]) return undefined;
  const base = expressionName(annotation.children[0]);
  return base && canonicalSqlAlchemyName(base, imports) === 'sqlalchemy.orm.Mapped' ? annotation.property : undefined;
}
function isNonOptionalMappedType(annotation: PythonExpressionFact | undefined) { return !!annotation?.property && !/(?:^|\.)Optional(?:\.|$)|None/.test(annotation.property); }
function asExpression(value: unknown): PythonExpressionFact | undefined { return typeof value === 'object' && value !== null ? value as PythonExpressionFact : undefined; }
function booleanLiteral(value: PythonExpressionFact | undefined): boolean | undefined { return value?.literalKind === 'boolean' && typeof value.value === 'boolean' ? value.value : undefined; }
function literalString(value: unknown): string | undefined { if (isObject(value) && value.literalKind === 'string' && typeof value.value === 'string') return value.value; return undefined; }
function tableConstraints(assignments: GraphNode[], scope: string, file: SqlAlchemyCollectedFile, columns: SqlAlchemyModelFact['columns']): SqlAlchemyModelFact['constraints'] {
  const assignment = localAssignmentValue(assignments, '__table_args__', scope);
  if (!assignment) return [];
  const result: SqlAlchemyModelFact['constraints'] = [];
  const stack: unknown[] = [assignment.properties.value];
  const seen = new Set<object>();
  while (stack.length) {
    const value = stack.pop();
    if (!isObject(value) || seen.has(value)) continue;
    seen.add(value);
    if (value.kind === 'call' && typeof value.name === 'string') {
      const canonical = canonicalSqlAlchemyName(value.name, file.imports);
      const args = Array.isArray(value.arguments) ? value.arguments as PythonExpressionFact['arguments'] : [];
      const positional = args?.filter((arg) => arg.kind === 'positional').map((arg) => arg.expression) ?? [];
      const keywords = new Map((args ?? []).filter((arg) => arg.kind === 'keyword' && arg.keyword).map((arg) => [arg.keyword!, arg.expression]));
      let kind: SqlAlchemyModelFact['constraints'][number]['kind'] | undefined;
      if (canonical.endsWith('.PrimaryKeyConstraint')) kind = 'primary_key';
      else if (canonical.endsWith('.UniqueConstraint')) kind = 'unique';
      else if (canonical.endsWith('.ForeignKeyConstraint')) kind = 'foreign_key';
      else if (canonical === 'sqlalchemy.Index' || canonical === 'sqlalchemy.schema.Index') kind = 'index';
      if (kind) {
        const indexOffset = kind === 'index' ? 1 : 0;
        const name = kind === 'index' ? staticString(positional[0]) : staticString(keywords.get('name'));
        const localColumns = literalStrings(positional[indexOffset]);
        const references = kind === 'foreign_key' ? literalStrings(positional[indexOffset + 1]) : [];
        result.push({ kind, ...(name ? { name } : {}), columns: localColumns, references, sourceEvidence: file.evidenceBySubject.get(assignment.id) });
        if (kind === 'primary_key') for (const column of columns) if (localColumns.includes(column.name)) { column.primaryKey = true; column.nullable = false; }
        if (kind === 'unique') for (const column of columns) if (localColumns.includes(column.name)) column.unique = true;
        if (kind === 'index') for (const column of columns) if (localColumns.includes(column.name)) column.index = true;
      }
    }
    if (Array.isArray(value.children)) stack.push(...value.children);
    if (Array.isArray(value.arguments)) stack.push(...value.arguments.map((arg: any) => arg?.expression));
  }
  return result;
}
function staticString(value: unknown): string | undefined { return literalString(value); }
function literalStrings(value: unknown): string[] { if (!isObject(value)) return []; if (value.literalKind === 'string' && typeof value.value === 'string') return [value.value]; if (Array.isArray(value.children)) return value.children.flatMap(literalStrings); return []; }
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
function sourceDiagnostic(code: string, message: string, source?: AnalysisEvidence): AnalysisDiagnostic { return { code, severity: 'warning', message, ...(source?.uri ? { uri: source.uri } : {}), ...(source?.line ? { line: source.line } : {}) }; }
function isObject(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function lexical(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
