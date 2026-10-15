import { AnalysisError, type AnalysisContext, type AnalysisDiagnostic, type AnalysisEvidence, type Analyzer, type AnalysisResult } from '../../domain/analyzer.js';
import { GraphIdentityFactory } from '../../core/graph-identity.js';
import type { GraphEdge, GraphNode } from '../../domain/graph.js';
import { canonicalSqlAlchemyName, collectSqlAlchemyFiles, collectSqlAlchemySource, expressionName, importsAt, localAssignmentValue, sqlAlchemyConfig } from './sqlalchemy-source-collector.js';
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
      const collected = collectModels(files, diagnostics);
      return projectModels(context, config.databaseNamespace, snapshot.sourceRevision, files, collected.models, diagnostics, collected.ambiguousClasses);
    } catch (error) {
      if (error instanceof AnalysisError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new AnalysisError('ANALYZER_FAILED', message, [{ code: /databaseNamespace/i.test(message) ? 'SQLALCHEMY_INVALID_CONFIG' : 'SQLALCHEMY_ANALYSIS_FAILED', severity: 'error', message }]);
    }
  },
};

function collectModels(files: SqlAlchemyCollectedFile[], diagnostics: AnalysisDiagnostic[]) {
  const allClasses = files.flatMap((file) => file.classes.map((node) => ({ file, node, path: file.path, module: String(node.properties.module), qualifiedName: String(node.properties.qualifiedName), label: node.label })));
  const eligibleCache = new Map<string, boolean>();
  function isSqlAlchemyClass(item: typeof allClasses[number], visiting = new Set<string>()): boolean {
    const key = `${item.path}:${item.qualifiedName}`;
    if (eligibleCache.has(key)) return eligibleCache.get(key)!;
    if (visiting.has(key)) return false;
    visiting.add(key);
    const offset = item.file.evidenceBySubject.get(item.node.id)?.startOffset;
    const aliases = importsFor(item.file, item.qualifiedName, offset);
    if (classBases(item.node).some((base) => canonicalSqlAlchemyName(base, aliases) === 'sqlalchemy.orm.DeclarativeBase')) { eligibleCache.set(key, true); return true; }
    const declarations = item.file.assignments.filter((assignment) => assignment.properties.scope === item.qualifiedName);
    if (declarations.some((assignment) => !!columnFact(assignment, item.file))) { eligibleCache.set(key, true); return true; }
    const decorators = Array.isArray(item.node.properties.decorators) ? item.node.properties.decorators as Array<{name?: string}> : [];
    for (const decorator of decorators) {
      if (!decorator.name || !/\.(mapped|mapped_as_dataclass)$/.test(decorator.name)) continue;
      const owner = decorator.name.split('.')[0]!;
      const registry = item.file.assignments.find((assignment) => expressionName(assignment.properties.target) === owner && assignment.properties.scope === '');
      const value = asExpression(registry?.properties.value);
      if (value?.kind === 'call' && value.name && canonicalSqlAlchemyName(value.name, importsFor(item.file, '', item.file.evidenceBySubject.get(registry!.id)?.startOffset)) === 'sqlalchemy.orm.registry') { eligibleCache.set(key, true); return true; }
    }
    for (const base of classBases(item.node)) {
      const resolved = resolveLocalBaseKey(item.file, base, item.qualifiedName, offset);
      const baseName = resolved === undefined ? `${item.module}.${base}` : resolved;
      const parent = allClasses.find((candidate) => `${candidate.module}.${candidate.qualifiedName}` === baseName);
      if (parent && isSqlAlchemyClass(parent, visiting)) { eligibleCache.set(key, true); return true; }
    }
    eligibleCache.set(key, false);
    return false;
  }
  const logicalGroups = new Map<string, typeof allClasses>();
  for (const item of allClasses) { const key = `${item.module}.${item.qualifiedName}`; const group = logicalGroups.get(key) ?? []; group.push(item); logicalGroups.set(key, group); }
  const ambiguousClasses = [...logicalGroups.values()].filter((group) => group.length > 1 && group.some((item) => isSqlAlchemyClass(item)));
  const ambiguousKeys = new Set(ambiguousClasses.flatMap((group) => group.map((item) => `${item.module}.${item.qualifiedName}`)));
  for (const group of ambiguousClasses) diagnostics.push(sourceDiagnostic('SQLALCHEMY_AMBIGUOUS_CLASS', `Multiple Python source files declare '${group[0]!.module}.${group[0]!.qualifiedName}'; mapping was not merged.`, group[0]!.file.evidenceBySubject.get(group[0]!.node.id)));
  const uniqueClasses = allClasses.filter((item) => !ambiguousKeys.has(`${item.module}.${item.qualifiedName}`));
  const classByLocal = new Map(uniqueClasses.map((item) => [`${item.module}.${item.qualifiedName}`, item]));
  const rootVariables = new Set<string>();
  const rootClasses = new Set<string>();
  const abstractClasses = new Set<string>();
  for (const file of files) {
    for (const assignment of file.assignments) {
      const target = expressionName(assignment.properties.target);
      if (!target || assignment.properties.scope !== '') continue;
      const valueName = expressionName(assignment.properties.value);
      const directCall = asExpression(assignment.properties.value);
      const imports = importsFor(file, String(assignment.properties.scope ?? ''), file.evidenceBySubject.get(assignment.id)?.startOffset);
      const canonicalValue = directCall?.kind === 'call' && typeof directCall.name === 'string' ? canonicalSqlAlchemyName(directCall.name, imports) : undefined;
      if (canonicalValue === 'sqlalchemy.orm.declarative_base' || canonicalValue === 'sqlalchemy.ext.declarative.declarative_base') rootVariables.add(`${moduleForAssignment(assignment)}.${target}`);
      if (directCall && isRegistryGenerateBase(directCall, file, String(assignment.properties.scope ?? ''), file.evidenceBySubject.get(assignment.id)?.startOffset ?? 0)) rootVariables.add(`${moduleForAssignment(assignment)}.${target}`);
      if (canonicalValue === 'sqlalchemy.orm.declarative_base' || canonicalValue === 'sqlalchemy.ext.declarative.declarative_base') rootVariables.add(`${moduleForAssignment(assignment)}.${target}`);
    }
    for (const klass of file.classes) {
      const key = `${String(klass.properties.module)}.${String(klass.properties.qualifiedName)}`;
      const tableAssignment = localAssignmentValue(file.assignments, '__tablename__', String(klass.properties.qualifiedName));
      const decorators = Array.isArray(klass.properties.decorators) ? klass.properties.decorators as Array<{name?: string}> : [];
      const isMappedDecorator = decorators.some(({ name }) => {
        if (!name) return false;
        return isRegistryMappedDecorator(file, name, String(klass.properties.qualifiedName ?? ''), file.evidenceBySubject.get(klass.id)?.startOffset ?? 0);
      });
      if (!tableAssignment && !isMappedDecorator && classBases(klass).some((base) => canonicalSqlAlchemyName(base, importsFor(file, String(klass.properties.qualifiedName ?? ''), file.evidenceBySubject.get(klass.id)?.startOffset)) === 'sqlalchemy.orm.DeclarativeBase')) rootClasses.add(key);
    }
  }
  const models = new Map<string, SqlAlchemyModelFact>();
  const rootBases = new Set([...rootVariables, ...rootClasses]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of uniqueClasses) {
      const key = `${item.module}.${item.qualifiedName}`;
      if (rootClasses.has(key) || models.has(key)) continue;
      const bases = classBases(item.node);
      const tableAssignment = localAssignmentValue(item.file.assignments, '__tablename__', item.qualifiedName);
      const decorators = Array.isArray(item.node.properties.decorators) ? item.node.properties.decorators as Array<{name?: string}> : [];
      const mappedDecorator = decorators.some(({ name }) => !!name && isRegistryMappedDecorator(item.file, name, item.qualifiedName, item.file.evidenceBySubject.get(item.node.id)?.startOffset ?? 0));
      const isDerived = bases.some((base) => {
        const canonical = canonicalSqlAlchemyName(base, importsFor(item.file, item.qualifiedName, item.file.evidenceBySubject.get(item.node.id)?.startOffset));
        const localBase = resolveLocalBaseKey(item.file, base, item.qualifiedName, item.file.evidenceBySubject.get(item.node.id)?.startOffset);
        const baseKey = localBase === undefined ? `${item.module}.${base}` : localBase;
        const knownBase = localBase !== null && (rootBases.has(localBase === undefined ? `${item.module}.${canonical}` : localBase) || rootBases.has(canonical) || models.has(baseKey!) || abstractClasses.has(baseKey!));
        return canonical === 'sqlalchemy.orm.DeclarativeBase' || knownBase;
      });
      const abstract = localAssignmentValue(item.file.assignments, '__abstract__', item.qualifiedName);
      if (abstract && literalBoolean(abstract.properties.value) === true) {
        if ((isDerived || mappedDecorator) && !abstractClasses.has(key)) { abstractClasses.add(key); changed = true; }
        continue;
      }
      const isMapped = mappedDecorator || isDerived;
      const tableName = literalString(tableAssignment?.properties.value);
      if (!isMapped) {
        if (tableAssignment && (item.file.imports.size > 0 || item.file.pythonImports.some((imp) => !!imp.fact.imported))) diagnostics.push(sourceDiagnostic('SQLALCHEMY_DYNAMIC_BASE', `Could not statically resolve SQLAlchemy base for '${item.qualifiedName}'.`, item.file.evidenceBySubject.get(item.node.id)));
        continue;
      }
      if (tableAssignment && !tableName) {
        diagnostics.push(sourceDiagnostic('SQLALCHEMY_DYNAMIC_TABLE_NAME', `Could not statically resolve table name for '${item.qualifiedName}'.`, item.file.evidenceBySubject.get(tableAssignment.id)));
      }
      if (!tableName && !tableAssignment) {
        const baseKeys = bases.map((base) => { const resolved = resolveLocalBaseKey(item.file, base, item.qualifiedName, item.file.evidenceBySubject.get(item.node.id)?.startOffset); return resolved === undefined ? `${item.module}.${base}` : resolved; }).filter((base): base is string => base !== null);
        const inherited = [...new Map(baseKeys.map((base) => models.get(base)).filter((model): model is SqlAlchemyModelFact => !!model && !!model.tableName).map((model) => [`${model.schema ?? ''}.${model.tableName}`, model])).values()];
        if (inherited.length === 1) { models.set(key, { ...inherited[0]!, classId: item.node.id, path: item.path, module: item.module, label: item.label, qualifiedName: item.qualifiedName, bases, sourceEvidence: item.file.evidenceBySubject.get(item.node.id), columns: [], constraints: [], relationships: [] }); changed = true; }
        else {
          diagnostics.push(sourceDiagnostic('SQLALCHEMY_TABLE_UNRESOLVED', `Could not prove a single inherited table for '${item.qualifiedName}'.`, item.file.evidenceBySubject.get(item.node.id)));
          models.set(key, { classId: item.node.id, path: item.path, module: item.module, qualifiedName: item.qualifiedName, label: item.label, tableName: null, tableResolved: false, bases, sourceEvidence: item.file.evidenceBySubject.get(item.node.id), columns: [], constraints: [], relationships: [] });
          changed = true;
        }
        continue;
      }
      const schemaFact = tableSchema(item.file.assignments, item.qualifiedName);
      const resolvedTable = !!tableName && !schemaFact.dynamic;
      if (!resolvedTable) diagnostics.push(sourceDiagnostic(tableName ? 'SQLALCHEMY_SCHEMA_UNRESOLVED' : 'SQLALCHEMY_TABLE_UNRESOLVED', `Could not statically resolve table mapping for '${item.qualifiedName}'.`, item.file.evidenceBySubject.get(tableAssignment?.id ?? item.node.id)));
      models.set(key, { classId: item.node.id, path: item.path, module: item.module, qualifiedName: item.qualifiedName, label: item.label, tableName: tableName ?? null, tableResolved: resolvedTable, schema: schemaFact.schema, bases, sourceEvidence: item.file.evidenceBySubject.get(item.node.id), tableEvidence: item.file.evidenceBySubject.get(tableAssignment?.id ?? item.node.id), columns: [], constraints: [], relationships: [] });
      changed = true;
    }
  }
  const collected = [...models.values()].sort((a, b) => lexical(`${a.module}.${a.qualifiedName}`, `${b.module}.${b.qualifiedName}`));
  for (const model of collected) {
    const file = files.find((candidate) => candidate.path === model.path)!;
    const columnByName = new Map<string, SqlAlchemyModelFact['columns'][number]>();
    const relationshipByName = new Map<string, SqlAlchemyModelFact['relationships'][number]>();
    const collectedAssignments = inheritedAssignments(model, file, classByLocal);
    for (const assignment of collectedAssignments) {
      const assignmentFile = files.find((candidate) => candidate.assignments.some((node) => node.id === assignment.id)) ?? file;
      const column = columnFact(assignment, assignmentFile);
      if (column?.diagnostic) diagnostics.push(column.diagnostic);
      if (column) columnByName.set(column.pythonName, column);
      const relation = relationshipFact(assignment, assignmentFile);
      if (relation) { relationshipByName.set(relation.fact.name, relation.fact); if (relation.diagnostic) diagnostics.push(relation.diagnostic); }
    }
    model.columns = [...columnByName.values()];
    model.relationships = [...relationshipByName.values()];
    applyMapperPrimaryKey(file.assignments, model.qualifiedName, model.columns);
    if (model.tableName) model.constraints = tableConstraints(file.assignments, model.qualifiedName, file, model.columns, diagnostics);
  }
  for (const file of files) for (const fn of file.functions) {
    const decorators = Array.isArray(fn.properties.decorators) ? fn.properties.decorators as Array<{name?: string}> : [];
    const offset = file.evidenceBySubject.get(fn.id)?.startOffset;
    if (decorators.some(({ name }) => {
      if (!name) return false;
      const canonical = canonicalSqlAlchemyName(name, importsFor(file, String(fn.properties.qualifiedName ?? ''), offset));
      return canonical === 'sqlalchemy.orm.declared_attr' || canonical === 'sqlalchemy.ext.declarative.declared_attr' || canonical.startsWith('sqlalchemy.orm.declared_attr.') || canonical.startsWith('sqlalchemy.ext.declarative.declared_attr.');
    })) diagnostics.push(sourceDiagnostic('SQLALCHEMY_DECLARED_ATTR_DEFERRED', `declared_attr '${fn.label}' is not evaluated; dependent mapping facts may be unresolved.`, file.evidenceBySubject.get(fn.id)));
  }
  return { models: collected, ambiguousClasses };
}

function inheritedAssignments(model: SqlAlchemyModelFact, owningFile: SqlAlchemyCollectedFile, classByLocal: Map<string, { file: SqlAlchemyCollectedFile; node: GraphNode; path: string; module: string; qualifiedName: string; label: string }>) {
  const result: GraphNode[] = [];
  const visited = new Set<string>();
  function visit(file: SqlAlchemyCollectedFile, klass: GraphNode) {
    const key = `${String(klass.properties.module)}.${String(klass.properties.qualifiedName)}`;
    if (visited.has(key)) return;
    visited.add(key);
    for (const base of classBases(klass)) {
      const resolvedBaseKey = resolveLocalBaseKey(file, base, String(klass.properties.qualifiedName ?? ''), file.evidenceBySubject.get(klass.id)?.startOffset);
      const baseKey = resolvedBaseKey === undefined ? `${String(klass.properties.module)}.${base}` : resolvedBaseKey;
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

function projectModels(context: AnalysisContext, databaseNamespace: string, sourceRevision: string, files: SqlAlchemyCollectedFile[], models: SqlAlchemyModelFact[], diagnostics: AnalysisDiagnostic[], ambiguousClasses: Array<Array<{ file: SqlAlchemyCollectedFile; node: GraphNode; path: string; module: string; qualifiedName: string; label: string }>>): AnalysisResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const evidence: AnalysisEvidence[] = [];
  const nodesById = new Map<string, GraphNode>();
  const edgesById = new Set<string>();
  const projectedModels = new Map<string, GraphNode>();
  const projectedColumns = new Map<string, GraphNode>();
  const targetColumns = new Map<string, GraphNode[]>();
  const addNode = (path: string, kind: string, label: string, key: string, properties: Record<string, unknown>, source?: AnalysisEvidence, type = 'sqlalchemy.mapping', level: 'DIRECT' | 'DERIVED' = 'DIRECT') => {
    const id = identity.node(context.workspace.id, `sqlalchemy://${path}#${key}`, kind);
    const existing = nodesById.get(id);
    if (existing) return existing;
    const node = { id, workspaceId: context.workspace.id, kind, label, properties };
    nodesById.set(id, node);
    nodes.push(node);
    evidence.push(projectEvidence('node', id, source, type, key, level));
    return nodes.at(-1)!;
  };
  const addEdge = (from: GraphNode, to: GraphNode, kind: string, source?: AnalysisEvidence, key = kind, level: 'DIRECT' | 'DERIVED' = 'DERIVED', properties: Record<string, unknown> = {}) => {
    const id = identity.edge(context.workspace.id, from.id, to.id, kind);
    if (edgesById.has(id)) return;
    edgesById.add(id);
    edges.push({ id, workspaceId: context.workspace.id, sourceId: from.id, targetId: to.id, kind, properties });
    evidence.push(projectEvidence('edge', id, source, `sqlalchemy.${kind}`, key, level));
  };
  for (const group of ambiguousClasses) {
    const candidateIds: string[] = [];
    for (const item of group) {
      const sourceClass = item.node;
      candidateIds.push(sourceClass.id);
      if (!nodesById.has(sourceClass.id)) { nodesById.set(sourceClass.id, sourceClass); nodes.push(sourceClass); }
      const source = item.file.evidenceBySubject.get(sourceClass.id);
      if (source) evidence.push(projectEvidence('node', sourceClass.id, source, 'sqlalchemy.class-candidate', `candidate/${item.path}/${item.qualifiedName}`));
    }
    addNode(group[0]!.path, 'sqlalchemy_ambiguous_model', group[0]!.qualifiedName, `ambiguous-model/${group[0]!.module}.${group[0]!.qualifiedName}`, { module: group[0]!.module, qualifiedName: group[0]!.qualifiedName, candidateClassIds: candidateIds, resolved: false }, group[0]!.file.evidenceBySubject.get(group[0]!.node.id), 'sqlalchemy.unresolved-model');
  }
  for (const model of models) {
    const sourceClass = files.flatMap((file) => file.classes).find((node) => node.id === model.classId);
    if (!sourceClass) continue;
    if (!nodesById.has(sourceClass.id)) { nodesById.set(sourceClass.id, sourceClass); nodes.push(sourceClass); }
    if (model.sourceEvidence) evidence.push({ ...model.sourceEvidence, id: identity.node(sourceClass.id, 'evidence:node', 'sqlalchemy.source-class'), subjectId: sourceClass.id, type: 'sqlalchemy.source-class' });
    const modelNode = addNode(model.path, 'sqlalchemy_model', model.label, `model/${model.module}.${model.qualifiedName}`, { module: model.module, qualifiedName: model.qualifiedName, databaseNamespace, tableName: model.tableName, schema: model.schema ?? null, tableResolved: model.tableResolved ?? !!model.tableName }, model.sourceEvidence, 'sqlalchemy.mapping', 'DERIVED');
    projectedModels.set(`${model.module}.${model.qualifiedName}`, modelNode);
    addEdge(sourceClass, modelNode, 'maps_to', model.sourceEvidence, `model/${model.qualifiedName}`, 'DERIVED');
    if (!model.tableName || model.tableResolved === false) continue;
    const tableKey = `table/${model.schema ? `${model.schema}.` : ''}${model.tableName}`;
    const table = addNode(databaseNamespace, 'sqlalchemy_table', `${model.schema ? `${model.schema}.` : ''}${model.tableName}`, tableKey, { databaseNamespace, schema: model.schema ?? null, tableName: model.tableName }, model.tableEvidence ?? model.sourceEvidence, 'sqlalchemy.table');
    addEdge(modelNode, table, 'contains', model.tableEvidence ?? model.sourceEvidence, tableKey);
    for (const column of model.columns) {
      const key = `column/${model.schema ? `${model.schema}.` : ''}${model.tableName}.${column.name}`;
      const columnNode = addNode(databaseNamespace, 'sqlalchemy_column', column.name, key, { databaseNamespace, tableName: model.tableName, schema: model.schema ?? null, pythonName: column.pythonName, columnName: column.name, typeName: column.typeName ?? null, primaryKey: column.primaryKey ?? null, nullable: column.nullable ?? null, unique: column.unique ?? null, index: column.index ?? null }, column.sourceEvidence, 'sqlalchemy.column');
      addEdge(table, columnNode, 'contains', column.sourceEvidence, key);
      const columnKey = `${model.schema ?? ''}.${model.tableName}.${column.name}`;
      projectedColumns.set(`${model.module}.${model.qualifiedName}.${column.pythonName}`, columnNode);
      const targetList = targetColumns.get(columnKey) ?? [];
      if (!targetList.some((item) => item.id === columnNode.id)) targetList.push(columnNode);
      targetColumns.set(columnKey, targetList);
    }
    for (const constraint of model.constraints) {
      const key = `constraint/${model.schema ? `${model.schema}.` : ''}${model.tableName}/${constraint.kind}/${constraint.name ?? constraint.columns.join(',')}`;
      const node = addNode(databaseNamespace, 'sqlalchemy_constraint', constraint.name ?? constraint.kind, key, { databaseNamespace, tableName: model.tableName, schema: model.schema ?? null, constraintKind: constraint.kind, columns: constraint.columns, references: constraint.references, resolved: constraint.resolved }, constraint.sourceEvidence, `sqlalchemy.${constraint.kind}`);
      addEdge(table, node, 'contains', constraint.sourceEvidence, key);
      for (const columnName of constraint.columns) {
        const fact = model.columns.find((candidate) => candidate.pythonName === columnName || candidate.name === columnName);
        const column = fact ? projectedColumns.get(`${model.module}.${model.qualifiedName}.${fact.pythonName}`) : undefined;
        if (column) addEdge(node, column, 'constrains', constraint.sourceEvidence, `${key}:${columnName}`, 'DIRECT');
      }
    }
  }
  const unresolvedForeignKeys = new Map<string, GraphNode>();
  for (const model of models) for (const column of model.columns) {
    const source = projectedColumns.get(`${model.module}.${model.qualifiedName}.${column.pythonName}`);
    if (!source) continue;
    for (const reference of column.foreignKeys) {
      const target = resolveForeignKeyTarget(reference.target, model, targetColumns);
      const ambiguousTarget = target.ambiguous || isAmbiguousForeignKeyTarget(reference.target, ambiguousClasses);
      let destination = target.node;
      if (!destination) {
        destination = unresolvedForeignKeys.get(reference.target);
        if (!destination) {
          destination = addNode(databaseNamespace, ambiguousTarget ? 'sqlalchemy_ambiguous_foreign_key' : 'sqlalchemy_unresolved_foreign_key', reference.target, `unresolved-foreign-key/${reference.target}`, { databaseNamespace, target: reference.target, resolved: false, ambiguous: ambiguousTarget }, reference.sourceEvidence, 'sqlalchemy.unresolved_foreign-key');
          unresolvedForeignKeys.set(reference.target, destination);
        }
        diagnostics.push(sourceDiagnostic(ambiguousTarget ? 'SQLALCHEMY_AMBIGUOUS_FOREIGN_KEY' : 'SQLALCHEMY_UNRESOLVED_FOREIGN_KEY', `${ambiguousTarget ? 'Ambiguous' : 'Unresolved'} foreign key target '${reference.target}'.`, reference.sourceEvidence));
      }
      addEdge(source, destination, 'foreign_key', reference.sourceEvidence, `${model.qualifiedName}.${column.name}->${reference.target}`, 'DIRECT', { resolved: !!target.node, ambiguous: ambiguousTarget });
    }
  }
  const unresolvedRelationships = new Map<string, GraphNode>();
  for (const model of models) {
    const source = projectedModels.get(`${model.module}.${model.qualifiedName}`);
    if (!source) continue;
    for (const relation of model.relationships) {
      const targetName = relation.target;
      const sourceFile = files.find((candidate) => candidate.path === relation.sourcePath) ?? files.find((candidate) => candidate.path === model.path)!;
      const candidates = targetName ? resolveRelationshipCandidates(models, sourceFile, model, targetName, relation.sourceScope, relation.sourceEvidence?.startOffset) : [];
      const importedTarget = targetName ? resolveLocalBaseKey(sourceFile, targetName, relation.sourceScope, relation.sourceEvidence?.startOffset) : undefined;
      const ambiguousTarget = candidates.length > 1 || !!targetName && ambiguousClasses.some((group) => group.some((candidate) => `${candidate.module}.${candidate.qualifiedName}` === importedTarget || `${candidate.module}.${candidate.qualifiedName}` === `${model.module}.${targetName}` || candidate.qualifiedName === targetName));
      const resolved = candidates.length === 1 ? projectedModels.get(`${candidates[0]!.module}.${candidates[0]!.qualifiedName}`) : undefined;
      const key = `relationship/${model.schema ? `${model.schema}.` : ''}${model.tableName}.${relation.name}`;
      const relationship = addNode(model.path, 'sqlalchemy_relationship', relation.name, key, { target: targetName ?? null, backPopulates: relation.backPopulates ?? null, backref: relation.backref ?? null, uselist: relation.uselist ?? null, resolved: !!resolved, ambiguous: ambiguousTarget }, relation.sourceEvidence, 'sqlalchemy.relationship');
      addEdge(source, relationship, 'contains', relation.sourceEvidence, key, 'DIRECT');
      let destination = resolved;
      if (!destination) {
        const unresolvedKey = targetName ?? `${model.module}.${model.qualifiedName}.${relation.name}`;
        destination = unresolvedRelationships.get(unresolvedKey);
        if (!destination) {
          destination = addNode(databaseNamespace, ambiguousTarget ? 'sqlalchemy_ambiguous_relationship' : 'sqlalchemy_unresolved_relationship', targetName ?? relation.name, `unresolved-relationship/${unresolvedKey}`, { databaseNamespace, target: targetName ?? null, resolved: false, ambiguous: ambiguousTarget }, relation.sourceEvidence, 'sqlalchemy.unresolved-relationship');
          unresolvedRelationships.set(unresolvedKey, destination);
        }
        diagnostics.push(sourceDiagnostic(ambiguousTarget ? 'SQLALCHEMY_AMBIGUOUS_RELATIONSHIP' : 'SQLALCHEMY_UNRESOLVED_RELATIONSHIP', `${ambiguousTarget ? 'Ambiguous' : 'Unresolved'} relationship target '${targetName ?? relation.name}'.`, relation.sourceEvidence));
      }
      addEdge(relationship, destination, 'relationship', relation.sourceEvidence, `${model.qualifiedName}.${relation.name}->${targetName ?? 'unresolved'}`, 'DERIVED', { resolved: !!resolved, ambiguous: ambiguousTarget });
    }
  }
  if (nodes.length + edges.length > 9000) throw new Error('SQLAlchemy contributions exceed the combined limit (9000).');
  if (evidence.length > 10_000) throw new Error('SQLAlchemy evidence exceeds the result limit (10000).');
  if (diagnostics.length > 10_000) throw new Error('SQLAlchemy diagnostics exceed the result limit (10000).');
  const uniqueDiagnostics = [...new Map(diagnostics.map((item) => [`${item.code ?? ''}\u0000${item.uri ?? ''}\u0000${item.line ?? ''}\u0000${item.message}`, item])).values()];
  return { sourceRevision, nodes, edges, evidence, diagnostics: uniqueDiagnostics };
}

function classBases(node: GraphNode): string[] { return Array.isArray(node.properties.bases) ? node.properties.bases.map(expressionName).filter((name): name is string => !!name) : []; }
function importsFor(file: SqlAlchemyCollectedFile, scope: string, offset = Number.MAX_SAFE_INTEGER) { return importsAt(file.lexicalImports, scope, offset); }
function isRegistryGenerateBase(expression: PythonExpressionFact, file: SqlAlchemyCollectedFile, scope: string, offset: number) {
  if (expression.kind !== 'call' || !expression.name?.endsWith('.generate_base')) return false;
  const callee = expression.callee;
  if (callee?.kind !== 'member' || callee.property !== 'generate_base') return false;
  const owner = callee.children?.[0];
  if (owner?.kind === 'call') return canonicalSqlAlchemyName(owner.name ?? '', importsFor(file, scope, offset)) === 'sqlalchemy.orm.registry';
  const ownerName = expressionName(owner);
  return !!ownerName && isRegistryInstance(file, ownerName, scope, offset);
}
function isRegistryInstance(file: SqlAlchemyCollectedFile, name: string, scope: string, offset: number, seen = new Set<string>()): boolean {
  const head = name.split('.')[0]!;
  const scopes = scope ? scope.split('.').map((_, index, parts) => parts.slice(0, index + 1).join('.')).reverse() : [];
  scopes.push('');
  for (const current of scopes) {
    const event = file.lexicalImports.filter((binding) => binding.scope === current && binding.local === head && binding.offset <= offset).sort((a, b) => b.offset - a.offset)[0];
    if (!event) continue;
    const imported = file.pythonImports.find((binding) => binding.scope === current && binding.fact.startOffset === event.offset);
    if (imported) return false;
    const assignment = file.assignments.find((node) => node.properties.scope === current && expressionName(node.properties.target) === head && file.evidenceBySubject.get(node.id)?.endOffset === event.offset);
    if (!assignment || seen.has(`${current}.${head}:${event.offset}`)) return false;
    seen.add(`${current}.${head}:${event.offset}`);
    const value = asExpression(assignment.properties.value);
    if (value?.kind === 'call' && value.name) return canonicalSqlAlchemyName(value.name, importsFor(file, current, file.evidenceBySubject.get(assignment.id)?.startOffset)) === 'sqlalchemy.orm.registry';
    const alias = expressionName(value);
    return !!alias && isRegistryInstance(file, alias, current, event.offset - 1, seen);
  }
  return false;
}
function isRegistryMappedDecorator(file: SqlAlchemyCollectedFile, name: string, scope: string, offset: number) {
  const parts = name.split('.');
  return parts.length === 2 && ['mapped', 'mapped_as_dataclass'].includes(parts[1]!) && isRegistryInstance(file, parts[0]!, scope, offset);
}
function columnFact(assignment: GraphNode, file: SqlAlchemyCollectedFile) {
  const name = expressionName(assignment.properties.target);
  if (!name || name.startsWith('__')) return undefined;
  const annotation = asExpression(assignment.properties.annotation);
  const value = asExpression(assignment.properties.value);
  const imports = importsFor(file, String(assignment.properties.scope ?? ''), file.evidenceBySubject.get(assignment.id)?.startOffset);
  const mappedAnnotation = isMappedAnnotation(annotation, imports);
  const mappedType = mappedTypeName(annotation, imports);
  const valueName = expressionName(value);
  const canonicalCallName = (name: string) => canonicalSqlAlchemyName(name, imports);
  const directCall = value?.kind === 'call' ? value : undefined;
  const directCanonical = directCall?.name ? canonicalCallName(directCall.name) : '';
  if (directCanonical === 'sqlalchemy.orm.relationship') return undefined;
  const recognizedColumnNames = ['sqlalchemy.orm.mapped_column', 'sqlalchemy.Column', 'sqlalchemy.sql.schema.Column'];
  const recognizedFactory = recognizedColumnNames.includes(directCanonical);
  if (!mappedAnnotation && !recognizedFactory) return undefined;
  const args = directCall?.arguments ?? [];
  const kwargs = new Map(args.filter((arg) => arg.kind === 'keyword' && arg.keyword).map((arg) => [arg.keyword!, arg.expression]));
  const unsupportedInitializer = !!mappedAnnotation && !!value && !recognizedFactory;
  const dynamicFlags = ['primary_key', 'nullable', 'unique', 'index'].filter((key) => kwargs.has(key) && booleanLiteral(kwargs.get(key)) === undefined);
  const explicitOrDefault = (key: string, fallback: boolean): boolean | null => kwargs.has(key) ? booleanLiteral(kwargs.get(key)) ?? null : fallback;
  const primaryKey = unsupportedInitializer ? null : explicitOrDefault('primary_key', false);
  const nullable = unsupportedInitializer ? null : kwargs.has('nullable') ? booleanLiteral(kwargs.get('nullable')) ?? null : primaryKey === true ? false : primaryKey === null ? null : mappedAnnotation ? mappedType ? !isNonOptionalMappedType(annotation) : null : true;
  const positional = args.filter((arg) => arg.kind === 'positional').map((arg) => arg.expression);
  const namedColumn = staticString(kwargs.get('name'));
  const explicitName = namedColumn ?? (recognizedFactory && staticString(positional[0]) ? staticString(positional[0]) : undefined);
  const positionalType = (recognizedFactory && staticString(positional[0]) ? positional.slice(1) : positional).find((candidate) => {
    if (!candidate || staticString(candidate)) return false;
    return !(candidate.kind === 'call' && ['sqlalchemy.ForeignKey', 'sqlalchemy.schema.ForeignKey'].includes(canonicalCallName(candidate.name ?? '')));
  });
  const typeExpression = kwargs.get('type_') ?? kwargs.get('type') ?? positionalType;
  const typeName = unsupportedInitializer ? undefined : expressionName(typeExpression) ?? mappedType;
  const foreignKeys = [] as SqlAlchemyModelFact['columns'][number]['foreignKeys'];
  let dynamicForeignKey = false;
  const nestedCalls = (recognizedFactory ? args.map((arg) => arg.expression) : []).flatMap((argument) => argument?.kind === 'call' ? [argument] : []);
  for (const call of nestedCalls) {
    if (!['sqlalchemy.ForeignKey', 'sqlalchemy.schema.ForeignKey'].includes(canonicalCallName(call.name ?? ''))) continue;
    const target = staticString(call.arguments?.find((arg) => arg.kind === 'positional')?.expression);
    if (target) foreignKeys.push({ target, sourceEvidence: file.evidenceBySubject.get(assignment.id) }); else dynamicForeignKey = true;
  }
  const dynamicValue = unsupportedInitializer;
  const diagnostic = dynamicFlags.length ? sourceDiagnostic('SQLALCHEMY_DYNAMIC_COLUMN_OPTION', `Could not statically resolve ${dynamicFlags.join(', ')} for column '${name}'.`, file.evidenceBySubject.get(assignment.id)) : dynamicForeignKey ? sourceDiagnostic('SQLALCHEMY_DYNAMIC_FOREIGN_KEY', `Could not statically resolve foreign key target for '${name}'.`, file.evidenceBySubject.get(assignment.id)) : dynamicValue ? sourceDiagnostic('SQLALCHEMY_DYNAMIC_COLUMN', `Could not statically resolve the mapped value for column '${name}'.`, file.evidenceBySubject.get(assignment.id)) : undefined;
  return { pythonName: name, name: explicitName ?? name, targetId: assignment.id, assignmentId: assignment.id, typeName, primaryKey, nullable, nullableExplicit: kwargs.has('nullable'), unique: unsupportedInitializer ? null : explicitOrDefault('unique', false), index: unsupportedInitializer ? null : explicitOrDefault('index', false), foreignKeys, relationships: [], sourceEvidence: file.evidenceBySubject.get(assignment.id), ...(diagnostic ? { diagnostic } : {}) };
}

function relationshipFact(assignment: GraphNode, file: SqlAlchemyCollectedFile): { fact: SqlAlchemyModelFact['relationships'][number]; diagnostic?: AnalysisDiagnostic } | undefined {
  const direct = asExpression(assignment.properties.value);
  const imports = importsFor(file, String(assignment.properties.scope ?? ''), file.evidenceBySubject.get(assignment.id)?.startOffset);
  const call = direct?.kind === 'call' && direct.name && canonicalSqlAlchemyName(direct.name, imports) === 'sqlalchemy.orm.relationship' ? { callee: direct.name, arguments: direct.arguments } : undefined;
  if (!call) return undefined;
  const positional = call.arguments?.filter((arg) => arg.kind === 'positional').map((arg) => arg.expression) ?? [];
  const kwargs = new Map((call.arguments ?? []).filter((arg) => arg.kind === 'keyword' && arg.keyword).map((arg) => [arg.keyword!, arg.expression]));
  const explicitTarget = positional[0];
  const literalTarget = staticString(explicitTarget);
  const classTarget = expressionName(explicitTarget);
  const annotation = asExpression(assignment.properties.annotation);
  const inferredTarget = mappedTypeName(annotation, imports);
  const target = literalTarget ?? classTarget ?? inferredTarget;
  const targetKind = literalTarget ? 'literal' : classTarget ? 'class' : inferredTarget ? 'annotation' : 'unresolved';
  const backPopulates = staticString(kwargs.get('back_populates'));
  const backref = staticString(kwargs.get('backref'));
  const uselist = kwargs.has('uselist') ? booleanLiteral(kwargs.get('uselist')) ?? null : null;
  const fact: SqlAlchemyModelFact['relationships'][number] = { name: expressionName(assignment.properties.target) ?? assignment.label, target, targetKind, sourcePath: file.path, sourceScope: String(assignment.properties.scope ?? ''), backPopulates, backref, uselist, sourceEvidence: file.evidenceBySubject.get(assignment.id) };
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
  const sourceEvidence = file.evidenceBySubject.get(assignment.id);
  const tableArgs = asExpression(assignment.properties.value);
  const entries = tableArgs?.kind === 'TupleExpression' || tableArgs?.kind === 'ListExpression'
    ? tableArgs.children ?? []
    : tableArgs?.kind === 'call' ? [tableArgs] : tableArgs?.kind === 'DictionaryExpression' ? [] : undefined;
  if (!entries) {
    diagnostics.push(sourceDiagnostic('SQLALCHEMY_DYNAMIC_TABLE_ARGS', 'Could not statically resolve __table_args__.', sourceEvidence));
    return result;
  }
  const imports = importsFor(file, scope, sourceEvidence?.startOffset);
  for (const entry of entries) {
    if (entry.kind === 'DictionaryExpression') continue;
    if (entry.kind !== 'call' || !entry.name) {
      diagnostics.push(sourceDiagnostic('SQLALCHEMY_DYNAMIC_CONSTRAINT', 'A __table_args__ entry is not a statically supported constraint call.', sourceEvidence));
      continue;
    }
    const canonical = canonicalSqlAlchemyName(entry.name, imports);
    const args = entry.arguments ?? [];
    const positional = args.filter((arg) => arg.kind === 'positional').map((arg) => arg.expression);
    const keywords = new Map(args.filter((arg) => arg.kind === 'keyword' && arg.keyword).map((arg) => [arg.keyword!, arg.expression]));
    let kind: SqlAlchemyModelFact['constraints'][number]['kind'] | undefined;
    if (['sqlalchemy.PrimaryKeyConstraint', 'sqlalchemy.schema.PrimaryKeyConstraint'].includes(canonical)) kind = 'primary_key';
    else if (['sqlalchemy.UniqueConstraint', 'sqlalchemy.schema.UniqueConstraint'].includes(canonical)) kind = 'unique';
    else if (['sqlalchemy.ForeignKeyConstraint', 'sqlalchemy.schema.ForeignKeyConstraint'].includes(canonical)) kind = 'foreign_key';
    else if (canonical === 'sqlalchemy.Index' || canonical === 'sqlalchemy.schema.Index') kind = 'index';
    if (!kind) {
      diagnostics.push(sourceDiagnostic('SQLALCHEMY_DYNAMIC_CONSTRAINT', 'An unsupported call in __table_args__ was left unresolved.', sourceEvidence));
      continue;
    }
    const indexOffset = kind === 'index' ? 1 : 0;
    const name = kind === 'index' ? staticString(positional[0]) : staticString(keywords.get('name'));
    const columnsExpression = kind === 'foreign_key' ? positional[indexOffset] : undefined;
    const referencesExpression = kind === 'foreign_key' ? positional[indexOffset + 1] : undefined;
    const localColumns = kind === 'foreign_key' ? literalStringList(columnsExpression) ?? [] : positional.slice(indexOffset).flatMap((item) => literalStringList(item) ?? []);
    const references = kind === 'foreign_key' ? literalStringList(referencesExpression) ?? [] : [];
    const allColumnArgsLiteral = kind === 'foreign_key'
      ? !!literalStringList(columnsExpression) && !!literalStringList(referencesExpression) && localColumns.length === references.length
      : positional.length > indexOffset && positional.slice(indexOffset).every((item) => !!literalStringList(item));
    const resolved = allColumnArgsLiteral && localColumns.length > 0;
    result.push({ kind, ...(name ? { name } : {}), columns: resolved ? localColumns : [], references: resolved ? references : [], resolved, sourceEvidence });
    if (!resolved) diagnostics.push(sourceDiagnostic('SQLALCHEMY_DYNAMIC_CONSTRAINT', `Could not statically resolve all ${kind} columns in __table_args__.`, sourceEvidence));
    if (!resolved) continue;
    if (kind === 'primary_key') for (const column of columns) if (localColumns.includes(column.name)) { column.primaryKey = true; if (!column.nullableExplicit) column.nullable = false; }
    if (kind === 'unique' && localColumns.length === 1) for (const column of columns) if (localColumns.includes(column.name)) column.unique = true;
    if (kind === 'index' && localColumns.length === 1) for (const column of columns) if (localColumns.includes(column.name)) column.index = true;
    if (kind === 'foreign_key') for (let i = 0; i < localColumns.length; i++) { const column = columns.find((candidate) => candidate.name === localColumns[i]); if (column) column.foreignKeys.push({ target: references[i]!, sourceEvidence }); }
  }
  return result;
}
function literalStringList(value: PythonExpressionFact | undefined): string[] | undefined {
  if (!value) return undefined;
  if (value.literalKind === 'string' && typeof value.value === 'string') return [value.value];
  if (value.kind !== 'TupleExpression' && value.kind !== 'ListExpression' && value.kind !== 'ArrayExpression') return undefined;
  const children = value.children ?? [];
  if (!children.length || children.some((item) => item.literalKind !== 'string' || typeof item.value !== 'string')) return undefined;
  return children.map((item) => item.value as string);
}
function applyMapperPrimaryKey(assignments: GraphNode[], scope: string, columns: SqlAlchemyModelFact['columns']) {
  const assignment = localAssignmentValue(assignments, '__mapper_args__', scope);
  const mapperArgs = asExpression(assignment?.properties.value);
  if (mapperArgs?.kind !== 'DictionaryExpression' || !mapperArgs.children) return;
  const key = mapperArgs.children.findIndex((child) => child.literalKind === 'string' && child.value === 'primary_key');
  if (key < 0) return;
  const value = mapperArgs.children[key + 1];
  const names = new Set<string>();
  const visit = (expression: PythonExpressionFact) => {
    if (expression.literalKind === 'string' && typeof expression.value === 'string') names.add(expression.value);
    const name = expressionName(expression);
    if (name) names.add(name.split('.').at(-1)!);
    for (const child of expression.children ?? []) visit(child);
  };
  if (value) visit(value);
  for (const column of columns) if (names.has(column.pythonName) || names.has(column.name)) { column.primaryKey = true; if (!column.nullableExplicit) column.nullable = false; }
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
function isAmbiguousForeignKeyTarget(reference: string, groups: Array<Array<{ file: SqlAlchemyCollectedFile; qualifiedName: string }>>) {
  const parts = reference.split('.').filter(Boolean);
  const table = parts.length >= 2 ? parts.at(-2) : undefined;
  if (!table) return false;
  return groups.some((group) => group.filter((candidate) => literalString(localAssignmentValue(candidate.file.assignments, '__tablename__', candidate.qualifiedName)?.properties.value) === table).length > 1);
}
function findModelCandidates(models: SqlAlchemyModelFact[], currentModule: string, targetName: string) {
  const normalized = targetName.replace(/^['"]|['"]$/g, '');
  const exact = models.filter((model) => `${model.module}.${model.qualifiedName}` === normalized || `${model.module}.${model.qualifiedName}` === `${currentModule}.${normalized}` || model.qualifiedName === normalized || model.label === normalized);
  return [...new Map(exact.map((model) => [`${model.module}.${model.qualifiedName}`, model])).values()];
}
function resolveRelationshipCandidates(models: SqlAlchemyModelFact[], file: SqlAlchemyCollectedFile, source: SqlAlchemyModelFact, targetName: string, scope: string, offset = Number.MAX_SAFE_INTEGER) {
  const importedKey = resolveLocalBaseKey(file, targetName, scope, offset);
  if (importedKey === null) return [];
  const exact = models.filter((model) => `${model.module}.${model.qualifiedName}` === importedKey || `${model.module}.${model.qualifiedName}` === `${source.module}.${targetName}`);
  return exact.length ? exact : findModelCandidates(models, source.module, targetName);
}
function tableSchema(assignments: GraphNode[], scope: string): { schema?: string; dynamic: boolean } {
  const assignment = localAssignmentValue(assignments, '__table_args__', scope);
  let found = false;
  const stack: unknown[] = [assignment?.properties.value];
  while (stack.length) { const value = stack.pop(); if (!isObject(value)) continue; if (value.kind === 'DictionaryExpression' && Array.isArray(value.children)) { for (let i = 0; i + 1 < value.children.length; i += 2) { const key = value.children[i]; const item = value.children[i + 1]; if (isObject(key) && key.value === 'schema') { found = true; if (isObject(item) && item.literalKind === 'string' && typeof item.value === 'string') return { schema: item.value, dynamic: false }; return { dynamic: true }; } } } if (Array.isArray(value.children)) stack.push(...value.children); }
  return { dynamic: found };
}
function literalBoolean(value: unknown): boolean | undefined { return isObject(value) && value.literalKind === 'boolean' && typeof value.value === 'boolean' ? value.value : undefined; }
function moduleForAssignment(node: GraphNode) { return String(node.properties.module); }
function resolveLocalBaseKey(file: SqlAlchemyCollectedFile, name: string, scope = '', offset = Number.MAX_SAFE_INTEGER): string | null | undefined {
  const scopes = scope ? scope.split('.').map((_, index, parts) => parts.slice(0, index + 1).join('.')).reverse() : [];
  scopes.push('');
  const head = name.split('.')[0]!;
  for (const current of scopes) {
    const event = file.lexicalImports.filter((binding) => binding.scope === current && binding.local === head && binding.offset <= offset).sort((a, b) => b.offset - a.offset)[0];
    if (!event) continue;
    const imported = file.pythonImports.find((binding) => binding.scope === current && binding.fact.startOffset === event.offset);
    if (!imported) {
      const declaration = file.classes.find((node) => {
        const qualifiedName = String(node.properties.qualifiedName ?? '');
        const parts = qualifiedName.split('.');
        return parts.pop() === head && parts.join('.') === current && file.evidenceBySubject.get(node.id)?.endOffset === event.offset;
      });
      if (declaration) return `${String(declaration.properties.module)}.${String(declaration.properties.qualifiedName)}${name.includes('.') ? `.${name.split('.').slice(1).join('.')}` : ''}`;
      const assignment = file.assignments.find((node) => node.properties.scope === current && expressionName(node.properties.target) === head && file.evidenceBySubject.get(node.id)?.endOffset === event.offset);
      if (!assignment) return null;
      const value = asExpression(assignment.properties.value);
      const assignmentImports = importsFor(file, current, file.evidenceBySubject.get(assignment.id)?.startOffset);
      const canonical = value?.kind === 'call' && typeof value.name === 'string' ? canonicalSqlAlchemyName(value.name, assignmentImports) : '';
      const verifiedFactory = canonical === 'sqlalchemy.orm.declarative_base' || canonical === 'sqlalchemy.ext.declarative.declarative_base' || canonical === 'sqlalchemy.orm.registry' || (!!value && isRegistryGenerateBase(value, file, current, file.evidenceBySubject.get(assignment.id)?.startOffset ?? 0));
      if (verifiedFactory) return `${String(assignment.properties.module)}.${head}${name.includes('.') ? `.${name.split('.').slice(1).join('.')}` : ''}`;
      const alias = expressionName(assignment.properties.value);
      return alias && alias !== name ? resolveLocalBaseKey(file, alias, current, event.offset - 1) : null;
    }
    const fact = imported.fact;
    if (fact.imported) {
      if (head !== (fact.alias ?? fact.imported)) return null;
      return `${absoluteImportedModule(file.path, fact)}.${fact.imported}${name.includes('.') ? `.${name.split('.').slice(1).join('.')}` : ''}`;
    }
    const local = fact.alias ?? fact.module.split('.')[0]!;
    if (head !== local) return null;
    const suffix = fact.alias ? name.split('.').slice(1).join('.') : name.split('.').slice(fact.module.split('.').length).join('.');
    return `${absoluteImportedModule(file.path, fact)}${suffix ? `.${suffix}` : ''}`;
  }
  return undefined;
}
function absoluteImportedModule(path: string, binding: SqlAlchemyCollectedFile['pythonImports'][number]['fact']) {
  const imported = binding;
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
