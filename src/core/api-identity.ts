/** Shared static identity for exact API methods and paths across analyzers. */
export function apiEndpointUri(namespace: string, method: string, path: string): string {
  return `api://${namespace}/${method.toUpperCase()}/${encodeURIComponent(path)}`;
}

/** Shape used for conservative endpoint matching; exact paths remain unchanged in identity. */
export function apiPathShape(path: string): string {
  return path.replace(/\{[^{}]+\}/g, '{}');
}
