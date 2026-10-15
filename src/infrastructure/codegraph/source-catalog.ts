import type { SourceCatalogReader } from '../../domain/source-identity.js';
import type { GraphStore } from '../sqlite/graph-store.js';

/** A workspace-bound adapter over the active CodeGraph generation in GraphStore. */
export class CodeGraphSourceCatalogReader implements SourceCatalogReader {
  constructor(private readonly store: GraphStore, private readonly workspaceId: string) {}
  snapshot(maxItems?: number) { return this.store.sourceCatalog(this.workspaceId, maxItems); }
}
