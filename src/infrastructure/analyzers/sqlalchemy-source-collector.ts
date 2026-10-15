import type { AnalysisContext, AnalysisEvidence } from '../../domain/analyzer.js';
import type { GraphNode } from '../../domain/graph.js';
import { collectPythonSourceSnapshot, type PythonSourceSnapshot } from './python-source-snapshot.js';
import type { SqlAlchemyCollectedFile, SqlAlchemyConfig } from './sqlalchemy-source-types.js';

export function sqlAlchemyConfig(config: Record<string, unknown>): SqlAlchemyConfig {
  const namespace = config.databaseNamespace ?? 'default';
  if (typeof namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(namespace)) throw new Error('databaseNamespace must be a stable identifier of 1 to 128 characters.');
  return { databaseNamespace: namespace };
}

export async function collectSqlAlchemySource(context: AnalysisContext): Promise<PythonSourceSnapshot> {
  const { databaseNamespace: _databaseNamespace, ...scanConfig } = context.config;
  // The namespace scopes graph identities; source revisions continue to represent the Python scan inputs.
  return collectPythonSourceSnapshot({ ...context, config: scanConfig });
}

export function collectSqlAlchemyFiles(snapshot: PythonSourceSnapshot): SqlAlchemyCollectedFile[] {
  return snapshot.parsedFiles.map(({ file, parsed }) => {
    const classes = parsed.nodes.filter((node) => node.kind === 'python_class');
    const assignments = parsed.nodes.filter((node) => node.kind === 'python_assignment');
    const evidenceBySubject = new Map<string, AnalysisEvidence>();
    for (const evidence of parsed.evidence) if (evidence.subjectKind === 'node') evidenceBySubject.set(evidence.subjectId, evidence);
    const owners = new Map(parsed.nodes.map((node) => [node.id, node]));
    const lexicalImports: SqlAlchemyCollectedFile['lexicalImports'] = [];
    for (const imported of parsed.imports) {
      if (imported.relativeLevel) continue;
      const owner = owners.get(imported.ownerId);
      const scope = owner?.kind === 'python_class' || owner?.kind === 'python_function' || owner?.kind === 'python_async_function' ? String(owner.properties.qualifiedName ?? '') : '';
      const local = imported.imported ? imported.alias ?? imported.imported : imported.alias ?? imported.module.split('.')[0]!;
      const canonical = imported.imported ? `${imported.module}.${imported.imported}` : imported.module;
      lexicalImports.push({ scope, offset: imported.startOffset, local, canonical: canonical === 'sqlalchemy' || canonical.startsWith('sqlalchemy.') ? canonical : undefined });
    }
    for (const assignment of assignments) {
      const target = expressionName(assignment.properties.target);
      if (!target || target.includes('.')) continue;
      lexicalImports.push({ scope: String(assignment.properties.scope ?? ''), offset: evidenceBySubject.get(assignment.id)?.endOffset ?? Number.MAX_SAFE_INTEGER, local: target });
    }
    for (const declaration of parsed.nodes) {
      if (!['python_class', 'python_function', 'python_async_function'].includes(declaration.kind)) continue;
      const qualifiedName = String(declaration.properties.qualifiedName ?? '');
      const pieces = qualifiedName.split('.');
      const local = pieces.pop();
      if (local) lexicalImports.push({ scope: pieces.join('.'), offset: evidenceBySubject.get(declaration.id)?.endOffset ?? Number.MAX_SAFE_INTEGER, local });
    }
    lexicalImports.sort((a, b) => a.offset - b.offset || a.scope.localeCompare(b.scope));
    const imports = importsAt(lexicalImports, '', Number.MAX_SAFE_INTEGER);
    return { path: file.path, imports, lexicalImports, pythonImports: parsed.imports, classes, assignments, evidenceBySubject };
  });
}

export function importsAt(bindings: SqlAlchemyCollectedFile['lexicalImports'], scope: string, offset: number) {
  const scopes = [''];
  if (scope) scopes.push(...scope.split('.').map((_, index, parts) => parts.slice(0, index + 1).join('.')));
  const result = new Map<string, string>();
  for (const current of scopes) {
    const latest = new Map<string, SqlAlchemyCollectedFile['lexicalImports'][number]>();
    for (const binding of bindings) if (binding.scope === current && binding.offset <= offset) latest.set(binding.local, binding);
    for (const [local, binding] of latest) if (binding.canonical) result.set(local, binding.canonical); else result.delete(local);
  }
  return result;
}

export function canonicalSqlAlchemyName(name: string, imports: Map<string, string>): string {
  const [head, ...tail] = name.split('.');
  const canonical = imports.get(head!);
  return canonical ? [canonical, ...tail].join('.') : name;
}

export function localAssignmentValue(assignments: GraphNode[], targetName: string, scope = ''): GraphNode | undefined {
  return assignments.find((node) => node.properties.scope === scope && expressionName(node.properties.target) === targetName);
}

export function expressionName(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const kind = value.kind;
  if (kind === 'name') return typeof value.name === 'string' ? value.name : undefined;
  if (kind === 'member') { const object = Array.isArray(value.children) ? expressionName(value.children[0]) : undefined; return object && typeof value.property === 'string' ? `${object}.${value.property}` : undefined; }
  if (kind === 'call') return typeof value.name === 'string' ? value.name : undefined;
  return undefined;
}

function isObject(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
