import { createHash } from 'node:crypto';
import { normalize, resolve, sep } from 'node:path';

/**
 * Creates stable, database-independent graph identifiers. Analyzer output must use
 * canonical source identities; SQLite generation ids are deliberately never exposed.
 */
export class GraphIdentityFactory {
  node(workspaceId: string, uri: string, kind: string): string {
    return hash('node', workspaceId, canonicalUri(uri), kind);
  }

  edge(workspaceId: string, sourceId: string, targetId: string, kind: string): string {
    return hash('edge', workspaceId, sourceId, targetId, kind);
  }

  workspace(path: string): string {
    return hash('workspace', canonicalUri(path));
  }
}

export function canonicalUri(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return url.toString();
    return `file://${normalize(decodeURIComponent(url.pathname)).split(sep).join('/')}`;
  } catch {
    return `file://${resolve(value).split(sep).join('/')}`;
  }
}

function hash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);
}
