import { createHash } from 'node:crypto';
import type { PythonSourceConfig, PythonSourceFile } from './python-source-types.js';

/** Decodes only strict UTF-8, allowing a single leading UTF-8 BOM. */
export function decodePythonSource(bytes: Buffer, path: string): string {
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`Python source '${path}' is not valid UTF-8.`); }
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
}

/** Hashes a versioned, unambiguous length-framed representation of effective input. */
export function pythonSourceRevision(config: PythonSourceConfig, files: PythonSourceFile[]): string {
  const hash = createHash('sha256');
  frame(hash, 'python-source-v1');
  frame(hash, canonicalJson(config));
  for (const file of [...files].sort((a, b) => lexical(a.path, b.path))) {
    frame(hash, file.path);
    frame(hash, String(file.bytes.length));
    frame(hash, file.hash);
  }
  return `python-source-v1:${hash.digest('hex')}`;
}

export function sha256(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
function frame(hash: ReturnType<typeof createHash>, value: string) { const bytes = Buffer.from(value, 'utf8'); const length = Buffer.allocUnsafe(4); length.writeUInt32BE(bytes.length); hash.update(length).update(bytes); }
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => lexical(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`; return JSON.stringify(value); }
function lexical(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
