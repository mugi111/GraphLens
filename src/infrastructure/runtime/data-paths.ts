import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const LEGACY_DATA_DIRECTORY = '.graphlens';
export const LEGACY_DATABASE_FILE = 'graphlens.sqlite';
export const DATABASE_FILE = 'graphlens.db';

export function resolveUserDataDirectory(options: {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : join(home, 'AppData', 'Local');
    return join(localAppData, 'GraphLens');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'GraphLens');
  }
  const xdgDataHome = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, '.local', 'share');
  return join(xdgDataHome, 'graphlens');
}

export function resolveDataDirectory(dataDirectory?: string, cwd = process.cwd()): string {
  return dataDirectory ? resolve(cwd, dataDirectory) : resolveUserDataDirectory();
}

export function resolveDatabaseFile(dataDirectory?: string, cwd = process.cwd()): string {
  const directory = resolveDataDirectory(dataDirectory, cwd);
  const databaseFile = join(directory, DATABASE_FILE);
  const explicitlySelectedLegacyFile = join(directory, LEGACY_DATABASE_FILE);
  return dataDirectory && !existsSync(databaseFile) && existsSync(explicitlySelectedLegacyFile)
    ? explicitlySelectedLegacyFile
    : databaseFile;
}

export function resolveLegacyDatabaseFile(cwd = process.cwd()): string {
  return join(cwd, LEGACY_DATA_DIRECTORY, LEGACY_DATABASE_FILE);
}

export function legacyDataNotice(cwd = process.cwd()): string {
  return `Legacy GraphLens data was found at ${resolveLegacyDatabaseFile(cwd)}. GraphLens now uses the OS user data directory; legacy data is not migrated or copied automatically. Select it explicitly with --data-dir ${resolve(cwd, LEGACY_DATA_DIRECTORY)} if you want to keep using it.`;
}
