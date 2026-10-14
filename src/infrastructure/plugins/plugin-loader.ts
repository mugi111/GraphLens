import { pathToFileURL } from 'node:url';
import type { Analyzer } from '../../domain/analyzer.js';
import type { GraphLensPluginManifest, LoadedPlugin } from '../../domain/plugin.js';
import { validateDescriptor } from '../../application/analyzer-registry.js';
import { validateInstalledPackage } from './package-validator.js';
import type { AnalyzerRegistry } from '../../application/analyzer-registry.js';
import type { GraphStore } from '../sqlite/graph-store.js';
import { pluginInstallPrefix } from './package-paths.js';

/** Loads a trusted in-process analyzer factory after package and realpath validation. */
export async function loadInstalledPlugin(prefix: string, expectedName?: string, expectedVersion?: string, expectedLockHash?: string, expectedManifest?: GraphLensPluginManifest): Promise<LoadedPlugin> {
  const installed = await validateInstalledPackage(prefix, expectedName, expectedVersion, expectedLockHash);
  if (expectedManifest && !manifestEqual(installed.manifest, expectedManifest)) throw new Error(`Installed package metadata for plugin '${installed.manifest.id}' differs from its saved registration.`);
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
    const registeredIds: string[] = [];
    try {
      const expectedPrefix = pluginInstallPrefix(pluginStorePath, saved.id);
      if (saved.packagePath !== expectedPrefix || !saved.lockHash || !saved.installationId) throw new Error('INVALID_SAVED_INSTALLATION');
      const manifestIds = saved.analyzers.map((analyzer) => analyzer.id).sort();
      if (JSON.stringify(manifestIds) !== JSON.stringify([...saved.analyzerIds].sort())) throw new Error('SAVED_ANALYZER_IDS_MISMATCH');
      const loaded = await loadInstalledPlugin(expectedPrefix, saved.packageName, saved.version, saved.lockHash, saved);
      if (loaded.manifest.id !== saved.id || loaded.manifest.version !== saved.version || loaded.manifest.apiVersion !== saved.apiVersion || loaded.manifest.entry !== saved.entry || loaded.manifest.export !== saved.export || !descriptorsEqual(loaded.manifest.analyzers, saved.analyzers)) throw new Error('MANIFEST_MISMATCH');
      const actualIds = loaded.analyzers.map((analyzer) => analyzer.descriptor.id).sort();
      if (JSON.stringify(actualIds) !== JSON.stringify([...saved.analyzerIds].sort())) throw new Error('ANALYZER_IDS_MISMATCH');
      registry.assertCanRegister(loaded.analyzers);
      for (const analyzer of loaded.analyzers) {
        registry.register(analyzer);
        registeredIds.push(analyzer.descriptor.id);
      }
    } catch {
      try { store.disablePlugin(saved.id, 'PLUGIN_LOAD_FAILED'); }
      catch { process.stderr.write('GraphLens: a failed plugin could not be disabled in storage.\n'); }
      for (const id of registeredIds) registry.unregister(id);
      process.stderr.write('GraphLens: an enabled plugin failed startup validation and was disabled.\n');
    }
  }
}

function descriptorsEqual(left: import('../../domain/analyzer.js').AnalyzerDescriptor[], right: import('../../domain/analyzer.js').AnalyzerDescriptor[]) {
  const normalize = (items: import('../../domain/analyzer.js').AnalyzerDescriptor[]) => items.map((item) => ({ id: item.id, version: item.version, apiVersion: item.apiVersion, capabilities: [...item.capabilities].sort() })).sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function manifestEqual(left: GraphLensPluginManifest, right: GraphLensPluginManifest) {
  return left.id === right.id && left.version === right.version && left.apiVersion === right.apiVersion && left.entry === right.entry && left.export === right.export && descriptorsEqual(left.analyzers, right.analyzers);
}
