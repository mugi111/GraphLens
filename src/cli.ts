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

type Options = { workspaces: string[]; codegraphCommand?: string; codegraphArgs: string[]; port: number; noOpen: boolean; demo: boolean };
function parse(argv: string[]): Options {
  const out: Options = { workspaces: [], codegraphArgs: [], port: 4174, noOpen: false, demo: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]; const next = () => { const value = argv[++i]; if (!value) throw new Error(`${v} requires a value`); return value; };
    if (v === '--workspace' || v === '-w') out.workspaces.push(resolve(next()));
    else if (v === '--codegraph-command') out.codegraphCommand = next();
    else if (v === '--codegraph-arg') out.codegraphArgs.push(next());
    else if (v === '--port') { out.port = Number(next()); if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('Port must be between 1 and 65535.'); }
    else if (v === '--no-open') out.noOpen = true;
    else if (v === '--demo') out.demo = true;
    else if (v === '--help' || v === '-h') { console.log(help()); process.exit(0); }
    else throw new Error(`Unknown option: ${v}`);
  }
  return out;
}
function help() { return `GraphLens\n\nUsage: graphlens --workspace <path> [options]\n\nOptions:\n  -w, --workspace <path>       Repeat for each workspace\n  --codegraph-command <command> Command that starts the CodeGraph MCP stdio server\n  --codegraph-arg <arg>         Repeatable MCP server argument\n  --demo                         Load a clearly labelled local fixture graph\n  --port <port>                  Loopback port (default: 4174)\n  --no-open                      Do not open the browser\n`; }
async function main() {
  const options = parse(process.argv.slice(2));
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
  serve({ fetch: createApp(store, adapter, graph, analyzerRunner, options.workspaces, webRoot).fetch, hostname: '127.0.0.1', port: options.port });
  console.log(`GraphLens listening on ${url}`);
  if (!options.noOpen) await open(url);
  const shutdown = () => { store.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
main().catch((error) => { console.error(`GraphLens: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
