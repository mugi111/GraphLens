import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const FIXED_EXCLUDES = new Set(['.git', '.hg', '.svn', 'node_modules', 'build', 'dist', '.venv', 'venv', '__pycache__', '.next', 'coverage']);
const MAX_ENTRIES = 100_000;
const MAX_DIRECTORIES = 20_000;
const MAX_DEPTH = 64;
const HARD = { files: 64, fileBytes: 10 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 };

export type OpenApiConfig = { apiNamespace: string; specFiles: string[]; discover: boolean; maxSpecFiles: number; maxFileBytes: number; maxTotalBytes: number };
export type OpenApiSourceFile = { path: string; bytes: Buffer; source: string; hash: string; absolute: string; size: number; ino: number; mtimeMs: number };
export type OpenApiSnapshot = { sourceRevision: string; files: OpenApiSourceFile[] };
type Entry = { path: string; absolute: string; size: number; ino: number; mtimeMs: number };

export function openApiConfig(input: Record<string, unknown>): OpenApiConfig {
  const allowed = new Set(['apiNamespace', 'specFiles', 'discover', 'maxSpecFiles', 'maxFileBytes', 'maxTotalBytes']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unsupported OpenAPI option '${key}'.`);
  const apiNamespace = input.apiNamespace ?? 'default';
  if (typeof apiNamespace !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(apiNamespace)) throw new Error('apiNamespace must be 1 to 128 letters, digits, dots, underscores, or hyphens.');
  const paths = (value: unknown, name: string) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 512 || item.startsWith('/') || item.includes('\\') || item.split('/').some((part) => part === '..' || part === '.' || part === '') || !['.json', '.yaml', '.yml'].includes(extname(item).toLowerCase()))) throw new Error(`${name} must contain at most 64 safe relative JSON/YAML file paths.`);
    return [...new Set((value as string[]).map((item) => item.normalize('NFC')))].sort();
  };
  const bounded = (value: unknown, fallback: number, max: number, name: string) => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error(`${name} must be an integer between 1 and ${max}.`);
    return Number(value);
  };
  const discover = input.discover ?? true;
  if (typeof discover !== 'boolean') throw new Error('discover must be a boolean.');
  const specFiles = paths(input.specFiles, 'specFiles');
  if (!discover && !specFiles.length) throw new Error('specFiles is required when discovery is disabled.');
  return { apiNamespace, specFiles, discover, maxSpecFiles: bounded(input.maxSpecFiles, 64, HARD.files, 'maxSpecFiles'), maxFileBytes: bounded(input.maxFileBytes, 5 * 1024 * 1024, HARD.fileBytes, 'maxFileBytes'), maxTotalBytes: bounded(input.maxTotalBytes, 20 * 1024 * 1024, HARD.totalBytes, 'maxTotalBytes') };
}

export async function readOpenApiSnapshot(rootInput: string, config: OpenApiConfig, requestedRevision?: string): Promise<OpenApiSnapshot> {
  const rootPath = resolve(rootInput);
  const rootInfo = await lstat(rootPath);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('OpenAPI workspace root must be a real directory, not a symlink.');
  const root = await realpath(rootPath);
  const initial = await inventory(root, config);
  const found = new Set(initial.map((item) => item.path));
  const missing = config.specFiles.filter((path) => !found.has(path));
  if (missing.length) throw new Error(`Explicit OpenAPI specFiles not found: ${missing.join(', ')}.`);
  const files: OpenApiSourceFile[] = [];
  let total = 0;
  for (const item of initial) {
    const pathInfo = await checked(item.absolute, root, false);
    const handle = await open(item.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!same(before, pathInfo) || before.size > config.maxFileBytes) throw new Error(`OpenAPI document '${item.path}' changed during analysis.`);
      const bytes = await boundedRead(handle, config.maxFileBytes);
      const after = await handle.stat();
      const currentPath = await checked(item.absolute, root, false);
      if (!same(before, after) || !same(after, currentPath) || bytes.length !== item.size || after.ino !== item.ino) throw new Error(`OpenAPI document '${item.path}' changed during analysis.`);
      total += bytes.length;
      if (total > config.maxTotalBytes) throw new Error(`OpenAPI sources exceed maxTotalBytes (${config.maxTotalBytes}).`);
      let source: string;
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error(`OpenAPI document '${item.path}' is not valid UTF-8.`); }
      if (source.startsWith('\uFEFF')) source = source.slice(1);
      files.push({ ...item, bytes, source, hash: createHash('sha256').update(bytes).digest('hex') });
    } finally { await handle.close(); }
  }
  const after = await inventory(root, config);
  if (initial.length !== after.length || initial.some((item, index) => !sameEntry(item, after[index]))) throw new Error('OpenAPI source inventory changed during analysis.');
  const sourceRevision = revision(config, files);
  if (requestedRevision !== undefined && requestedRevision !== sourceRevision) throw new Error('Computed OpenAPI source revision does not match the requested revision.');
  return { sourceRevision, files };
}

async function inventory(root: string, config: OpenApiConfig): Promise<Entry[]> {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  const explicit = new Set(config.specFiles);
  let entryCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;
  async function visit(directory: string, depth: number) {
    if (depth > MAX_DEPTH) throw new Error(`OpenAPI directory depth exceeds ${MAX_DEPTH}.`);
    if (++directoryCount > MAX_DIRECTORIES) throw new Error(`OpenAPI directory count exceeds ${MAX_DIRECTORIES}.`);
    const before = await checked(directory, root, true);
    const dir = await opendir(directory);
    const names: string[] = [];
    for await (const entry of dir) {
      if (++entryCount > MAX_ENTRIES) throw new Error(`OpenAPI inventory exceeds ${MAX_ENTRIES} directory entries.`);
      names.push(entry.name);
    }
    names.sort((a, b) => lexical(a.normalize('NFC'), b.normalize('NFC')));
    for (const name of names) {
      if (FIXED_EXCLUDES.has(name)) continue;
      const absolute = join(directory, name);
      const path = relative(root, absolute).split(sep).join('/').normalize('NFC');
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      const canonical = await realpath(absolute);
      contained(root, canonical, path);
      if (info.isDirectory()) { await visit(canonical, depth + 1); continue; }
      if (!info.isFile() || !['.json', '.yaml', '.yml'].includes(extname(name).toLowerCase())) continue;
      const isSpecFile = explicit.has(path);
      const discovered = config.discover && isDefaultSpec(path);
      if (!isSpecFile && !discovered) continue;
      if (seen.has(path)) throw new Error(`OpenAPI paths collide after NFC normalization: '${path}'.`);
      seen.add(path);
      const verified = await checked(absolute, root, false);
      if (verified.size > config.maxFileBytes) throw new Error(`OpenAPI document '${path}' exceeds maxFileBytes (${config.maxFileBytes}).`);
      totalBytes += verified.size;
      if (totalBytes > config.maxTotalBytes) throw new Error(`OpenAPI sources exceed maxTotalBytes (${config.maxTotalBytes}).`);
      entries.push({ path, absolute, size: verified.size, ino: verified.ino, mtimeMs: verified.mtimeMs });
      if (entries.length > config.maxSpecFiles) throw new Error(`OpenAPI document count exceeds maxSpecFiles (${config.maxSpecFiles}).`);
    }
    const after = await checked(directory, root, true);
    if (!same(before, after)) throw new Error('OpenAPI workspace directory changed during analysis.');
  }
  await visit(root, 0);
  return entries.sort((a, b) => lexical(a.path, b.path));
}

async function boundedRead(handle: Awaited<ReturnType<typeof open>>, max: number) {
  const data = Buffer.allocUnsafe(max + 1);
  let size = 0;
  while (size < data.length) { const { bytesRead } = await handle.read(data, size, data.length - size, size); if (!bytesRead) break; size += bytesRead; }
  if (size > max) throw new Error(`OpenAPI document exceeds maxFileBytes (${max}) while being read.`);
  return Buffer.from(data.subarray(0, size));
}
async function checked(path: string, root: string, directory: boolean) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('OpenAPI source path changed or is not a regular file.');
  const canonical = await realpath(path);
  contained(root, canonical, path);
  const after = await lstat(path);
  if (!same(info, after)) throw new Error('OpenAPI source path changed during analysis.');
  return info;
}
function contained(root: string, path: string, label: string) { const rel = relative(root, path); if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`OpenAPI source '${label}' escapes workspace root.`); }
function same(a: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number }, b: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number }) { return a.dev === b.dev && a.ino === b.ino && Number(a.size) === Number(b.size) && a.mtimeMs === b.mtimeMs; }
function sameEntry(a: Entry, b: Entry | undefined) { return !!b && a.path === b.path && a.size === b.size && a.ino === b.ino && a.mtimeMs === b.mtimeMs; }
function isDefaultSpec(path: string) { const base = path.split('/').at(-1)!.toLowerCase(); return ['openapi.json', 'openapi.yaml', 'openapi.yml'].includes(base) || /\.openapi\.(json|ya?ml)$/.test(base); }
function revision(config: OpenApiConfig, files: OpenApiSourceFile[]) { const hash = createHash('sha256'); const frame = (value: string | Buffer) => { const data = typeof value === 'string' ? Buffer.from(value, 'utf8') : value; const length = Buffer.alloc(4); length.writeUInt32BE(data.length); hash.update(length).update(data); }; frame('openapi-source-v1'); frame(JSON.stringify(config)); for (const file of files) { frame(file.path); frame(String(file.size)); frame(file.hash); } return `openapi-source-v1:${hash.digest('hex')}`; }
function lexical(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
