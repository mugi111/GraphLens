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
