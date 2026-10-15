import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

export type SourceHttpStatus = 400 | 404 | 409 | 413 | 415;
export class SourceReadError extends Error { constructor(readonly code: string, message: string, readonly status: SourceHttpStatus = 400) { super(message); } }
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

export async function readCurrentSource(rootPath: string, uri: string, recordedLine?: number) {
  if (!uri || uri.length > 4096 || uri.includes('\0') || uri.includes('\\') || uri.includes('%') || isAbsolute(uri) || /^[a-z][a-z\d+.-]*:/i.test(uri) || /^[A-Za-z]:/.test(uri) || uri.startsWith('//')) throw new SourceReadError('SOURCE_LOCATION_UNAVAILABLE', 'Evidence does not identify a safe workspace-relative file.');
  const segments = uri.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) throw new SourceReadError('SOURCE_LOCATION_UNAVAILABLE', 'Evidence does not identify a safe workspace-relative file.');
  const root = await realpath(rootPath);
  const target = join(root, ...segments);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || segments.length > 128) throw new SourceReadError('SOURCE_LOCATION_UNAVAILABLE', 'Evidence does not identify a safe workspace-relative file.');
  let cursor = root;
  for (const part of segments) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor).catch(() => undefined);
    if (!stat) throw new SourceReadError('SOURCE_FILE_UNAVAILABLE', 'The current working file is unavailable.', 404);
    if (stat.isSymbolicLink()) throw new SourceReadError('SOURCE_LOCATION_UNAVAILABLE', 'Symbolic links are not opened by the source viewer.');
  }
  const before = await lstat(target);
  if (!before.isFile()) throw new SourceReadError('SOURCE_FILE_UNAVAILABLE', 'The evidence location is not a regular file.', 404);
  if (before.size > MAX_SOURCE_BYTES) throw new SourceReadError('SOURCE_FILE_TOO_LARGE', 'The current working file exceeds the 2 MiB source limit.', 413);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined);
  if (!handle) throw new SourceReadError('SOURCE_FILE_UNAVAILABLE', 'The current working file could not be opened.', 404);
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || await realpath(target) !== target) throw new SourceReadError('SOURCE_FILE_CHANGED', 'The current working file changed while it was being opened.', 409);
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let bytesReadTotal = 0;
    while (bytesReadTotal < buffer.length) {
      const read = await handle.read(buffer, bytesReadTotal, buffer.length - bytesReadTotal, bytesReadTotal);
      if (read.bytesRead === 0) break;
      bytesReadTotal += read.bytesRead;
    }
    if (bytesReadTotal > MAX_SOURCE_BYTES) throw new SourceReadError('SOURCE_FILE_TOO_LARGE', 'The current working file exceeds the 2 MiB source limit.', 413);
    if (bytesReadTotal !== opened.size) throw new SourceReadError('SOURCE_FILE_CHANGED', 'The source descriptor ended before its recorded size was read.', 409);
    bytes = buffer.subarray(0, bytesReadTotal);
    const after = await handle.stat();
    const pathAfter = await lstat(target);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || pathAfter.isSymbolicLink() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino || pathAfter.size !== opened.size || pathAfter.mtimeMs !== opened.mtimeMs || pathAfter.ctimeMs !== opened.ctimeMs || await realpath(target) !== target) throw new SourceReadError('SOURCE_FILE_CHANGED', 'The current working file changed while it was being read.', 409);
  } finally { await handle.close(); }
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new SourceReadError('SOURCE_FILE_UNSUPPORTED', 'Binary or invalid UTF-8 source files cannot be displayed.', 415); }
  if (content.includes('\0')) throw new SourceReadError('SOURCE_FILE_UNSUPPORTED', 'Binary source files cannot be displayed.', 415);
  const lines = content.split(/\r?\n/);
  const focusLine = recordedLine ?? 1;
  if (!Number.isSafeInteger(focusLine) || focusLine < 1 || focusLine > lines.length) throw new SourceReadError('SOURCE_LOCATION_STALE', 'The recorded source line is no longer present in the current working file.', 409);
  const startLine = Math.max(1, focusLine - 25);
  const endLine = Math.min(lines.length, startLine + 99);
  const displayed = lines.slice(startLine - 1, endLine).map((text, index) => ({ line: startLine + index, text }));
  const payload = { path: segments.join('/'), focusLine, startLine, endLine, lines: displayed, sha256: createHash('sha256').update(bytes).digest('hex'), state: 'current-working-file' as const };
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_RESPONSE_BYTES) throw new SourceReadError('SOURCE_RESPONSE_TOO_LARGE', 'The selected source window exceeds the 64 KiB response limit.', 413);
  return payload;
}
