import { pathToFileURL } from 'node:url';
import type { Analyzer } from '../../domain/analyzer.js';
import type { LoadedPlugin } from '../../domain/plugin.js';
import { validateDescriptor } from '../../application/analyzer-registry.js';
import { validateInstalledPackage } from './package-validator.js';

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
