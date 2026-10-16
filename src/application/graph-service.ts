import { randomUUID } from 'node:crypto';
import type { CodeGraphAdapter } from '../infrastructure/codegraph/adapter.js';
import type { GraphStore } from '../infrastructure/sqlite/graph-store.js';

export class GraphService {
  private activeRunId?: string;
  constructor(private store: GraphStore, private adapter: CodeGraphAdapter) {}
  async sync(paths: string[]) {
    const runId = randomUUID();
    this.store.startRun(runId);
    return this.complete(runId, paths);
  }
  startSync(paths: string[]) {
    if (this.activeRunId) return { run: this.store.run(this.activeRunId), alreadyRunning: true };
    const runId = randomUUID();
    this.store.startRun(runId);
    this.activeRunId = runId;
    void this.complete(runId, paths).finally(() => { this.activeRunId = undefined; });
    return { run: this.store.run(runId), alreadyRunning: false };
  }
  private async complete(runId: string, paths: string[]) {
    try {
      if (!paths.length) throw new Error('At least one --workspace is required for sync.');
      // Fetch every input before one transaction changes the active snapshot set.
      const snapshots = await Promise.all(paths.map((path) => this.adapter.snapshot(path)));
      this.store.activateAll(snapshots);
      this.store.finishRun(runId, 'succeeded', `Synced ${paths.length} workspace(s).`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.store.finishRun(runId, 'failed', detail);
    }
    return this.store.run(runId);
  }
}
