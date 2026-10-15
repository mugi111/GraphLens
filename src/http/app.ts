import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { GraphService } from '../application/graph-service.js';
import { AnalysisError } from '../domain/analyzer.js';
import type { AnalyzerRunner } from '../application/analyzer-runner.js';
import type { CodeGraphAdapter } from '../infrastructure/codegraph/adapter.js';
import type { GraphStore } from '../infrastructure/sqlite/graph-store.js';
import { DatabaseSchemaError, type DatabaseSchemaQuery, type DatabaseSchemaService } from '../application/database-schema-service.js';
import { ArchitectureQueryError, parseArchitectureQuery, type ArchitectureQueryService } from '../application/architecture-query-service.js';
import { CrossWorkspaceQueryError, parseCrossWorkspaceArchitectureQuery, type CrossWorkspaceQueryService } from '../application/cross-workspace-query-service.js';

export function createApp(store: GraphStore, adapter: CodeGraphAdapter, graphService: GraphService, analyzerRunner: AnalyzerRunner, databaseSchema: DatabaseSchemaService, architectureQuery: ArchitectureQueryService, crossWorkspaceQuery: CrossWorkspaceQueryService, workspacePaths: string[], webRoot: string) {
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
  app.get('/api/v1/plugins', (c) => c.json({ plugins: store.pluginInventory() }));
  app.post('/api/v1/analysis-runs', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { workspaceId?: string; analyzerId?: string; sourceRevision?: string; config?: Record<string, never> };
    if (typeof body.workspaceId !== 'string' || typeof body.analyzerId !== 'string' || (body.sourceRevision !== undefined && typeof body.sourceRevision !== 'string') || (body.config !== undefined && (!body.config || Array.isArray(body.config)))) return c.json({ error: 'workspaceId and analyzerId are required; config must be an object.' }, 400);
    try { return c.json(analyzerRunner.start({ workspaceId: body.workspaceId, analyzerId: body.analyzerId, sourceRevision: body.sourceRevision, config: body.config }), 202); }
    catch (error) { if (error instanceof AnalysisError) return c.json({ error: error.message, code: error.code, diagnostics: error.diagnostics }, error.code === 'RUN_ALREADY_ACTIVE' ? 409 : error.code === 'WORKSPACE_NOT_FOUND' || error.code === 'ANALYZER_NOT_FOUND' ? 404 : 400); throw error; }
  });
  app.get('/api/v1/analysis-runs', (c) => c.json({ runs: store.analysisRuns(c.req.query('workspace'), runLimit(c.req.query('limit'))) }));
  app.get('/api/v1/analysis-runs/:runId', (c) => { const run = store.analysisRun(c.req.param('runId')); return run ? c.json({ ...run, diagnostics: store.analysisDiagnostics(run.id) }) : c.json({ error: 'Analysis run not found' }, 404); });
  app.get('/api/v1/database/schema', (c) => {
    const parsed = parseDatabaseSchemaQuery(new URL(c.req.url).searchParams);
    if ('error' in parsed) return c.json({ error: parsed.error, code: parsed.code }, 400);
    try { return c.json(databaseSchema.query(parsed.query)); }
    catch (error) {
      if (error instanceof DatabaseSchemaError) return c.json({ error: error.message, code: error.code }, error.status);
      return c.json({ error: 'Database schema query failed.', code: 'DATABASE_QUERY_FAILED' }, 500);
    }
  });
  app.get('/api/v1/architecture', (c) => {
    const parsed = parseArchitectureQuery(new URL(c.req.url).searchParams);
    if ('error' in parsed) return c.json({ error: parsed.error, code: parsed.code }, 400);
    try { return c.json(architectureQuery.query(parsed.query)); }
    catch (error) { if (error instanceof ArchitectureQueryError) return c.json({ error: error.message, code: error.code }, error.status); return c.json({ error: 'Architecture query failed.', code: 'ARCHITECTURE_QUERY_FAILED' }, 500); }
  });
  app.get('/api/v1/cross-workspace/architecture', (c) => {
    const parsed = parseCrossWorkspaceArchitectureQuery(new URL(c.req.url).searchParams);
    if ('error' in parsed) return c.json({ error: parsed.error, code: parsed.code }, 400);
    try { return c.json(crossWorkspaceQuery.query(parsed.query)); }
    catch (error) {
      if (error instanceof CrossWorkspaceQueryError) return c.json({ error: error.message, code: error.code }, error.status);
      return c.json({ error: 'Cross-workspace architecture query failed.', code: 'CROSS_WORKSPACE_QUERY_FAILED' }, 500);
    }
  });
  app.get('/api/v1/graph', (c) => c.json(store.graph(c.req.query('workspace'), graphLimit(c.req.query('limit')))));
  app.get('/api/v1/nodes/:nodeId', (c) => { const node = store.node(c.req.param('nodeId')); return node ? c.json(node) : c.json({ error: 'Node not found' }, 404); });
  app.use('/*', serveStatic({ root: webRoot }));
  app.get('*', serveStatic({ path: `${webRoot}/index.html` }));
  return app;
}
function parseDatabaseSchemaQuery(params: URLSearchParams): { query: DatabaseSchemaQuery } | { error: string; code: 'WORKSPACE_REQUIRED' | 'INVALID_DATABASE_QUERY' } {
  const invalid = (error: string) => ({ error, code: 'INVALID_DATABASE_QUERY' as const });
  const allowed = new Set(['workspace', 'root', 'namespace', 'schema', 'table', 'model', 'limit', 'cursor', 'include']);
  const values = new Map<string, string>();
  for (const [key, value] of params) {
    if (!allowed.has(key)) return invalid(`Unknown query parameter '${key}'.`);
    if (values.has(key)) return invalid(`Query parameter '${key}' must be supplied at most once.`);
    values.set(key, value);
  }
  const workspace = values.get('workspace');
  if (!workspace) return { error: 'workspace is required.', code: 'WORKSPACE_REQUIRED' };
  if (workspace.length > 256) return invalid('workspace is invalid.');
  const root = values.get('root') ?? 'table';
  if (root !== 'table' && root !== 'model') return invalid("root must be 'table' or 'model'.");
  const namespace = values.get('namespace');
  if (namespace !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(namespace)) return invalid('namespace must be a stable identifier.');
  const schema = values.get('schema');
  if (schema !== undefined && (schema.length > 255 || schema.includes('\0'))) return invalid('schema is invalid.');
  const table = values.get('table');
  if (table !== undefined && (!table || table.length > 255 || table.includes('\0'))) return invalid('table must be a non-empty exact name.');
  const model = values.get('model');
  if (model !== undefined && (!model || model.length > 512 || model.includes('\0'))) return invalid('model must be a non-empty exact name.');
  const limitText = values.get('limit') ?? '25';
  if (!/^[1-9]\d*$/.test(limitText) || !Number.isSafeInteger(Number(limitText)) || Number(limitText) > 100) return invalid('limit must be an integer between 1 and 100.');
  const cursor = values.get('cursor');
  const includeText = values.get('include');
  const include = includeText === undefined ? [] : includeText.split(',');
  if (includeText === '' || include.some((item) => !['evidence', 'diagnostics'].includes(item)) || new Set(include).size !== include.length) return invalid('include accepts a comma-separated list of evidence and diagnostics.');
  return { query: { workspace, root, ...(namespace !== undefined ? { namespace } : {}), ...(schema !== undefined ? { schema } : {}), ...(table !== undefined ? { table } : {}), ...(model !== undefined ? { model } : {}), limit: Number(limitText), ...(cursor !== undefined ? { cursor } : {}), includeEvidence: include.includes('evidence'), includeDiagnostics: include.includes('diagnostics') } };
}
function runLimit(value: string | undefined) { return value === undefined || !/^\d+$/.test(value) ? 50 : Math.min(Math.max(Number(value), 1), 200); }
function graphLimit(value: string | undefined) {
  if (value === undefined || !/^\d+$/.test(value)) return 500;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 2000) : 500;
}
