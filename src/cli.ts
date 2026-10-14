#!/usr/bin/env node
import { serve } from '@hono/node-server';
import open from 'open';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './http/app.js';
import { GraphStore } from './infrastructure/sqlite/graph-store.js';
import { CodeGraphAdapter } from './infrastructure/codegraph/adapter.js';
import { GraphService } from './application/graph-service.js';
import { AnalyzerRegistry } from './application/analyzer-registry.js';
import { AnalyzerRunner } from './application/analyzer-runner.js';
import { demoAnalyzer } from './infrastructure/analyzers/demo-analyzer.js';
import { workspaceFor } from './infrastructure/codegraph/adapter.js';
import { resolvePluginStorePath } from './infrastructure/plugins/package-paths.js';
import { loadEnabledPlugins } from './infrastructure/plugins/plugin-loader.js';
import { parsePluginSpec } from './infrastructure/plugins/package-spec.js';
import { PluginManager } from './infrastructure/plugins/plugin-manager.js';

type ServerOptions = { command: 'server'; workspaces: string[]; codegraphCommand?: string; codegraphArgs: string[]; port: number; noOpen: boolean; demo: boolean };
type PluginCommand = { command: 'plugin-list'; json: boolean } | { command: 'plugin-add'; packageName: string; version: string } | { command: 'plugin-remove'; id: string };
export type CliCommand = ServerOptions | PluginCommand | { command: 'help'; topic?: 'plugin' };

/** Parses argv without starting the database, registry, listener, or browser. */
class CliUsageError extends Error {}

export function parseCommand(argv: string[]): CliCommand {
  if (argv[0] === 'plugin') {
    const args = argv.slice(1);
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') return { command: 'help', topic: 'plugin' };
    if (args[0] === 'list') {
      if (args.length === 2 && (args[1] === '--help' || args[1] === '-h')) return { command: 'help', topic: 'plugin' };
      if (args.length === 1) return { command: 'plugin-list', json: false };
      if (args.length === 2 && args[1] === '--json') return { command: 'plugin-list', json: true };
    }
    if (args[0] === 'add') {
      if (args.length === 1 || (args.length === 2 && (args[1] === '--help' || args[1] === '-h'))) return { command: 'help', topic: 'plugin' };
      if (args.length === 2) { const spec = parsePluginSpec(args[1]!); return { command: 'plugin-add', packageName: spec.name, version: spec.version }; }
    }
    if (args[0] === 'remove') {
      if (args.length === 1 || (args.length === 2 && (args[1] === '--help' || args[1] === '-h'))) return { command: 'help', topic: 'plugin' };
      if (args.length === 2) return { command: 'plugin-remove', id: args[1]! };
    }
    throw new CliUsageError('Usage: graphlens plugin <list [--json] | add <package>@<exact-version> | remove <plugin-id>>');
  }
  const out: ServerOptions = { command: 'server', workspaces: [], codegraphArgs: [], port: 4174, noOpen: false, demo: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    const next = () => { const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(`${v} requires a value`); return value; };
    if (v === '--workspace' || v === '-w') out.workspaces.push(resolve(next()));
    else if (v === '--codegraph-command') out.codegraphCommand = next();
    else if (v === '--codegraph-arg') out.codegraphArgs.push(next());
    else if (v === '--port') { out.port = Number(next()); if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('Port must be between 1 and 65535.'); }
    else if (v === '--no-open') out.noOpen = true;
    else if (v === '--demo') out.demo = true;
    else if (v === '--help' || v === '-h') return { command: 'help' };
    else throw new Error(`Unknown option: ${v}`);
  }
  return out;
}

function help(topic?: 'plugin') { if (topic === 'plugin') return `GraphLens plugin management\n\nUsage: graphlens plugin list [--json]\n       graphlens plugin add <package>@<exact-version>\n       graphlens plugin remove <plugin-id>\n`; return `GraphLens\n\nUsage: graphlens --workspace <path> [options]\n       graphlens plugin <list | add <package>@<exact-version> | remove <plugin-id>>\n\nOptions:\n  -w, --workspace <path>       Repeat for each workspace\n  --codegraph-command <command> Command that starts the CodeGraph MCP stdio server\n  --codegraph-arg <arg>         Repeatable MCP server argument\n  --demo                         Load a clearly labelled local fixture graph\n  --port <port>                  Loopback port (default: 4174)\n  --no-open                      Do not open the browser\n`; }

async function removePlugin(manager: PluginManager, id: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error('Plugin id is invalid.');
  if (!await manager.remove(id)) throw new Error(`Plugin '${id}' is not installed.`);
  console.log(`Removed plugin '${id}'.`);
}

async function addPlugin(manager: PluginManager, packageName: string, version: string): Promise<void> {
  const installed = await manager.install(packageName, version);
  console.log(`Installed ${installed.id}@${installed.version} (${installed.analyzerIds.join(', ')}).`);
}

function listPlugins(store: GraphStore, json: boolean): void {
  const plugins = store.pluginInventory();
  if (json) { console.log(JSON.stringify({ plugins }, null, 2)); return; }
  if (plugins.length === 0) { console.log('No plugins installed.'); return; }
  for (const plugin of plugins) console.log(`${plugin.enabled ? 'enabled' : 'disabled'}\t${plugin.id}\t${plugin.version}\t${plugin.analyzers.join(', ') || '(no analyzers)'}`);
}

async function runPlugin(command: PluginCommand): Promise<void> {
  const databaseFile = resolve(process.cwd(), '.graphlens/graphlens.sqlite');
  const store = new GraphStore(databaseFile, { recoverInterruptedRuns: false });
  try {
    const plugins = resolvePluginStorePath(databaseFile);
    if (command.command === 'plugin-list') return listPlugins(store, command.json);
    const registry = new AnalyzerRegistry();
    if (command.command === 'plugin-add') registry.register(demoAnalyzer);
    const manager = new PluginManager(plugins, store, registry);
    if (command.command === 'plugin-add') return addPlugin(manager, command.packageName, command.version);
    await removePlugin(manager, command.id);
  } finally { store.close(); }
}

async function runServer(options: ServerOptions) {
  const base = process.cwd();
  const databaseFile = resolve(base, '.graphlens/graphlens.sqlite');
  const store = new GraphStore(databaseFile);
  const adapter = new CodeGraphAdapter({ command: options.codegraphCommand, args: options.codegraphArgs });
  const graph = new GraphService(store, adapter);
  const registry = new AnalyzerRegistry();
  registry.register(demoAnalyzer);
  await loadEnabledPlugins(resolvePluginStorePath(databaseFile), store, registry);
  const analyzerRunner = new AnalyzerRunner(store, registry);
  store.ensureWorkspaces(options.workspaces.map((path) => workspaceFor(path)));
  if (options.demo && options.workspaces.length) await graph.sync(options.workspaces, true);
  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = resolve(here, 'web');
  if (!existsSync(webRoot)) throw new Error('Web assets missing. Install from the published package or run npm run build.');
  const url = `http://127.0.0.1:${options.port}`;
  const server = serve({ fetch: createApp(store, adapter, graph, analyzerRunner, options.workspaces, webRoot).fetch, hostname: '127.0.0.1', port: options.port });
  console.log(`GraphLens listening on ${url}`);
  if (!options.noOpen) await open(url);
  const shutdown = () => { server.close(() => store.close()); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

async function main() {
  let command: CliCommand;
  try { command = parseCommand(process.argv.slice(2)); }
  catch (error) { throw error instanceof CliUsageError ? error : new CliUsageError(error instanceof Error ? error.message : String(error)); }
  if (command.command === 'help') { console.log(help(command.topic)); return; }
  if (command.command === 'plugin-add') console.error('Warning: installed plugin code runs with GraphLens permissions. Only install packages you trust.');
  if (command.command !== 'server') return runPlugin(command);
  return runServer(command);
}
main().catch((error) => { console.error(`GraphLens: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = error instanceof CliUsageError ? 2 : 1; });
