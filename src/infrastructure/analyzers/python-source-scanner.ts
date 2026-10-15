import { constants } from 'node:fs';
import { lstat, opendir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PythonSourceConfig, PythonSourceFile } from './python-source-types.js';
import { DEFAULT_PYTHON_SOURCE_CONFIG, PYTHON_SOURCE_LIMITS } from './python-source-types.js';
import { decodePythonSource, sha256 } from './python-source-content.js';

const FIXED_EXCLUDES = new Set(['.git', '.hg', '.svn', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.venv', 'venv', 'node_modules', 'build', 'dist']);
type InventoryEntry = { path: string; absolute: string; size: number; mtimeMs: number; ino: number };
const MAX_INVENTORY_ENTRIES = 100_000;
const MAX_DIRECTORIES = 20_000;
const MAX_DIRECTORY_DEPTH = 64;

export function pythonSourceConfig(input: Record<string, unknown>): PythonSourceConfig {
  const config = { ...DEFAULT_PYTHON_SOURCE_CONFIG };
  for (const key of Object.keys(input)) if (!['includeStubs', 'excludes', 'maxFiles', 'maxFileBytes', 'maxTotalBytes'].includes(key)) throw new Error(`Unsupported Python source option '${key}'.`);
  if (input.includeStubs !== undefined) { if (typeof input.includeStubs !== 'boolean') throw new Error('includeStubs must be boolean.'); config.includeStubs = input.includeStubs; }
  if (input.excludes !== undefined) { if (!Array.isArray(input.excludes) || input.excludes.length > 256 || input.excludes.some((x) => typeof x !== 'string' || !x || x.length > 512 || x.startsWith('/') || x.includes('..') || x.includes('\\'))) throw new Error('excludes must be safe relative path patterns.'); config.excludes = [...new Set(input.excludes as string[])].sort(); }
  config.maxFiles = bounded(input.maxFiles, config.maxFiles, 1, PYTHON_SOURCE_LIMITS.maxFiles, 'maxFiles');
  config.maxFileBytes = bounded(input.maxFileBytes, config.maxFileBytes, 1, PYTHON_SOURCE_LIMITS.maxFileBytes, 'maxFileBytes');
  config.maxTotalBytes = bounded(input.maxTotalBytes, config.maxTotalBytes, 1, PYTHON_SOURCE_LIMITS.maxTotalBytes, 'maxTotalBytes');
  return config;
}

function bounded(value: unknown, fallback: number, min: number, max: number, name: string) { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`); return value as number; }

export async function inventoryPythonSources(rootInput: string, config: PythonSourceConfig): Promise<InventoryEntry[]> {
  const suppliedRoot = resolve(rootInput);
  const suppliedInfo = await lstat(suppliedRoot);
  if (suppliedInfo.isSymbolicLink() || !suppliedInfo.isDirectory()) throw new Error('Workspace root must be a real directory, not a symlink.');
  const root = await realpath(suppliedRoot);
  const files: InventoryEntry[] = [];
  const canonical = new Set<string>();
  const patterns = config.excludes.map(globRegex);
  let entryCount = 0;
  let directoryCount = 0;
  async function visit(directory: string, depth: number) {
    if (depth > MAX_DIRECTORY_DEPTH) throw new Error(`Python source directory depth exceeds ${MAX_DIRECTORY_DEPTH}.`);
    if (++directoryCount > MAX_DIRECTORIES) throw new Error(`Python source directory count exceeds ${MAX_DIRECTORIES}.`);
    const directoryIdentity = await checkedPath(directory, root, true);
    const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!sameStat(directoryIdentity, opened) || !opened.isDirectory()) throw new Error('Workspace directory changed during analysis.');
      const entries = [];
      for await (const entry of await opendir(directory)) {
        if (++entryCount > MAX_INVENTORY_ENTRIES) throw new Error(`Python source inventory exceeds ${MAX_INVENTORY_ENTRIES} directory entries.`);
        entries.push(entry);
      }
      entries.sort((a, b) => lexical(a.name.normalize('NFC'), b.name.normalize('NFC')));
      for (const entry of entries) {
        if (FIXED_EXCLUDES.has(entry.name)) continue;
        const absolute = join(directory, entry.name);
        const rel = relative(root, absolute).split(sep).join('/').normalize('NFC');
        if (patterns.some((pattern) => pattern.test(rel))) continue;
        let info: Awaited<ReturnType<typeof lstat>>;
        try { info = await lstat(absolute); } catch (error) { throw new Error(`Python source inventory changed at '${rel}': ${errorMessage(error)}`); }
        if (info.isSymbolicLink()) continue;
        const canonicalPath = await realpath(absolute);
        assertContained(root, canonicalPath, rel);
        if (info.isDirectory()) { await visit(canonicalPath, depth + 1); continue; }
        if (!info.isFile() || !(entry.name.endsWith('.py') || config.includeStubs && entry.name.endsWith('.pyi'))) continue;
        if (canonical.has(rel)) throw new Error(`Python source paths collide after NFC normalization: '${rel}'.`);
        canonical.add(rel);
        const verified = await checkedPath(absolute, root, false);
        files.push({ path: rel, absolute, size: verified.size, mtimeMs: verified.mtimeMs, ino: verified.ino });
        if (files.length > config.maxFiles) throw new Error(`Python source file count exceeds maxFiles (${config.maxFiles}).`);
      }
      const after = await lstat(directory);
      if (after.isSymbolicLink() || !sameStat(opened, after)) throw new Error('Workspace directory changed during analysis.');
    } finally { await handle.close(); }
  }
  await visit(root, 0);
  files.sort((a, b) => lexical(a.path, b.path));
  let total = 0;
  for (const file of files) { if (file.size > config.maxFileBytes) throw new Error(`Python source '${file.path}' exceeds maxFileBytes (${config.maxFileBytes}).`); total += file.size; if (total > config.maxTotalBytes) throw new Error(`Python source total exceeds maxTotalBytes (${config.maxTotalBytes}).`); }
  return files;
}

export async function readStablePythonSources(root: string, config: PythonSourceConfig): Promise<PythonSourceFile[]> {
  const initial = await inventoryPythonSources(root, config);
  const files: PythonSourceFile[] = [];
  for (const item of initial) {
    let stable = false;
    for (let attempt = 0; attempt < 2 && !stable; attempt++) {
      const pathInfo = await checkedPath(item.absolute, resolve(root), false);
      if (!sameInventory(item, { ...pathInfo, path: item.path, absolute: item.absolute })) continue;
      if (pathInfo.size > config.maxFileBytes) throw new Error(`Python source '${item.path}' changed during analysis.`);
      const handle = await open(item.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat();
        if (!sameStat(pathInfo, before) || !before.isFile() || before.size > config.maxFileBytes) continue;
        const bytes = await handle.readFile();
        const after = await handle.stat();
        const pathAfter = await checkedPath(item.absolute, resolve(root), false);
        stable = sameStat(before, after) && sameStat(after, pathAfter) && bytes.length === after.size && after.size === item.size && after.mtimeMs === item.mtimeMs && after.ino === item.ino;
        if (stable) {
          const source = decodePythonSource(bytes, item.path);
          files.push({ path: item.path, bytes, source, hash: sha256(bytes) });
        }
      } finally { await handle.close(); }
    }
    if (!stable) throw new Error(`Python source '${item.path}' changed while being read.`);
  }
  const finalInventory = await inventoryPythonSources(root, config);
  if (initial.length !== finalInventory.length || initial.some((file, i) => !sameInventory(file, finalInventory[i]))) throw new Error('Python source inventory changed during analysis.');
  return files;
}

function sameStat(a: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number }, b: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number }) { return a.dev === b.dev && a.ino === b.ino && Number(a.size) === Number(b.size) && a.mtimeMs === b.mtimeMs; }
function sameInventory(a: InventoryEntry, b: InventoryEntry | undefined) { return !!b && a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino; }
async function checkedPath(path: string, root: string, directory: boolean) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error(`Python source path changed or is not a regular ${directory ? 'directory' : 'file'}.`);
  const canonical = await realpath(path);
  assertContained(root, canonical, path);
  const after = await lstat(path);
  if (after.isSymbolicLink() || !sameStat(info, after)) throw new Error('Python source path changed during analysis.');
  return info;
}
function assertContained(root: string, path: string, label: string) { const rel = relative(root, path); if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) { if (path !== root) throw new Error(`Python source path escapes the workspace: '${label}'.`); } }
function lexical(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function globRegex(pattern: string) { const escaped = pattern.split('*').map((s) => s.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*'); return new RegExp(`^${escaped}$`); }
