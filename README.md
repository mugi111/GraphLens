# GraphLens

GraphLens is a local-first architecture explorer for code, APIs, data models, and their relationships. It runs one loopback-only Node.js process: a Hono API, SQLite graph store, and compiled React/Cytoscape workspace view.

## Requirements

- Node.js 20.11 or newer
- A CodeGraph MCP server only when inspecting its connection capability

## Run locally

```sh
npm install
npm run build
npm start -- --workspace /path/to/repository
```

The server listens on `http://127.0.0.1:4174` and opens the browser by default. Use `--no-open` in terminals without a browser.

After publishing the package, the equivalent command is:

```sh
npx graphlens --workspace /path/to/repository
```

Pass `--workspace` repeatedly to set the initial workspace list. GraphLens stores persistent snapshots in `.graphlens/graphlens.sqlite` below the current directory.

## Sync model

Each successful sync writes a new immutable generation and switches the active generation within one SQLite transaction. A failed sync never replaces the current graph, so the browser continues to show the last successful snapshot.

`POST /api/v1/sync` starts a sync, `GET /api/v1/sync/:runId` returns its state, and the UI uses these read APIs:

- `GET /api/v1/status`
- `GET /api/v1/workspaces`
- `GET /api/v1/graph?workspace=<id>&limit=<n>`
- `GET /api/v1/nodes/:nodeId`

## Analyzer runtime

GraphLens composes built-in analyzers and previously enabled package plugins at startup. Every analyzer declares a host API version (`"1"`) and its graph, evidence, and diagnostics capabilities. Duplicate analyzer IDs and incompatible descriptors are rejected before a run is created. `GET /api/v1/analyzers` lists loaded analyzers; `GET /api/v1/plugins` lists package plugins recorded in the selected database. Plugin installation and removal commands are not exposed yet.

Plugins are exact-version npm packages stored under `.graphlens/plugins/<plugin-id>` beside the selected SQLite database. Installation is staged with `--save-exact --ignore-scripts --omit=dev --no-audit --no-fund`; it does not invoke package lifecycle scripts. Packages declare a `graphlens` object in `package.json` with `id`, `apiVersion`, a package-relative `entry` module, and the expected `analyzers` descriptors (`id`, `version`, `apiVersion`, `capabilities`). That module exports `createAnalyzer()`, which returns an analyzer or an array of analyzers matching those descriptors. GraphLens validates package identity, the exact npm lockfile and its saved hash, manifest compatibility, registry ID collisions, and canonical entry-path containment before importing the module or registering it in SQLite. A failed startup validation disables that plugin and invalidates its active graph contributions while allowing other plugins and the app to start.

**Security boundary:** package authors' analyzer code runs in-process with GraphLens permissions. This is not a sandbox. `--ignore-scripts` prevents npm lifecycle scripts, but it does not make imported plugin code safe; only install packages from sources you trust. GraphLens loads only packages already marked enabled in the selected database and never installs or updates packages automatically. Disabling/removing a plugin first clears its active graph contributions so they cannot remain visible after package removal.

The built-in `builtin.demo` analyzer provides the same clearly labelled local fixture graph used by `--demo`. Startup records every supplied workspace even before it has an active generation. CodeGraph remains unavailable as a snapshot analyzer because its verified MCP interface does not expose a documented complete export operation.

Use the additive analyzer endpoints to run and poll an analyzer:

```sh
curl http://127.0.0.1:4174/api/v1/analyzers
curl -X POST http://127.0.0.1:4174/api/v1/analysis-runs \
  -H 'content-type: application/json' \
  -d '{"workspaceId":"<workspace-id>","analyzerId":"builtin.demo"}'
curl http://127.0.0.1:4174/api/v1/analysis-runs/<run-id>
```

`POST /api/v1/analysis-runs` returns a `running` run immediately. SQLite allows one running `(workspaceId, analyzerId)` pair, including across host instances. Successful results are fully validated and persisted with the generation, evidence, diagnostics, active pointer, and terminal run status in one transaction. This includes an empty successful result, which activates an empty generation.

Failed analyzers keep the prior active generation. Their machine-readable error code, message, and diagnostics remain on the failed run. On startup, runs still marked `running` are converted to `failed` with `PROCESS_INTERRUPTED`.

## CodeGraph MCP capability

GraphLens does not infer a complete graph from CodeGraph search or traversal results. Publicly described MCP behavior alone does not establish that a full graph enumeration/export operation exists. On startup GraphLens sends the standard MCP stdio `initialize` and `tools/list` requests to the configured server, so it can distinguish a reachable MCP server from an unavailable one:

```sh
graphlens --workspace /repo \
  --codegraph-command codegraph-mcp-server \
  --codegraph-arg --profile=local
```

The command must start an MCP server that uses line-delimited JSON-RPC over stdin/stdout. GraphLens currently lists available tools for diagnostics only. It does not call a search/traversal tool and does not include a custom, undocumented `--graphlens-snapshot` protocol.

The status API and UI explicitly report complete enumeration as unsupported, even after a successful MCP connection. No partial data is claimed as complete. This is the current acceptance-criterion blocker for direct CodeGraph graph import until CodeGraph provides a documented snapshot/export API.

For UI preview only, `--demo` loads a visibly labelled three-node fixture. It is never identified as CodeGraph data:

```sh
npm start -- --workspace . --demo
```

## Package development

```sh
npm run build
npm run pack:check
```

The published package includes compiled server and web assets. `npm start` requires a preceding build when running from a checkout.
