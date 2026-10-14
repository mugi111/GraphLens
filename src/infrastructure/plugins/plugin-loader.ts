import { pathToFileURL } from 'node:url';
import type { Analyzer } from '../../domain/analyzer.js';
import type { LoadedPlugin } from '../../domain/plugin.js';
import { validateDescriptor } from '../../application/analyzer-registry.js';
import { validateInstalledPackage } from './package-validator.js';
import type { AnalyzerRegistry } from '../../application/analyzer-registry.js';
import type { GraphStore } from '../sqlite/graph-store.js';
import { pluginInstallPrefix } from './package-paths.js';

/** Loads a trusted in-process analyzer factory after package and realpath validation. */
export async function loadInstalledPlugin(prefix: string, expectedName?: string, expectedVersion?: string): Promise<LoadedPlugin> {
  const installed = await validateInstalledPackage(prefix, expectedName, expectedVersion);
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
  return { manifest: installed.manifest, analyzers: analyzers as Analyzer[] };
}

/** Startup loader: only packages already marked enabled in the selected database are loaded. */
export async function loadEnabledPlugins(pluginStorePath: string, store: GraphStore, registry: AnalyzerRegistry): Promise<void> {
  for (const saved of store.enabledPlugins()) {
    const expectedPrefix = pluginInstallPrefix(pluginStorePath, saved.id);
    if (saved.packagePath !== expectedPrefix) throw new Error(`Plugin '${saved.id}' has an invalid isolated package path.`);
    const loaded = await loadInstalledPlugin(expectedPrefix, saved.packageName, saved.version);
    if (loaded.manifest.id !== saved.id || loaded.manifest.apiVersion !== saved.apiVersion || JSON.stringify(loaded.manifest) !== JSON.stringify({ id: saved.id, version: saved.version, apiVersion: saved.apiVersion, entry: saved.entry, export: saved.export })) {
      throw new Error(`Installed package metadata for plugin '${saved.id}' differs from the saved registration.`);
    }
    const actualIds = loaded.analyzers.map((analyzer) => analyzer.descriptor.id).sort();
    if (JSON.stringify(actualIds) !== JSON.stringify([...saved.analyzerIds].sort())) throw new Error(`Analyzer exports for plugin '${saved.id}' differ from the saved registration.`);
    for (const analyzer of loaded.analyzers) registry.register(analyzer);
  }
}
