import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { GraphLensPluginManifest } from '../../domain/plugin.js';
import { PLUGIN_API_VERSION } from '../../domain/plugin.js';
import { validateDescriptor } from '../../application/analyzer-registry.js';
import { BUILTIN_ANALYZER_IDS } from '../../domain/analyzer.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ValidatedPackage = {
  packageRoot: string;
  entryPath: string;
  packageName: string;
  manifest: GraphLensPluginManifest;
  lockHash: string;
};

/** Validates package identity and canonical paths before any plugin module is imported. */
export async function validateInstalledPackage(prefix: string, expectedName?: string, expectedVersion?: string, expectedLockHash?: string): Promise<ValidatedPackage> {
  const packageFile = resolve(prefix, 'node_modules', ...(expectedName ?? '').split('/'), 'package.json');
  const canonicalPrefix = await realpath(prefix);
  const canonicalModules = await realpath(resolve(prefix, 'node_modules'));
  const packageRoot = await realpath(resolve(packageFile, '..'));
  const canonicalPackageFile = await realpath(packageFile);
  const isWithin = (root: string, candidate: string) => { const rel = relative(root, candidate); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
  if (!isWithin(canonicalPrefix, canonicalModules) || !isWithin(canonicalModules, packageRoot) || !isWithin(packageRoot, canonicalPackageFile)) throw new Error('Installed package resolves outside its isolated npm prefix.');
  const raw = JSON.parse(await readFile(canonicalPackageFile, 'utf8')) as Record<string, unknown>;
  if (typeof raw.name !== 'string' || typeof raw.version !== 'string' || (expectedName && raw.name !== expectedName) || (expectedVersion && raw.version !== expectedVersion)) {
    throw new Error('Installed package name or exact version does not match the requested package.');
  }
  const graphlens = raw.graphlens;
  if (!graphlens || typeof graphlens !== 'object' || Array.isArray(graphlens)) throw new Error('Package is missing its GraphLens plugin manifest.');
  const candidate = graphlens as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || !IDENTIFIER.test(candidate.id) || typeof candidate.apiVersion !== 'string' || candidate.apiVersion !== PLUGIN_API_VERSION || typeof candidate.entry !== 'string' || !candidate.entry.trim() || (candidate.export !== undefined && typeof candidate.export !== 'string') || !Array.isArray(candidate.analyzers) || candidate.analyzers.length === 0) {
    throw new Error(`Plugin manifest for '${raw.name}' is invalid or incompatible.`);
  }
  const analyzerIds = new Set<string>();
  for (const descriptor of candidate.analyzers) {
    validateDescriptor(descriptor as any);
    if ((BUILTIN_ANALYZER_IDS as readonly string[]).includes(descriptor.id)) throw new Error(`Plugin manifest cannot claim built-in analyzer id '${descriptor.id}'.`);
    if (analyzerIds.has(descriptor.id)) throw new Error(`Plugin manifest for '${raw.name}' contains duplicate analyzer '${descriptor.id}'.`);
    analyzerIds.add(descriptor.id);
  }
  if (candidate.entry.includes('\\') || isAbsolute(candidate.entry)) throw new Error('Plugin entry must be a relative package path.');
  const entryPath = resolve(packageRoot, candidate.entry);
  const canonicalEntry = await realpath(entryPath);
  const rel = relative(packageRoot, canonicalEntry);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Plugin entry resolves outside the installed package.');
  if (!(await stat(canonicalEntry)).isFile()) throw new Error('Plugin entry must be a file.');
  const lockPath = resolve(prefix, 'package-lock.json');
  const canonicalLockPath = await realpath(lockPath);
  if (!isWithin(canonicalPrefix, canonicalLockPath)) throw new Error('Plugin package lockfile resolves outside its isolated npm prefix.');
  const lock = JSON.parse(await readFile(canonicalLockPath, 'utf8')) as { packages?: Record<string, { name?: string; version?: string; integrity?: string; dependencies?: Record<string, string> }>; dependencies?: Record<string, { version?: string; integrity?: string }> };
  const rootLock = lock.packages?.[''];
  const packageKey = `node_modules/${raw.name}`;
  const lockedPackage = lock.packages?.[packageKey] ?? lock.dependencies?.[raw.name];
  const declaredVersion = rootLock?.dependencies?.[raw.name];
  if (!lockedPackage || lockedPackage.version !== raw.version || typeof lockedPackage.integrity !== 'string' || !declaredVersion || declaredVersion !== raw.version) throw new Error('Plugin package lockfile does not pin the expected package identity and exact version.');
  const lockHash = createHash('sha256').update(await readFile(canonicalLockPath)).digest('hex');
  if (expectedLockHash && lockHash !== expectedLockHash) throw new Error('Plugin package lockfile integrity does not match its saved installation hash.');
  const manifest: GraphLensPluginManifest = { id: candidate.id, version: raw.version, apiVersion: candidate.apiVersion, entry: candidate.entry, export: candidate.export as string | undefined, analyzers: candidate.analyzers as GraphLensPluginManifest['analyzers'] };
  return { packageRoot, entryPath: canonicalEntry, packageName: raw.name, manifest, lockHash };
}
