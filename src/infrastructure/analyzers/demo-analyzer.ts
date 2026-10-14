import { createHash } from 'node:crypto';
import type { Analyzer, AnalysisContext, AnalysisResult } from '../../domain/analyzer.js';

/** Explicit local fixture analyzer for previewing GraphLens without CodeGraph import. */
export const demoAnalyzer: Analyzer = {
  descriptor: { id: 'builtin.demo', version: '1.0.0', apiVersion: '1', capabilities: ['graph', 'evidence', 'diagnostics'] },
  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    const id = (value: string) => stable(context.workspace.id, value);
    const node = (key: string, label: string, kind: string, properties: Record<string, unknown>) => ({ id: id(key), workspaceId: context.workspace.id, label, kind, properties });
    const app = node('app', 'Application', 'module', { role: 'entrypoint' });
    const api = node('api', 'HTTP API', 'module', { role: 'transport' });
    const store = node('store', 'Graph Store', 'database', { role: 'persistence' });
    const edge = (key: string, sourceId: string, targetId: string) => ({ id: id(key), workspaceId: context.workspace.id, sourceId, targetId, kind: 'depends_on', properties: { fixture: true } });
    const edges = [edge('app-api', app.id, api.id), edge('api-store', api.id, store.id)];
    const evidence = [...[app, api, store].map((item) => evidenceFor('node', item.id)), ...edges.map((item) => evidenceFor('edge', item.id))];
    return { nodes: [app, api, store], edges, evidence, diagnostics: [{ code: 'DEMO_FIXTURE', severity: 'info', message: 'Local preview fixture; not CodeGraph data.' }] };
  },
};
function evidenceFor(subjectKind: 'node' | 'edge', subjectId: string) { return { id: stable(subjectKind, subjectId), subjectKind, subjectId, level: 'DIRECT' as const, type: 'demo', detail: 'Local preview fixture; not CodeGraph data.' }; }
function stable(scope: string, value: string) { return createHash('sha256').update(`${scope}:${value}`).digest('hex').slice(0, 24); }
