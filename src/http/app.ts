import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { GraphService } from '../application/graph-service.js';
import { AnalysisError } from '../domain/analyzer.js';
import type { AnalyzerRunner } from '../application/analyzer-runner.js';
import type { CodeGraphAdapter } from '../infrastructure/codegraph/adapter.js';
import type { GraphStore } from '../infrastructure/sqlite/graph-store.js';

export function createApp(store: GraphStore, adapter: CodeGraphAdapter, graphService: GraphService, analyzerRunner: AnalyzerRunner, workspacePaths: string[], webRoot: string) {
  const app = new Hono();
  app.get('/api/v1/status', async (c) => c.json({ ...(store.status() as object), codegraph: await adapter.status() }));
  app.get('/api/v1/workspaces', (c) => c.json({ workspaces: store.workspaces() }));
  app.post('/api/v1/sync', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { workspaces?: string[]; demo?: boolean };
    const paths = Array.isArray(body.workspaces) ? body.workspaces : workspacePaths;
    const { run, alreadyRunning } = graphService.startSync(paths, body.demo === true);
    return c.json(run, alreadyRunning ? 409 : 202);
  });
  app.get('/api/v1/sync/:runId', (c) => { const run = store.run(c.req.param('runId')); return run ? c.json(run) : c.json({ error: 'Sync run not found' }, 404); });
  app.get('/api/v1/analyzers', (c) => c.json({ analyzers: analyzerRunner.list() }));
  app.get('/api/v1/plugins', (c) => c.json({ plugins: store.plugins() }));
  app.post('/api/v1/analysis-runs', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { workspaceId?: string; analyzerId?: string; sourceRevision?: string; config?: Record<string, never> };
    if (typeof body.workspaceId !== 'string' || typeof body.analyzerId !== 'string' || (body.sourceRevision !== undefined && typeof body.sourceRevision !== 'string') || (body.config !== undefined && (!body.config || Array.isArray(body.config)))) return c.json({ error: 'workspaceId and analyzerId are required; config must be an object.' }, 400);
    try { return c.json(analyzerRunner.start({ workspaceId: body.workspaceId, analyzerId: body.analyzerId, sourceRevision: body.sourceRevision, config: body.config }), 202); }
    catch (error) { if (error instanceof AnalysisError) return c.json({ error: error.message, code: error.code, diagnostics: error.diagnostics }, error.code === 'RUN_ALREADY_ACTIVE' ? 409 : error.code === 'WORKSPACE_NOT_FOUND' || error.code === 'ANALYZER_NOT_FOUND' ? 404 : 400); throw error; }
  });
  app.get('/api/v1/analysis-runs', (c) => c.json({ runs: store.analysisRuns(c.req.query('workspace'), runLimit(c.req.query('limit'))) }));
  app.get('/api/v1/analysis-runs/:runId', (c) => { const run = store.analysisRun(c.req.param('runId')); return run ? c.json({ ...run, diagnostics: store.analysisDiagnostics(run.id) }) : c.json({ error: 'Analysis run not found' }, 404); });
  app.get('/api/v1/graph', (c) => c.json(store.graph(c.req.query('workspace'), graphLimit(c.req.query('limit')))));
  app.get('/api/v1/nodes/:nodeId', (c) => { const node = store.node(c.req.param('nodeId')); return node ? c.json(node) : c.json({ error: 'Node not found' }, 404); });
  app.use('/*', serveStatic({ root: webRoot }));
  app.get('*', serveStatic({ path: `${webRoot}/index.html` }));
  return app;
}
function runLimit(value: string | undefined) { return value === undefined || !/^\d+$/.test(value) ? 50 : Math.min(Math.max(Number(value), 1), 200); }
function graphLimit(value: string | undefined) {
  if (value === undefined || !/^\d+$/.test(value)) return 500;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 2000) : 500;
}
