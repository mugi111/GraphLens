import type { Analyzer } from './analyzer.js';

/** Metadata in the installed npm package's package.json. */
export type GraphLensPluginManifest = {
  id: string;
  version: string;
  apiVersion: string;
  /** Package-relative module entry. Must resolve inside the installed package. */
  entry: string;
  /** Named export containing one or more analyzer factories. */
  export?: string;
};

export type LoadedPlugin = {
  manifest: GraphLensPluginManifest;
  analyzers: Analyzer[];
};

export type PluginInventoryItem = {
  id: string;
  version: string;
  enabled: boolean;
  analyzers: string[];
  installedAt: string;
  errorCode?: string;
};

export const PLUGIN_API_VERSION = '1';
