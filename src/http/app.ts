import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { GraphService } from '../application/graph-service.js';
import type { CodeGraphAdapter } from '../infrastructure/codegraph/adapter.js';
import type { GraphStore } from '../infrastructure/sqlite/graph-store.js';

export function createApp(store: GraphStore, adapter: CodeGraphAdapter, graphService: GraphService, workspacePaths: string[], webRoot: string) {
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
  app.get('/api/v1/graph', (c) => c.json(store.graph(c.req.query('workspace'), graphLimit(c.req.query('limit')))));
  app.get('/api/v1/nodes/:nodeId', (c) => { const node = store.node(c.req.param('nodeId')); return node ? c.json(node) : c.json({ error: 'Node not found' }, 404); });
  app.use('/*', serveStatic({ root: webRoot }));
  app.get('*', serveStatic({ path: `${webRoot}/index.html` }));
  return app;
}
function graphLimit(value: string | undefined) {
  if (value === undefined || !/^\d+$/.test(value)) return 500;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 2000) : 500;
}
