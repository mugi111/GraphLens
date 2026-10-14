import { resolve, sep } from 'node:path';

const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Keeps each npm installation in a sibling directory of the selected SQLite file. */
export function resolvePluginStorePath(databaseFile: string): string {
  return resolve(databaseFile, '..', 'plugins');
}

export function pluginInstallPrefix(pluginStorePath: string, pluginId: string): string {
  if (!PLUGIN_ID.test(pluginId)) throw new Error('Plugin id is invalid for a package directory.');
  return resolve(pluginStorePath, pluginId);
}

export function isPathWithin(root: string, candidate: string): boolean {
  const relative = resolve(candidate).slice(resolve(root).length);
  return relative === '' || relative.startsWith(sep);
}
