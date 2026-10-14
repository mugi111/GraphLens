import { lstat, readdir, realpath, stat, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { PythonSourceConfig, PythonSourceFile } from './python-source-types.js';
import { DEFAULT_PYTHON_SOURCE_CONFIG, PYTHON_SOURCE_LIMITS } from './python-source-types.js';
import { decodePythonSource, sha256 } from './python-source-content.js';

const FIXED_EXCLUDES = new Set(['.git', '.hg', '.svn', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.venv', 'venv', 'node_modules', 'build', 'dist']);
type InventoryEntry = { path: string; absolute: string; size: number; mtimeMs: number; ino: number };

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
  const root = resolve(rootInput);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(root) !== root) throw new Error('Workspace root must be a real directory, not a symlink.');
  const files: InventoryEntry[] = [];
  const canonical = new Set<string>();
  const patterns = config.excludes.map(globRegex);
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.normalize('NFC').localeCompare(b.name.normalize('NFC'), 'en'));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || FIXED_EXCLUDES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split(sep).join('/').normalize('NFC');
      if (patterns.some((pattern) => pattern.test(rel))) continue;
      if (entry.isDirectory()) { await visit(absolute); continue; }
      if (!entry.isFile() || !(entry.name.endsWith('.py') || config.includeStubs && entry.name.endsWith('.pyi'))) continue;
      if (canonical.has(rel)) throw new Error(`Python source paths collide after NFC normalization: '${rel}'.`);
      canonical.add(rel);
      const info = await stat(absolute);
      files.push({ path: rel, absolute, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino });
      if (files.length > config.maxFiles) throw new Error(`Python source file count exceeds maxFiles (${config.maxFiles}).`);
    }
  }
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
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
      const before = await stat(item.absolute);
      if (!before.isFile() || before.size > config.maxFileBytes) throw new Error(`Python source '${item.path}' changed during analysis.`);
      const bytes = await readFile(item.absolute);
      const after = await stat(item.absolute);
      stable = sameStat(before, after) && bytes.length === after.size && after.size === item.size && after.mtimeMs === item.mtimeMs && after.ino === item.ino;
      if (stable) {
        const source = decodePythonSource(bytes, item.path);
        files.push({ path: item.path, bytes, source, hash: sha256(bytes) });
      }
    }
    if (!stable) throw new Error(`Python source '${item.path}' changed while being read.`);
  }
  const finalInventory = await inventoryPythonSources(root, config);
  if (initial.length !== finalInventory.length || initial.some((file, i) => !sameInventory(file, finalInventory[i]))) throw new Error('Python source inventory changed during analysis.');
  return files;
}

function sameStat(a: Awaited<ReturnType<typeof stat>>, b: Awaited<ReturnType<typeof stat>>) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs; }
function sameInventory(a: InventoryEntry, b: InventoryEntry | undefined) { return !!b && a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino; }
function globRegex(pattern: string) { const escaped = pattern.split('*').map((s) => s.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*'); return new RegExp(`^${escaped}$`); }
