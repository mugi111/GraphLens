import { randomUUID } from 'node:crypto';
import type { CodeGraphAdapter } from '../infrastructure/codegraph/adapter.js';
import { demoSnapshot } from '../infrastructure/codegraph/adapter.js';
import type { GraphStore } from '../infrastructure/sqlite/graph-store.js';

export class GraphService {
  private activeRunId?: string;
  constructor(private store: GraphStore, private adapter: CodeGraphAdapter) {}
  async sync(paths: string[], demo = false) {
    const runId = randomUUID();
    this.store.startRun(runId);
    return this.complete(runId, paths, demo);
  }
  startSync(paths: string[], demo = false) {
    if (this.activeRunId) return { run: this.store.run(this.activeRunId), alreadyRunning: true };
    const runId = randomUUID();
    this.store.startRun(runId);
    this.activeRunId = runId;
    void this.complete(runId, paths, demo).finally(() => { this.activeRunId = undefined; });
    return { run: this.store.run(runId), alreadyRunning: false };
  }
  private async complete(runId: string, paths: string[], demo: boolean) {
    try {
      if (!paths.length) throw new Error('At least one --workspace is required for sync.');
      // Fetch every input before one transaction changes the active snapshot set.
      const snapshots = await Promise.all(paths.map((path) => demo ? Promise.resolve(demoSnapshot(path)) : this.adapter.snapshot(path)));
      this.store.activateAll(snapshots);
      this.store.finishRun(runId, 'succeeded', demo ? 'Demo fixture snapshot activated.' : `Synced ${paths.length} workspace(s).`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.store.finishRun(runId, 'failed', detail);
    }
    return this.store.run(runId);
  }
}
