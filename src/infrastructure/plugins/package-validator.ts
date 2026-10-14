import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { GraphLensPluginManifest } from '../../domain/plugin.js';
import { PLUGIN_API_VERSION } from '../../domain/plugin.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ValidatedPackage = {
  packageRoot: string;
  entryPath: string;
  packageName: string;
  manifest: GraphLensPluginManifest;
};

/** Validates package identity and canonical paths before any plugin module is imported. */
export async function validateInstalledPackage(prefix: string, expectedName?: string, expectedVersion?: string): Promise<ValidatedPackage> {
  const packageFile = resolve(prefix, 'node_modules', ...(expectedName ?? '').split('/'), 'package.json');
  const canonicalPrefix = await realpath(prefix);
  const canonicalModules = await realpath(resolve(prefix, 'node_modules'));
  const packageRoot = await realpath(resolve(packageFile, '..'));
  const isWithin = (root: string, candidate: string) => { const rel = relative(root, candidate); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
  if (!isWithin(canonicalPrefix, canonicalModules) || !isWithin(canonicalModules, packageRoot)) throw new Error('Installed package resolves outside its isolated npm prefix.');
  const raw = JSON.parse(await readFile(packageFile, 'utf8')) as Record<string, unknown>;
  if (typeof raw.name !== 'string' || typeof raw.version !== 'string' || (expectedName && raw.name !== expectedName) || (expectedVersion && raw.version !== expectedVersion)) {
    throw new Error('Installed package name or exact version does not match the requested package.');
  }
  const graphlens = raw.graphlens;
  if (!graphlens || typeof graphlens !== 'object' || Array.isArray(graphlens)) throw new Error('Package is missing its GraphLens plugin manifest.');
  const candidate = graphlens as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || !IDENTIFIER.test(candidate.id) || typeof candidate.apiVersion !== 'string' || candidate.apiVersion !== PLUGIN_API_VERSION || typeof candidate.entry !== 'string' || !candidate.entry.trim() || (candidate.export !== undefined && typeof candidate.export !== 'string')) {
    throw new Error(`Plugin manifest for '${raw.name}' is invalid or incompatible.`);
  }
  if (candidate.entry.includes('\\') || isAbsolute(candidate.entry)) throw new Error('Plugin entry must be a relative package path.');
  const entryPath = resolve(packageRoot, candidate.entry);
  const canonicalEntry = await realpath(entryPath);
  const rel = relative(packageRoot, canonicalEntry);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Plugin entry resolves outside the installed package.');
  if (!(await stat(canonicalEntry)).isFile()) throw new Error('Plugin entry must be a file.');
  const manifest: GraphLensPluginManifest = { id: candidate.id, version: raw.version, apiVersion: candidate.apiVersion, entry: candidate.entry, export: candidate.export as string | undefined };
  return { packageRoot, entryPath: canonicalEntry, packageName: raw.name, manifest };
}
