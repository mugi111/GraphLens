import { pathToFileURL } from 'node:url';
import type { Analyzer } from '../../domain/analyzer.js';
import type { LoadedPlugin } from '../../domain/plugin.js';
import { validateDescriptor } from '../../application/analyzer-registry.js';
import { validateInstalledPackage } from './package-validator.js';
import type { AnalyzerRegistry } from '../../application/analyzer-registry.js';
import type { GraphStore } from '../sqlite/graph-store.js';
import { pluginInstallPrefix } from './package-paths.js';

/** Loads a trusted in-process analyzer factory after package and realpath validation. */
export async function loadInstalledPlugin(prefix: string, expectedName?: string, expectedVersion?: string, expectedLockHash?: string): Promise<LoadedPlugin> {
  const installed = await validateInstalledPackage(prefix, expectedName, expectedVersion, expectedLockHash);
  const module = await import(pathToFileURL(installed.entryPath).href) as Record<string, unknown>;
  const factoryName = installed.manifest.export ?? 'createAnalyzer';
  const factory = module[factoryName];
  if (typeof factory !== 'function') throw new Error(`Plugin '${installed.manifest.id}' must export ${factoryName}().`);
  const created = await (factory as () => unknown)();
  const analyzers = Array.isArray(created) ? created : [created];
  if (analyzers.length === 0 || analyzers.some((value) => !value || typeof value !== 'object' || typeof (value as Analyzer).analyze !== 'function')) {
    throw new Error(`Plugin '${installed.manifest.id}' factory must return one or more analyzers.`);
  }
  const ids = new Set<string>();
  for (const analyzer of analyzers as Analyzer[]) {
    validateDescriptor(analyzer.descriptor);
    if (ids.has(analyzer.descriptor.id)) throw new Error(`Plugin '${installed.manifest.id}' returned duplicate analyzer '${analyzer.descriptor.id}'.`);
    ids.add(analyzer.descriptor.id);
  }
  if (!descriptorsEqual(installed.manifest.analyzers, (analyzers as Analyzer[]).map((a) => a.descriptor))) throw new Error(`Plugin '${installed.manifest.id}' factory descriptors do not match its package manifest.`);
  return { manifest: installed.manifest, analyzers: analyzers as Analyzer[] };
}

/** Startup loader: only packages already marked enabled in the selected database are loaded. */
export async function loadEnabledPlugins(pluginStorePath: string, store: GraphStore, registry: AnalyzerRegistry): Promise<void> {
  for (const saved of store.enabledPlugins()) {
    const expectedPrefix = pluginInstallPrefix(pluginStorePath, saved.id);
    if (saved.packagePath !== expectedPrefix) throw new Error(`Plugin '${saved.id}' has an invalid isolated package path.`);
    const loaded = await loadInstalledPlugin(expectedPrefix, saved.packageName, saved.version, saved.lockHash);
    if (loaded.manifest.id !== saved.id || loaded.manifest.version !== saved.version || loaded.manifest.apiVersion !== saved.apiVersion || loaded.manifest.entry !== saved.entry || loaded.manifest.export !== saved.export || !descriptorsEqual(loaded.manifest.analyzers, saved.analyzers)) throw new Error(`Installed package metadata for plugin '${saved.id}' differs from the saved registration.`);
    const actualIds = loaded.analyzers.map((analyzer) => analyzer.descriptor.id).sort();
    if (JSON.stringify(actualIds) !== JSON.stringify([...saved.analyzerIds].sort())) throw new Error(`Analyzer exports for plugin '${saved.id}' differ from the saved registration.`);
    registry.assertCanRegister(loaded.analyzers);
    for (const analyzer of loaded.analyzers) registry.register(analyzer);
  }
}

function descriptorsEqual(left: import('../../domain/analyzer.js').AnalyzerDescriptor[], right: import('../../domain/analyzer.js').AnalyzerDescriptor[]) {
  const normalize = (items: import('../../domain/analyzer.js').AnalyzerDescriptor[]) => items.map((item) => ({ id: item.id, version: item.version, apiVersion: item.apiVersion, capabilities: [...item.capabilities].sort() })).sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
