import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { AnalyzerRegistry } from '../../application/analyzer-registry.js';
import type { GraphStore } from '../sqlite/graph-store.js';
import { commitStagedPackage, cleanupStagedPackage, stageNpmPackage } from './npm-installer.js';
import { loadInstalledPlugin } from './plugin-loader.js';
import { validateInstalledPackage } from './package-validator.js';
import { removePlugin } from './plugin-lifecycle.js';

/** Installs exact npm packages with validation and DB/registry activation as one lifecycle operation. */
export class PluginManager {
  constructor(private readonly pluginStorePath: string, private readonly store: GraphStore, private readonly registry: AnalyzerRegistry) {}

  async remove(pluginId: string): Promise<boolean> {
    return removePlugin(pluginId, this.store, this.registry, this.pluginStorePath);
  }

  async install(packageName: string, version: string) {
    const staged = await stageNpmPackage(this.pluginStorePath, packageName, version);
    let installedPrefix: string | undefined;
    const registeredIds: string[] = [];
    try {
      const validated = await validateInstalledPackage(staged.prefix, packageName, version);
      const existing = this.store.enabledPlugins(true).find((plugin) => plugin.id === validated.manifest.id);
      if (existing?.enabled) throw new Error(`Plugin '${validated.manifest.id}' is already enabled.`);
      if (existing && existing.packageName !== packageName) throw new Error(`Plugin '${validated.manifest.id}' is already owned by package '${existing.packageName}'.`);

      const loaded = await loadInstalledPlugin(staged.prefix, packageName, version, validated.lockHash);
      if (JSON.stringify(loaded.manifest) !== JSON.stringify(validated.manifest)) throw new Error('Plugin manifest changed during validation.');
      this.registry.assertCanRegister(loaded.analyzers);
      for (const analyzer of loaded.analyzers) {
        const owner = this.store.pluginAnalyzerOwner(analyzer.descriptor.id);
        if (owner && owner !== loaded.manifest.id) throw new Error(`Analyzer '${analyzer.descriptor.id}' is reserved by plugin '${owner}'.`);
      }
      const analyzerIds = loaded.analyzers.map((analyzer) => analyzer.descriptor.id);
      const installationId = randomUUID();

      installedPrefix = await commitStagedPackage(staged, loaded.manifest.id);
      this.store.registerPlugin(loaded.manifest, packageName, installedPrefix, analyzerIds, validated.lockHash, installationId, () => {
        for (const analyzer of loaded.analyzers) {
          this.registry.register(analyzer);
          registeredIds.push(analyzer.descriptor.id);
        }
      });
      return { ...loaded.manifest, enabled: true, analyzerIds, installationId };
    } catch (error) {
      for (const id of registeredIds) this.registry.unregister(id);
      if (installedPrefix) await rm(installedPrefix, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      await cleanupStagedPackage(staged).catch(() => undefined);
    }
  }
}
