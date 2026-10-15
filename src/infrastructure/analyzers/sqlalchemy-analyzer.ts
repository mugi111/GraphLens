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
      const hasTablename = literalString(localAssignmentValue(file.assignments, '__tablename__', String(klass.properties.qualifiedName))?.properties.value);
      if (!hasTablename && classBases(klass).some((base) => canonicalSqlAlchemyName(base, file.imports) === 'sqlalchemy.orm.DeclarativeBase')) rootClasses.add(key);
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
        const localBase = resolveLocalBaseKey(item.file, base);
        return canonical === 'sqlalchemy.orm.DeclarativeBase' || rootBases.has(localBase ?? `${item.module}.${canonical}`) || rootBases.has(canonical) || models.has(localBase ?? `${item.module}.${base}`) || classByLocal.has(localBase ?? `${item.module}.${base}`) && models.has(localBase ?? `${item.module}.${base}`);
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
        const baseKeys = bases.map((base) => resolveLocalBaseKey(item.file, base) ?? `${item.module}.${base}`);
        if (baseKeys.some((base) => models.has(base))) {
          const inherited = baseKeys.map((base) => models.get(base)).find(Boolean);
          if (inherited) { models.set(key, { ...inherited, classId: item.node.id, path: item.path, module: item.module, label: item.label, qualifiedName: item.qualifiedName, bases, sourceEvidence: item.file.evidenceBySubject.get(item.node.id), columns: [], constraints: [], relationships: [] }); changed = true; }
        }
        continue;
      }
      const schema = tableSchema(item.file.assignments, item.qualifiedName);
      models.set(key, { classId: item.node.id, path: item.path, module: item.module, qualifiedName: item.qualifiedName, label: item.label, tableName, schema, bases, sourceEvidence: item.file.evidenceBySubject.get(item.node.id), tableEvidence: item.file.evidenceBySubject.get(tableAssignment!.id), columns: [], constraints: [], relationships: [] });
      changed = true;
    }
  }
  const collected = [...models.values()].filter((model) => model.tableName).sort((a, b) => lexical(`${a.module}.${a.qualifiedName}`, `${b.module}.${b.qualifiedName}`));
  for (const model of collected) {
    const file = files.find((candidate) => candidate.path === model.path)!;
    const columnByName = new Map<string, SqlAlchemyModelFact['columns'][number]>();
    const collectedAssignments = inheritedAssignments(model, file, classByLocal);
    for (const assignment of collectedAssignments) {
      const assignmentFile = files.find((candidate) => candidate.assignments.some((node) => node.id === assignment.id)) ?? file;
      const column = columnFact(assignment, assignmentFile);
      if (column?.diagnostic) diagnostics.push(column.diagnostic);
      if (column) columnByName.set(column.name, column);
      const relation = relationshipFact(assignment, assignmentFile);
      if (relation) { model.relationships.push(relation.fact); if (relation.diagnostic) diagnostics.push(relation.diagnostic); }
    }
    model.columns = [...columnByName.values()];
    model.constraints = tableConstraints(file.assignments, model.qualifiedName, file, model.columns, diagnostics);
  }
  return collected;
}

function inheritedAssignments(model: SqlAlchemyModelFact, owningFile: SqlAlchemyCollectedFile, classByLocal: Map<string, { file: SqlAlchemyCollectedFile; node: GraphNode; path: string; module: string; qualifiedName: string; label: string }>) {
  const result: GraphNode[] = [];
  const visited = new Set<string>();
  function visit(file: SqlAlchemyCollectedFile, klass: GraphNode) {
    const key = `${String(klass.properties.module)}.${String(klass.properties.qualifiedName)}`;
    if (visited.has(key)) return;
    visited.add(key);
    for (const base of classBases(klass)) {
      const baseKey = resolveLocalBaseKey(file, base);
      const inherited = baseKey ? classByLocal.get(baseKey) : undefined;
      if (inherited) visit(inherited.file, inherited.node);
    }
    const scope = String(klass.properties.qualifiedName);
    result.push(...file.assignments.filter((assignment) => assignment.properties.scope === scope));
  }
  const own = classByLocal.get(`${model.module}.${model.qualifiedName}`);
  if (own) visit(own.file, own.node);
  else result.push(...owningFile.assignments.filter((assignment) => assignment.properties.scope === model.qualifiedName));
  return result;
}

function projectModels(context: AnalysisContext, databaseNamespace: string, sourceRevision: string, files: SqlAlchemyCollectedFile[], models: SqlAlchemyModelFact[], diagnostics: AnalysisDiagnostic[]): AnalysisResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const evidence: AnalysisEvidence[] = [];
  const nodesById = new Map<string, GraphNode>();
  const edgesById = new Set<string>();
  const projectedModels = new Map<string, GraphNode>();
  const projectedColumns = new Map<string, GraphNode>();
  const targetColumns = new Map<string, GraphNode[]>();
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
    projectedModels.set(`${model.module}.${model.qualifiedName}`, modelNode);
    addEdge(sourceClass, modelNode, 'maps_to', model.sourceEvidence, `model/${model.qualifiedName}`, 'DIRECT');
    const tableKey = `table/${model.schema ? `${model.schema}.` : ''}${model.tableName}`;
    const table = addNode(databaseNamespace, 'sqlalchemy_table', `${model.schema ? `${model.schema}.` : ''}${model.tableName}`, tableKey, { databaseNamespace, schema: model.schema ?? null, tableName: model.tableName }, model.tableEvidence ?? model.sourceEvidence, 'sqlalchemy.table');
    addEdge(modelNode, table, 'contains', model.tableEvidence ?? model.sourceEvidence, tableKey);
    for (const column of model.columns) {
      const key = `column/${model.schema ? `${model.schema}.` : ''}${model.tableName}.${column.name}`;
      const columnNode = addNode(databaseNamespace, 'sqlalchemy_column', column.name, key, { databaseNamespace, tableName: model.tableName, schema: model.schema ?? null, columnName: column.name, typeName: column.typeName ?? null, primaryKey: column.primaryKey ?? null, nullable: column.nullable ?? null, unique: column.unique ?? null, index: column.index ?? null }, column.sourceEvidence, 'sqlalchemy.column');
      addEdge(table, columnNode, 'contains', column.sourceEvidence, key);
      const columnKey = `${model.schema ?? ''}.${model.tableName}.${column.name}`;
      projectedColumns.set(`${model.module}.${model.qualifiedName}.${column.name}`, columnNode);
      const targetList = targetColumns.get(columnKey) ?? [];
      if (!targetList.some((item) => item.id === columnNode.id)) targetList.push(columnNode);
      targetColumns.set(columnKey, targetList);
    }
    for (const constraint of model.constraints) {
      const key = `constraint/${model.schema ? `${model.schema}.` : ''}${model.tableName}/${constraint.kind}/${constraint.name ?? constraint.columns.join(',')}`;
      const node = addNode(databaseNamespace, 'sqlalchemy_constraint', constraint.name ?? constraint.kind, key, { databaseNamespace, tableName: model.tableName, schema: model.schema ?? null, constraintKind: constraint.kind, columns: constraint.columns, references: constraint.references }, constraint.sourceEvidence, `sqlalchemy.${constraint.kind}`);
      addEdge(table, node, 'contains', constraint.sourceEvidence, key);
      for (const columnName of constraint.columns) {
        const column = projectedColumns.get(`${model.module}.${model.qualifiedName}.${columnName}`);
        if (column) addEdge(node, column, 'constrains', constraint.sourceEvidence, `${key}:${columnName}`, 'DIRECT');
      }
    }
  }
  const unresolvedForeignKeys = new Map<string, GraphNode>();
  for (const model of models) for (const column of model.columns) {
    const source = projectedColumns.get(`${model.module}.${model.qualifiedName}.${column.name}`);
    if (!source) continue;
    for (const reference of column.foreignKeys) {
      const target = resolveForeignKeyTarget(reference.target, model, targetColumns);
      let destination = target.node;
      if (!destination) {
        destination = unresolvedForeignKeys.get(reference.target);
        if (!destination) {
          destination = addNode(databaseNamespace, 'sqlalchemy_unresolved_foreign_key', reference.target, `unresolved-foreign-key/${reference.target}`, { databaseNamespace, target: reference.target, resolved: false, ambiguous: target.ambiguous }, reference.sourceEvidence, 'sqlalchemy.unresolved_foreign-key');
          unresolvedForeignKeys.set(reference.target, destination);
        }
        diagnostics.push(sourceDiagnostic(target.ambiguous ? 'SQLALCHEMY_AMBIGUOUS_FOREIGN_KEY' : 'SQLALCHEMY_UNRESOLVED_FOREIGN_KEY', `${target.ambiguous ? 'Ambiguous' : 'Unresolved'} foreign key target '${reference.target}'.`, reference.sourceEvidence));
      }
      addEdge(source, destination, 'foreign_key', reference.sourceEvidence, `${model.qualifiedName}.${column.name}->${reference.target}`, 'DIRECT');
    }
  }
  const unresolvedRelationships = new Map<string, GraphNode>();
  for (const model of models) {
    const source = projectedModels.get(`${model.module}.${model.qualifiedName}`);
    if (!source) continue;
    for (const relation of model.relationships) {
      const targetName = relation.target;
      const sourceFile = files.find((candidate) => candidate.path === model.path)!;
      const candidates = targetName ? resolveRelationshipCandidates(models, sourceFile, model, targetName) : [];
      const resolved = candidates.length === 1 ? projectedModels.get(`${candidates[0]!.module}.${candidates[0]!.qualifiedName}`) : undefined;
      const key = `relationship/${model.qualifiedName}.${relation.name}`;
      const relationship = addNode(model.path, 'sqlalchemy_relationship', relation.name, key, { target: targetName ?? null, backPopulates: relation.backPopulates ?? null, backref: relation.backref ?? null, uselist: relation.uselist ?? null, resolved: !!resolved, ambiguous: candidates.length > 1 }, relation.sourceEvidence, 'sqlalchemy.relationship');
      addEdge(source, relationship, 'contains', relation.sourceEvidence, key, 'DIRECT');
      let destination = resolved;
      if (!destination) {
        const unresolvedKey = targetName ?? `${model.module}.${model.qualifiedName}.${relation.name}`;
        destination = unresolvedRelationships.get(unresolvedKey);
        if (!destination) {
          destination = addNode(databaseNamespace, candidates.length > 1 ? 'sqlalchemy_ambiguous_relationship' : 'sqlalchemy_unresolved_relationship', targetName ?? relation.name, `unresolved-relationship/${unresolvedKey}`, { databaseNamespace, target: targetName ?? null, resolved: false, ambiguous: candidates.length > 1 }, relation.sourceEvidence, 'sqlalchemy.unresolved-relationship');
          unresolvedRelationships.set(unresolvedKey, destination);
        }
        diagnostics.push(sourceDiagnostic(candidates.length > 1 ? 'SQLALCHEMY_AMBIGUOUS_RELATIONSHIP' : 'SQLALCHEMY_UNRESOLVED_RELATIONSHIP', `${candidates.length > 1 ? 'Ambiguous' : 'Unresolved'} relationship target '${targetName ?? relation.name}'.`, relation.sourceEvidence));
      }
      addEdge(relationship, destination, 'relationship', relation.sourceEvidence, `${model.qualifiedName}.${relation.name}->${targetName ?? 'unresolved'}`, 'DIRECT');
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
  const mappedAnnotation = isMappedAnnotation(annotation, file.imports);
  const mappedType = mappedTypeName(annotation, file.imports);
  const valueName = expressionName(value);
  const callFacts = calls(assignment);
  const canonicalCallName = (name: string) => canonicalSqlAlchemyName(name, file.imports);
  if (callFacts.some((call) => canonicalCallName(call.callee) === 'sqlalchemy.orm.relationship')) return undefined;
  const columnCall = callFacts.find((call) => ['sqlalchemy.orm.mapped_column', 'sqlalchemy.Column', 'sqlalchemy.sql.schema.Column'].includes(canonicalCallName(call.callee)));
  const recognizedFactory = ['sqlalchemy.orm.mapped_column', 'sqlalchemy.Column', 'sqlalchemy.sql.schema.Column'].includes(canonicalCallName(valueName ?? ''));
  if (!mappedAnnotation && !columnCall && !recognizedFactory) return undefined;
  const args = value?.arguments ?? [];
  const kwargs = new Map(args.filter((arg) => arg.kind === 'keyword' && arg.keyword).map((arg) => [arg.keyword!, arg.expression]));
  const dynamicFlags = ['primary_key', 'nullable', 'unique', 'index'].filter((key) => kwargs.has(key) && booleanLiteral(kwargs.get(key)) === undefined);
  const explicitOrDefault = (key: string, fallback: boolean): boolean | null => kwargs.has(key) ? booleanLiteral(kwargs.get(key)) ?? null : fallback;
  const primaryKey = explicitOrDefault('primary_key', false);
  const nullable = kwargs.has('nullable') ? booleanLiteral(kwargs.get('nullable')) ?? null : primaryKey === true ? false : primaryKey === null ? null : mappedAnnotation ? mappedType ? !isNonOptionalMappedType(annotation) : null : true;
  const firstPositional = args.find((arg) => arg.kind === 'positional')?.expression;
  const typeName = mappedType ?? expressionName(firstPositional);
  const foreignKeys = [] as SqlAlchemyModelFact['columns'][number]['foreignKeys'];
  let dynamicForeignKey = false;
  for (const call of callFacts) {
    if (!['sqlalchemy.ForeignKey', 'sqlalchemy.schema.ForeignKey'].includes(canonicalCallName(call.callee))) continue;
    const target = staticString(call.arguments?.find((arg) => arg.kind === 'positional')?.expression);
    if (target) foreignKeys.push({ target, sourceEvidence: file.evidenceBySubject.get(assignment.id) }); else dynamicForeignKey = true;
  }
  const dynamicValue = !!mappedAnnotation && !!value && !columnCall && !recognizedFactory;
  const diagnostic = dynamicFlags.length ? sourceDiagnostic('SQLALCHEMY_DYNAMIC_COLUMN_OPTION', `Could not statically resolve ${dynamicFlags.join(', ')} for column '${name}'.`, file.evidenceBySubject.get(assignment.id)) : dynamicForeignKey ? sourceDiagnostic('SQLALCHEMY_DYNAMIC_FOREIGN_KEY', `Could not statically resolve foreign key target for '${name}'.`, file.evidenceBySubject.get(assignment.id)) : dynamicValue ? sourceDiagnostic('SQLALCHEMY_DYNAMIC_COLUMN', `Could not statically resolve the mapped value for column '${name}'.`, file.evidenceBySubject.get(assignment.id)) : undefined;
  return { name, targetId: assignment.id, assignmentId: assignment.id, typeName, primaryKey, nullable, unique: explicitOrDefault('unique', false), index: explicitOrDefault('index', false), foreignKeys, relationships: [], sourceEvidence: file.evidenceBySubject.get(assignment.id), ...(diagnostic ? { diagnostic } : {}) };
}

function relationshipFact(assignment: GraphNode, file: SqlAlchemyCollectedFile): { fact: SqlAlchemyModelFact['relationships'][number]; diagnostic?: AnalysisDiagnostic } | undefined {
  const call = calls(assignment).find((item) => canonicalSqlAlchemyName(item.callee, file.imports) === 'sqlalchemy.orm.relationship');
  if (!call) return undefined;
  const positional = call.arguments?.filter((arg) => arg.kind === 'positional').map((arg) => arg.expression) ?? [];
  const kwargs = new Map((call.arguments ?? []).filter((arg) => arg.kind === 'keyword' && arg.keyword).map((arg) => [arg.keyword!, arg.expression]));
  const explicitTarget = positional[0];
  const literalTarget = staticString(explicitTarget);
  const classTarget = expressionName(explicitTarget);
  const annotation = asExpression(assignment.properties.annotation);
  const inferredTarget = mappedTypeName(annotation, file.imports);
  const target = literalTarget ?? classTarget ?? inferredTarget;
  const targetKind = literalTarget ? 'literal' : classTarget ? 'class' : inferredTarget ? 'annotation' : 'unresolved';
  const backPopulates = staticString(kwargs.get('back_populates'));
  const backref = staticString(kwargs.get('backref'));
  const uselist = kwargs.has('uselist') ? booleanLiteral(kwargs.get('uselist')) ?? null : null;
  const fact: SqlAlchemyModelFact['relationships'][number] = { name: expressionName(assignment.properties.target) ?? assignment.label, target, targetKind, backPopulates, backref, uselist, sourceEvidence: file.evidenceBySubject.get(assignment.id) };
  const dynamic = !target || kwargs.has('uselist') && uselist === null || kwargs.has('back_populates') && !backPopulates || kwargs.has('backref') && !backref;
  return { fact, ...(dynamic ? { diagnostic: sourceDiagnostic('SQLALCHEMY_DYNAMIC_RELATIONSHIP', `Could not statically resolve relationship '${expressionName(assignment.properties.target) ?? assignment.label}'.`, file.evidenceBySubject.get(assignment.id)) } : {}) };
}
function mappedTypeName(annotation: PythonExpressionFact | undefined, imports: Map<string, string>): string | undefined {
  return isMappedAnnotation(annotation, imports) ? genericTypeName(annotation!.children?.[1]) ?? annotation!.property : undefined;
}
function isMappedAnnotation(annotation: PythonExpressionFact | undefined, imports: Map<string, string>) { if (!annotation || annotation.kind !== 'member' || !annotation.children?.[0]) return false; const base = expressionName(annotation.children[0]); return !!base && canonicalSqlAlchemyName(base, imports) === 'sqlalchemy.orm.Mapped'; }
function genericTypeName(expression: PythonExpressionFact | undefined): string | undefined {
  if (!expression) return undefined;
  if (expression.literalKind === 'string' && typeof expression.value === 'string') return expression.value;
  if (expression.kind === 'member' && expression.children?.[0]) {
    const base = expressionName(expression.children[0]);
    const nested = expression.children[1];
    if (['List', 'list', 'Sequence', 'Set', 'set', 'Optional', 'Union', 'Mapped'].includes(base ?? '') && nested) return genericTypeName(nested);
  }
  return expressionName(expression);
}
function isNonOptionalMappedType(annotation: PythonExpressionFact | undefined) {
  const inner = annotation?.children?.[1];
  if (!inner) return false;
  if (inner.kind === 'member' && ['Optional', 'Union'].includes(expressionName(inner.children?.[0]) ?? '')) return false;
  if (inner.kind.includes('Binary') && inner.children?.some((part) => part.kind === 'None' || part.literalKind === 'none')) return false;
  return true;
}
function asExpression(value: unknown): PythonExpressionFact | undefined { return typeof value === 'object' && value !== null ? value as PythonExpressionFact : undefined; }
function booleanLiteral(value: PythonExpressionFact | undefined): boolean | undefined { return value?.literalKind === 'boolean' && typeof value.value === 'boolean' ? value.value : undefined; }
function literalString(value: unknown): string | undefined { if (isObject(value) && value.literalKind === 'string' && typeof value.value === 'string') return value.value; return undefined; }
function tableConstraints(assignments: GraphNode[], scope: string, file: SqlAlchemyCollectedFile, columns: SqlAlchemyModelFact['columns'], diagnostics: AnalysisDiagnostic[]): SqlAlchemyModelFact['constraints'] {
  const assignment = localAssignmentValue(assignments, '__table_args__', scope);
  if (!assignment) return [];
  const result: SqlAlchemyModelFact['constraints'] = [];
  const tableArgs = assignment.properties.value;
  if (!isObject(tableArgs) || !['TupleExpression', 'ListExpression', 'DictionaryExpression'].includes(String(tableArgs.kind))) diagnostics.push(sourceDiagnostic('SQLALCHEMY_DYNAMIC_TABLE_ARGS', 'Could not statically resolve __table_args__.', file.evidenceBySubject.get(assignment.id)));
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
        const localColumns = kind === 'foreign_key' ? literalStrings(positional[indexOffset]) : positional.slice(indexOffset).flatMap(literalStrings);
        const references = kind === 'foreign_key' ? literalStrings(positional[indexOffset + 1]) : [];
        const sourceEvidence = file.evidenceBySubject.get(assignment.id);
        result.push({ kind, ...(name ? { name } : {}), columns: localColumns, references, sourceEvidence });
        if (localColumns.length === 0 || kind === 'foreign_key' && references.length !== localColumns.length) diagnostics.push(sourceDiagnostic('SQLALCHEMY_DYNAMIC_CONSTRAINT', `Could not statically resolve all ${kind} columns in __table_args__.`, sourceEvidence));
        if (kind === 'primary_key') for (const column of columns) if (localColumns.includes(column.name)) { column.primaryKey = true; column.nullable = false; }
        if (kind === 'unique' && localColumns.length === 1) for (const column of columns) if (localColumns.includes(column.name)) column.unique = true;
        if (kind === 'index' && localColumns.length === 1) for (const column of columns) if (localColumns.includes(column.name)) column.index = true;
        if (kind === 'foreign_key') for (let i = 0; i < Math.min(localColumns.length, references.length); i++) { const column = columns.find((candidate) => candidate.name === localColumns[i]); if (column) column.foreignKeys.push({ target: references[i]!, sourceEvidence }); }
      }
    }
    if (Array.isArray(value.children)) stack.push(...value.children);
    if (Array.isArray(value.arguments)) stack.push(...value.arguments.map((arg: any) => arg?.expression));
  }
  return result;
}
function staticString(value: unknown): string | undefined { return literalString(value); }
function literalStrings(value: unknown): string[] { if (!isObject(value)) return []; if (value.literalKind === 'string' && typeof value.value === 'string') return [value.value]; if (Array.isArray(value.children)) return value.children.flatMap(literalStrings); return []; }
function resolveForeignKeyTarget(reference: string, sourceModel: SqlAlchemyModelFact, targets: Map<string, GraphNode[]>) {
  const parts = reference.split('.').filter(Boolean);
  if (parts.length < 2) return { node: undefined, ambiguous: false };
  const key = parts.length === 2 ? `${sourceModel.schema ?? ''}.${parts[0]}.${parts[1]}` : `${parts.slice(0, -2).join('.')}.${parts.at(-2)}.${parts.at(-1)}`;
  const candidates = targets.get(key) ?? [];
  return { node: candidates.length === 1 ? candidates[0] : undefined, ambiguous: candidates.length > 1 };
}
function findModelCandidates(models: SqlAlchemyModelFact[], currentModule: string, targetName: string) {
  const normalized = targetName.replace(/^['"]|['"]$/g, '');
  const exact = models.filter((model) => `${model.module}.${model.qualifiedName}` === normalized || `${model.module}.${model.qualifiedName}` === `${currentModule}.${normalized}` || model.qualifiedName === normalized || model.label === normalized);
  return [...new Map(exact.map((model) => [`${model.module}.${model.qualifiedName}`, model])).values()];
}
function resolveRelationshipCandidates(models: SqlAlchemyModelFact[], file: SqlAlchemyCollectedFile, source: SqlAlchemyModelFact, targetName: string) {
  const importedKey = resolveLocalBaseKey(file, targetName);
  const exact = models.filter((model) => `${model.module}.${model.qualifiedName}` === importedKey || `${model.module}.${model.qualifiedName}` === `${source.module}.${targetName}`);
  return exact.length ? exact : findModelCandidates(models, source.module, targetName);
}
function tableSchema(assignments: GraphNode[], scope: string): string | undefined {
  const assignment = localAssignmentValue(assignments, '__table_args__', scope);
  const stack: unknown[] = [assignment?.properties.value];
  while (stack.length) { const value = stack.pop(); if (!isObject(value)) continue; if (value.kind === 'DictionaryExpression' && Array.isArray(value.children)) { for (let i = 0; i + 1 < value.children.length; i += 2) { const key = value.children[i]; const item = value.children[i + 1]; if (isObject(key) && key.value === 'schema' && isObject(item) && typeof item.value === 'string') return item.value; } } if (Array.isArray(value.children)) stack.push(...value.children); }
  return undefined;
}
function moduleForAssignment(node: GraphNode) { return String(node.properties.module); }
function resolveLocalBaseKey(file: SqlAlchemyCollectedFile, name: string): string | undefined {
  if (name.includes('.')) {
    const [head, ...tail] = name.split('.');
    for (const imported of file.pythonImports) {
      if (imported.relativeLevel) continue;
      if (imported.imported) {
        const local = imported.alias ?? imported.imported;
        if (head === local) return `${imported.module}.${imported.imported}.${tail.join('.')}`;
      } else {
        const local = imported.alias ?? imported.module.split('.')[0];
        if (head === local) {
          const suffix = imported.alias ? tail.join('.') : name.split('.').slice(imported.module.split('.').length).join('.');
          return `${imported.module}${suffix ? `.${suffix}` : ''}`;
        }
      }
    }
    return `${moduleForFile(file.path)}.${name}`;
  }
  for (const imported of file.pythonImports) {
    if (imported.imported && (imported.alias ?? imported.imported) === name) return `${absoluteImportedModule(file.path, imported)}.${imported.imported}`;
  }
  return `${moduleForFile(file.path)}.${name}`;
}
function absoluteImportedModule(path: string, imported: SqlAlchemyCollectedFile['pythonImports'][number]) {
  if (!imported.relativeLevel) return imported.module;
  const current = moduleForFile(path).split('.');
  const packageParts = path.endsWith('/__init__.py') || path.endsWith('/__init__.pyi') ? current : current.slice(0, -1);
  const base = packageParts.slice(0, Math.max(0, packageParts.length - imported.relativeLevel + 1));
  return [...base, imported.module].filter(Boolean).join('.');
}
function moduleForFile(path: string) { return path.replace(/\.pyi?$/, '').split('/').filter((part) => part !== '__init__').join('.') || '__init__'; }
function projectEvidence(subjectKind: 'node' | 'edge', subjectId: string, source: AnalysisEvidence | undefined, type: string, anchor: string, level: 'DIRECT' | 'DERIVED' = 'DIRECT'): AnalysisEvidence {
  const stable = `${type}:${anchor}`;
  return { id: identity.node(subjectId, `evidence:${subjectKind}`, stable), subjectKind, subjectId, level, type, ...(source?.uri ? { uri: source.uri } : {}), ...(source?.line ? { line: source.line } : {}), ...(source?.column ? { column: source.column } : {}), ...(source?.endLine ? { endLine: source.endLine } : {}), ...(source?.endColumn ? { endColumn: source.endColumn } : {}), ...(source?.startOffset !== undefined ? { startOffset: source.startOffset } : {}), ...(source?.endOffset !== undefined ? { endOffset: source.endOffset } : {}) };
}
function sourceDiagnostic(code: string, message: string, source?: AnalysisEvidence): AnalysisDiagnostic { return { code, severity: 'warning', message, ...(source?.uri ? { uri: source.uri } : {}), ...(source?.line ? { line: source.line } : {}) }; }
function isObject(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function lexical(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
