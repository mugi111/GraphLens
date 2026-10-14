import { rm, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { AnalyzerRegistry } from '../../application/analyzer-registry.js';
import type { GraphStore } from '../sqlite/graph-store.js';
import { pluginInstallPrefix } from './package-paths.js';

/** Removal first disables the plugin and drops its active graph facts, then deletes files. */
export async function removePlugin(pluginId: string, store: GraphStore, registry: AnalyzerRegistry, pluginStorePath: string): Promise<boolean> {
  const existing = store.enabledPlugins(true).find((item) => item.id === pluginId);
  if (!existing) return false;
  const expectedPrefix = pluginInstallPrefix(pluginStorePath, pluginId);
  if (resolve(existing.packagePath) !== expectedPrefix) throw new Error('Stored plugin path is outside its isolated package directory.');
  try {
    const canonicalRoot = await realpath(resolve(pluginStorePath));
    const canonicalPrefix = await realpath(expectedPrefix);
    if (canonicalPrefix !== resolve(canonicalRoot, pluginId) || !canonicalPrefix.startsWith(`${canonicalRoot}${sep}`)) throw new Error('Plugin package path escapes the isolated package store.');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const disabled = store.disablePlugin(pluginId);
  if (!disabled) return false;
  for (const analyzerId of disabled.analyzerIds) registry.unregister(analyzerId);
  await rm(expectedPrefix, { recursive: true, force: true });
  store.forgetDisabledPlugin(pluginId);
  return true;
}
