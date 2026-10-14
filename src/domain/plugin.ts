import type { Analyzer, AnalyzerDescriptor } from './analyzer.js';

/** Metadata in the installed npm package's package.json. */
export type GraphLensPluginManifest = {
  id: string;
  version: string;
  apiVersion: string;
  /** Package-relative module entry. Must resolve inside the installed package. */
  entry: string;
  /** Named export containing one or more analyzer factories. */
  export?: string;
  /** Expected analyzer descriptors, compared exactly with the factory output. */
  analyzers: AnalyzerDescriptor[];
};

/** Factory contract exported by an installed package entry module. */
export type GraphLensPluginFactory = () => Analyzer | Analyzer[] | Promise<Analyzer | Analyzer[]>;

export type LoadedPlugin = {
  manifest: GraphLensPluginManifest;
  analyzers: Analyzer[];
};

export type PluginInventoryItem = {
  id: string;
  packageName: string;
  version: string;
  apiVersion: string;
  enabled: boolean;
  analyzers: string[];
  installedAt: string;
  errorCode?: string;
};

export const PLUGIN_API_VERSION = '1';
