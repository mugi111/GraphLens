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
    const imports = new Map<string, string>();
    for (const imported of parsed.imports) {
      if (imported.relativeLevel) continue;
      if (imported.imported) {
        if (imported.imported === '*') continue;
        const local = imported.alias ?? imported.imported;
        const canonical = `${imported.module}.${imported.imported}`;
        if (canonical === 'sqlalchemy' || canonical.startsWith('sqlalchemy.')) imports.set(local, canonical);
      } else {
        const local = imported.alias ?? imported.module.split('.')[0]!;
        if (imported.module === 'sqlalchemy' || imported.module.startsWith('sqlalchemy.')) imports.set(local, imported.module);
      }
    }
    const classes = parsed.nodes.filter((node) => node.kind === 'python_class');
    const assignments = parsed.nodes.filter((node) => node.kind === 'python_assignment');
    const evidenceBySubject = new Map<string, AnalysisEvidence>();
    for (const evidence of parsed.evidence) if (evidence.subjectKind === 'node') evidenceBySubject.set(evidence.subjectId, evidence);
    return { path: file.path, imports, classes, assignments, evidenceBySubject };
  });
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
