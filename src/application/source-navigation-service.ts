import { Buffer } from 'node:buffer';
import type { GraphStore } from '../infrastructure/sqlite/graph-store.js';
import { readCurrentSource, SourceReadError, type SourceHttpStatus } from '../infrastructure/runtime/source-reader.js';

export class SourceNavigationError extends Error { constructor(readonly code: string, message: string, readonly status: SourceHttpStatus) { super(message); } }
export class SourceNavigationService {
  constructor(private readonly store: GraphStore) {}
  async open(input: { workspaceId: string; analyzerId: string; generationId: number; evidenceId: string }) {
    const { workspaceId, analyzerId, generationId, evidenceId } = input;
    const row = this.store.activeSourceEvidence(workspaceId, analyzerId, generationId, evidenceId);
    if (!row) {
      if (!this.store.sourceGenerationIsActive(workspaceId, analyzerId, generationId)) throw new SourceNavigationError('SOURCE_GENERATION_CHANGED', 'The requested analyzer generation is no longer active.', 409);
      throw new SourceNavigationError('SOURCE_EVIDENCE_NOT_FOUND', 'The evidence does not exist in the requested active generation.', 404);
    }
    if (row.payloadTooLarge) throw new SourceNavigationError('SOURCE_EVIDENCE_TOO_LARGE', 'The evidence payload exceeds the 64 KiB lookup limit.', 413);
    const evidence = JSON.parse(row.payload_json) as { uri?: unknown; line?: unknown };
    if (typeof evidence.uri !== 'string') throw new SourceNavigationError('SOURCE_LOCATION_UNAVAILABLE', 'This evidence has no local source location.', 404);
    try {
      if (!this.store.sourceGenerationIsActive(workspaceId, analyzerId, generationId)) throw new SourceNavigationError('SOURCE_GENERATION_CHANGED', 'The requested analyzer generation changed before the source was read.', 409);
      const source = await readCurrentSource(row.path, evidence.uri, typeof evidence.line === 'number' ? evidence.line : undefined);
      if (!this.store.sourceGenerationIsActive(workspaceId, analyzerId, generationId)) throw new SourceNavigationError('SOURCE_GENERATION_CHANGED', 'The requested analyzer generation changed while the source was being read.', 409);
      const response = { workspace: { id: row.workspace_id, name: row.name }, analyzerId, generationId, evidenceId, ...source };
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 64 * 1024) throw new SourceNavigationError('SOURCE_RESPONSE_TOO_LARGE', 'The source response exceeds the 64 KiB limit.', 413);
      return response;
    } catch (error) {
      if (error instanceof SourceNavigationError) throw error;
      if (error instanceof SourceReadError) throw new SourceNavigationError(error.code, error.message, error.status);
      throw new SourceNavigationError('SOURCE_FILE_UNAVAILABLE', 'The current working file could not be read.', 404);
    }
  }
}
