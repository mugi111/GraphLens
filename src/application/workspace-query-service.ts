import { createHash } from 'node:crypto';
import type { GraphEdge, GraphNode } from '../domain/graph.js';
import type { GraphStore } from '../infrastructure/sqlite/graph-store.js';
import { GraphProjectionError } from './unified-graph-projection.js';

export type WorkspaceGraphMode = 'roots' | 'children' | 'neighbors' | 'search';
export type WorkspaceGraphQuery = { workspaces: string[]; mode: WorkspaceGraphMode; node?: string; q?: string; kind?: string; direction: 'outgoing' | 'incoming' | 'both'; limit: number; cursor?: string; snapshot?: string; includeEvidence: boolean };
type Cursor = { v: 1; workspaces: string[]; query: string; snapshot: string; offset: number };
export class WorkspaceGraphError extends Error {
  constructor(public readonly code: 'INVALID_WORKSPACE_GRAPH_QUERY' | 'INVALID_CURSOR' | 'WORKSPACE_NOT_FOUND' | 'WORKSPACE_GRAPH_NODE_NOT_FOUND' | 'WORKSPACE_GRAPH_SNAPSHOT_CHANGED' | 'WORKSPACE_GRAPH_LIMIT_EXCEEDED' | 'WORKSPACE_GRAPH_DANGLING_EDGE' | 'UNIFIED_GRAPH_LIMIT_EXCEEDED', message: string, public readonly status: 400 | 404 | 409 | 422 = 400) { super(message); }
}

export function parseWorkspaceGraphQuery(params: URLSearchParams): { query: WorkspaceGraphQuery } | { error: string; code: 'INVALID_WORKSPACE_GRAPH_QUERY' } {
  const bad = (error: string) => ({ error, code: 'INVALID_WORKSPACE_GRAPH_QUERY' as const });
  const allowed = new Set(['workspaces', 'mode', 'node', 'q', 'kind', 'direction', 'limit', 'cursor', 'snapshot', 'include']);
  const values = new Map<string, string>();
  for (const [key, value] of params) { if (!allowed.has(key)) return bad(`Unknown query parameter '${key}'.`); if (values.has(key)) return bad(`Query parameter '${key}' must be supplied at most once.`); values.set(key, value); }
  const workspaceText = values.get('workspaces');
  if (!workspaceText) return bad('workspaces is required.');
  const workspaces = workspaceText.split(',');
  if (workspaces.length < 1 || workspaces.length > 16 || workspaces.some((id) => !id || id.length > 256 || id.includes('\0')) || new Set(workspaces).size !== workspaces.length) return bad('workspaces must contain 1–16 unique registered workspace IDs.');
  workspaces.sort();
  const mode = values.get('mode') ?? 'roots';
  if (!['roots', 'children', 'neighbors', 'search'].includes(mode)) return bad('mode must be roots, children, neighbors, or search.');
  const node = values.get('node'); const q = values.get('q'); const kind = values.get('kind');
  if ((mode === 'children' || mode === 'neighbors') !== (node !== undefined) || (node !== undefined && (!node || node.length > 512 || node.includes('\0')))) return bad('node is required only for children and neighbors modes.');
  if ((mode === 'search') !== (q !== undefined) || (q !== undefined && (!q || q.length > 256 || q.includes('\0')))) return bad('q is required only for search mode and must be 1–256 characters.');
  if (kind !== undefined && (!['roots', 'search'].includes(mode) || !kind || kind.length > 128 || kind.includes('\0'))) return bad('kind is allowed only in roots or search mode and must be an exact non-empty kind.');
  const direction = values.get('direction') ?? 'both';
  if (!['outgoing', 'incoming', 'both'].includes(direction) || (values.has('direction') && mode !== 'neighbors')) return bad('direction is allowed only for neighbors mode.');
  const limitText = values.get('limit') ?? '25';
  if (!/^[1-9]\d*$/.test(limitText) || !Number.isSafeInteger(Number(limitText)) || Number(limitText) > 100) return bad('limit must be an integer between 1 and 100.');
  const include = values.get('include');
  if (include !== undefined && include !== 'evidence') return bad("include accepts only 'evidence'.");
  const cursor = values.get('cursor'); const snapshot = values.get('snapshot');
  if (snapshot !== undefined && (!/^[A-Za-z0-9_-]{43}$/.test(snapshot))) return bad('snapshot is invalid.');
  return { query: { workspaces, mode: mode as WorkspaceGraphMode, ...(node !== undefined ? { node } : {}), ...(q !== undefined ? { q } : {}), ...(kind !== undefined ? { kind } : {}), direction: direction as WorkspaceGraphQuery['direction'], limit: Number(limitText), ...(cursor !== undefined ? { cursor } : {}), ...(snapshot !== undefined ? { snapshot } : {}), includeEvidence: include === 'evidence' } };
}

export class WorkspaceQueryService {
  constructor(private readonly store: GraphStore) {}
  query(query: WorkspaceGraphQuery) {
    const filters = JSON.stringify({ mode: query.mode, node: query.node ?? null, q: query.q ?? null, kind: query.kind ?? null, direction: query.direction, includeEvidence: query.includeEvidence });
    const queryHash = createHash('sha256').update(filters).digest('base64url');
    const cursor = query.cursor === undefined ? undefined : this.decodeCursor(query.cursor);
    if (cursor && (JSON.stringify(cursor.workspaces) !== JSON.stringify(query.workspaces) || cursor.query !== queryHash)) throw new WorkspaceGraphError('INVALID_CURSOR', 'Cursor does not belong to this workspace selection and query.');
    let result: ReturnType<GraphStore['workspaceGraphPage']>;
    try { result = this.store.workspaceGraphPage(query, cursor); }
    catch (error) {
      if (error instanceof GraphProjectionError) throw new WorkspaceGraphError('WORKSPACE_GRAPH_LIMIT_EXCEEDED', error.message, 422);
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('WORKSPACE_NOT_FOUND:')) throw new WorkspaceGraphError('WORKSPACE_NOT_FOUND', `Workspace not found: ${message.slice('WORKSPACE_NOT_FOUND:'.length)}.`, 404);
      if (message === 'WORKSPACE_GRAPH_NODE_NOT_FOUND') throw new WorkspaceGraphError('WORKSPACE_GRAPH_NODE_NOT_FOUND', 'The requested node is not present in the selected workspaces.', 404);
      if (message === 'WORKSPACE_GRAPH_LIMIT_EXCEEDED' || message === 'UNIFIED_GRAPH_LIMIT_EXCEEDED') throw new WorkspaceGraphError('WORKSPACE_GRAPH_LIMIT_EXCEEDED', 'The selected graph page exceeds the bounded response budget.', 422);
      if (message === 'WORKSPACE_GRAPH_DANGLING_EDGE') throw new WorkspaceGraphError('WORKSPACE_GRAPH_DANGLING_EDGE', 'A selected relationship refers to a node missing from the active workspace generations.', 422);
      if (message === 'WORKSPACE_GRAPH_SNAPSHOT_CHANGED') throw new WorkspaceGraphError('WORKSPACE_GRAPH_SNAPSHOT_CHANGED', 'The active workspace graph changed while paging. Reload the workspace view.', 409);
      if (message === 'INVALID_CURSOR') throw new WorkspaceGraphError('INVALID_CURSOR', 'Cursor is outside the result set.');
      throw error;
    }
    if ((query.snapshot !== undefined && query.snapshot !== result.snapshotId) || (cursor && cursor.snapshot !== result.snapshotId)) throw new WorkspaceGraphError('WORKSPACE_GRAPH_SNAPSHOT_CHANGED', 'The active workspace graph changed while paging. Reload the workspace view.', 409);
    if (cursor && !result.cursorValid) throw new WorkspaceGraphError('INVALID_CURSOR', 'Cursor is outside the result set.');
    const nextCursor = result.hasMore ? this.encodeCursor({ v: 1, workspaces: query.workspaces, query: queryHash, snapshot: result.snapshotId, offset: result.nextOffset! }) : undefined;
    const response = { snapshotId: result.snapshotId, workspaces: result.workspaces, generations: result.generations, query: { workspaces: query.workspaces, mode: query.mode, ...(query.node ? { node: query.node } : {}), ...(query.q !== undefined ? { q: query.q } : {}), ...(query.kind ? { kind: query.kind } : {}), ...(query.mode === 'neighbors' ? { direction: query.direction } : {}), limit: query.limit, ...(query.includeEvidence ? { include: ['evidence'] } : {}) }, page: { limit: query.limit, ...(nextCursor ? { nextCursor } : {}) }, rootIds: result.rootIds, nodes: result.nodes, edges: result.edges };
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 3 * 1_048_576) throw new WorkspaceGraphError('WORKSPACE_GRAPH_LIMIT_EXCEEDED', 'The complete workspace graph response exceeds the 3 MiB limit.', 422);
    return response;
  }
  private encodeCursor(payload: Cursor) { return Buffer.from(JSON.stringify(payload)).toString('base64url'); }
  private decodeCursor(value: string): Cursor {
    if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new WorkspaceGraphError('INVALID_CURSOR', 'Cursor is invalid.');
    let parsed: unknown; try { const decoded = Buffer.from(value, 'base64url'); if (decoded.toString('base64url') !== value) throw new Error(); parsed = JSON.parse(decoded.toString('utf8')); } catch { throw new WorkspaceGraphError('INVALID_CURSOR', 'Cursor is invalid.'); }
    if (!isCursor(parsed)) throw new WorkspaceGraphError('INVALID_CURSOR', 'Cursor is invalid.'); return parsed;
  }
}
function isCursor(value: unknown): value is Cursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>; const keys = Object.keys(item).sort().join(',');
  return keys === 'offset,query,snapshot,v,workspaces' && item.v === 1 && Array.isArray(item.workspaces) && item.workspaces.length >= 1 && item.workspaces.length <= 16 && item.workspaces.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256) && typeof item.query === 'string' && /^[A-Za-z0-9_-]{43}$/.test(item.query) && typeof item.snapshot === 'string' && /^[A-Za-z0-9_-]{43}$/.test(item.snapshot) && Number.isSafeInteger(item.offset) && Number(item.offset) >= 0;
}

// Keep structural references in this public module explicit for consumers of the service contract.
export type WorkspaceGraphNode = GraphNode;
export type WorkspaceGraphEdge = GraphEdge;
