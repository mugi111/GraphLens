import { randomUUID } from 'node:crypto';
import { AnalysisError, type Analyzer, type AnalyzerDescriptor, type JsonValue } from '../domain/analyzer.js';
import type { Workspace } from '../domain/graph.js';
import type { GraphStore, AnalysisRun } from '../infrastructure/sqlite/graph-store.js';
import { AnalyzerRegistry } from './analyzer-registry.js';
import { validateAnalysisResult } from './analyzer-result-validator.js';

export type StartAnalysisRequest = { workspaceId: string; analyzerId: string; sourceRevision?: string; config?: Record<string, JsonValue> };

/** Starts analyzer work asynchronously; SQLite is the authority for run exclusivity. */
export class AnalyzerRunner {
  constructor(private readonly store: GraphStore, private readonly registry: AnalyzerRegistry) {}
  list(): AnalyzerDescriptor[] { return this.registry.list(); }
  start(request: StartAnalysisRequest): AnalysisRun {
    const analyzer = this.registry.get(request.analyzerId);
    if (!analyzer) throw new AnalysisError('ANALYZER_NOT_FOUND', `Analyzer '${request.analyzerId}' is not registered.`);
    const workspace = this.store.getWorkspace(request.workspaceId);
    if (!workspace) throw new AnalysisError('WORKSPACE_NOT_FOUND', `Workspace '${request.workspaceId}' was not found.`);
    const runId = randomUUID();
    let run: AnalysisRun;
    try { run = this.store.startAnalysisRun(runId, workspace.id, analyzer.descriptor, request.sourceRevision, request.config ?? {}); }
    catch (error) {
      if (sqliteConstraint(error)) throw new AnalysisError('RUN_ALREADY_ACTIVE', `Analyzer '${request.analyzerId}' already has a running analysis for this workspace.`);
      throw error;
    }
    void this.execute(runId, analyzer.descriptor, analyzer, workspace, request.sourceRevision, request.config ?? {});
    return run;
  }
  private async execute(runId: string, descriptor: AnalyzerDescriptor, analyzer: Analyzer, workspace: Workspace, sourceRevision: string | undefined, config: Record<string, JsonValue>) {
    try {
      const result = await analyzer.analyze({ workspace, sourceRevision, config, architectureInputProvider: this.store });
      if (sourceRevision !== undefined && result.sourceRevision !== undefined && sourceRevision !== result.sourceRevision) throw new AnalysisError('INVALID_RESULT', 'Computed source revision does not match the requested revision.', [{ code: 'SOURCE_REVISION_MISMATCH', severity: 'error', message: 'Computed source revision does not match the requested revision.' }]);
      validateAnalysisResult(result, descriptor, workspace.id, this.store.activeGraphIds(workspace.id, descriptor.id));
      this.store.completeAnalysisRun(runId, descriptor, result);
    } catch (error) {
      const known = error instanceof AnalysisError ? error : new AnalysisError('ANALYZER_FAILED', message(error));
      try { this.store.failAnalysisRun(runId, known.code, known.message, known.diagnostics); }
      catch { /* The original failure is durable whenever SQLite remains available. */ }
    }
  }
}
function sqliteConstraint(error: unknown) { return error instanceof Error && /constraint/i.test(error.message); }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
