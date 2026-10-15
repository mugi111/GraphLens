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

GraphLens composes built-in analyzers and previously enabled package plugins at startup. Every analyzer declares a host API version (`"1"`) and its graph, evidence, and diagnostics capabilities. Duplicate analyzer IDs and incompatible descriptors are rejected before a run is created. `GET /api/v1/analyzers` lists loaded analyzers; `GET /api/v1/plugins` lists sanitized plugin inventory recorded in the selected database. Plugin management is available through the CLI; the HTTP plugin API remains read-only.

Manage packages from the same working directory used to launch GraphLens; the CLI and server use `.graphlens/graphlens.sqlite` and `.graphlens/plugins/` there:

```sh
graphlens plugin list
graphlens plugin add @scope/package@1.2.3
graphlens plugin remove my-plugin
```

`add` accepts only an exact semantic version and a public npm package name. `list` does not load plugin code or interrupt live analysis. Plugin commands do not start the HTTP listener or browser. A successful `remove` disables the plugin and clears its active graph contributions before deleting package files. If file cleanup fails, the plugin remains disabled and its contributions stay cleared; rerun the same remove command to retry cleanup. The API endpoint `GET /api/v1/plugins` returns the same sanitized inventory as `plugin list`; no install/remove HTTP routes are exposed.

Plugins are exact-version npm packages stored under `.graphlens/plugins/<plugin-id>` beside the selected SQLite database. Installation is staged with `--save-exact --ignore-scripts --omit=dev --no-audit --no-fund`; it does not invoke package lifecycle scripts. Packages declare a `graphlens` object in `package.json` with `id`, `apiVersion`, a package-relative `entry` module, and the expected `analyzers` descriptors (`id`, `version`, `apiVersion`, `capabilities`). That module exports `createAnalyzer()`, matching the public `GraphLensPluginFactory` contract, which returns an analyzer or an array of analyzers (synchronously or asynchronously) matching those descriptors. The host plugin API version is exported as `PLUGIN_API_VERSION` (currently `"1"`). GraphLens validates package identity, the exact npm lockfile and its saved hash, manifest compatibility, registry ID collisions, and canonical entry-path containment before importing the module or registering it in SQLite. A failed startup validation disables that plugin and invalidates its active graph contributions while allowing other plugins and the app to start.

**Security boundary:** package authors' analyzer code runs in-process with GraphLens permissions. This is not a sandbox. `--ignore-scripts` prevents npm lifecycle scripts, but it does not make imported plugin code safe; only install packages from sources you trust. GraphLens loads only packages already marked enabled in the selected database and never installs or updates packages automatically. Disabling/removing a plugin first clears its active graph contributions so they cannot remain visible after package removal.

The built-in `builtin.demo` analyzer provides the same clearly labelled local fixture graph used by `--demo`. Startup records every supplied workspace even before it has an active generation. CodeGraph remains unavailable as a snapshot analyzer because its verified MCP interface does not expose a documented complete export operation.

### Python source index

`builtin.python-source` statically scans Python files below a registered workspace. It uses the bundled Lezer grammar in the Node.js process and never starts Python or imports project code. The index includes files, modules, classes, synchronous and asynchronous functions, decorators, class bases, function parameters and annotations, assignments, structured expression references, calls, containment, and import relationships. Calls retain dotted callees, keyword names, and argument literal kinds without storing source snippets. Imports are resolved only to files and declarations found in the same scan; other references appear as unresolved import nodes, while duplicate `.py` and `.pyi` candidates are marked ambiguous. Syntax recovery produces warning diagnostics and omits facts intersecting damaged syntax.

The scanner accepts `.py` and, by default, `.pyi` files. It skips VCS metadata, Python caches and virtual environments, `node_modules`, `build`, and `dist`, and never follows symlinks. Paths are normalized to NFC and sorted before indexing. Files must be valid UTF-8 (an optional BOM is accepted). A source revision is computed from the effective configuration and raw file hashes; supplying `sourceRevision` in a run request requires it to match the computed revision. A failed scan leaves the prior active generation in place.

Example request:

```sh
curl -X POST http://127.0.0.1:4174/api/v1/analysis-runs \
  -H 'content-type: application/json' \
  -d '{"workspaceId":"<workspace-id>","analyzerId":"builtin.python-source","config":{"includeStubs":true,"excludes":["generated/**"],"maxFiles":5000,"maxFileBytes":2097152,"maxTotalBytes":67108864}}'
```

The default bounds are 5,000 files, 2 MiB per file, and 64 MiB total. Configurable ceilings are 5,000 files, 10 MiB per file, and 256 MiB total. Traversal also stops with an error above 100,000 directory entries, 20,000 directories, or depth 64. The analyzer fails instead of truncating when a bound is exceeded, the workspace changes during scanning, a file cannot be decoded, or graph output exceeds 9,000 combined nodes and edges. Evidence locations include UTF-16 source offsets and one-based line and column ranges.

### SQLAlchemy analyzer

`builtin.sqlalchemy` uses the same bounded Python snapshot and parser directly; it does not require a `builtin.python-source` generation. It never imports workspace modules, starts Python, or runs SQLAlchemy. The analyzer recognizes statically declared declarative bases and local inheritance, model table names and schemas, `Mapped`/`mapped_column` and legacy `Column` declarations, primary keys, nullable/unique/index flags, literal table constraints, foreign keys, and `relationship()` declarations. It emits model, table, column, constraint, and relationship graph nodes with source evidence. Composite table constraints remain explicit constraint nodes and link to each statically identified column.

The analyzer accepts the Python scanner options (`includeStubs`, `excludes`, `maxFiles`, `maxFileBytes`, and `maxTotalBytes`) plus `databaseNamespace`, a stable 1–128 character identifier used to scope database graph identities. The namespace defaults to `default` and does not change the content-derived Python `sourceRevision`. Unknown or dynamic declaration values remain `null` or unresolved graph references with warning diagnostics; the analyzer does not guess from runtime behavior. Foreign key and relationship targets resolve only against statically indexed declarations in the workspace.

```sh
curl -X POST http://127.0.0.1:4174/api/v1/analysis-runs \
  -H 'content-type: application/json' \
  -d '{"workspaceId":"<workspace-id>","analyzerId":"builtin.sqlalchemy","config":{"databaseNamespace":"production","includeStubs":true,"excludes":["generated/**"]}}'
```

### Database schema query

`GET /api/v1/database/schema` reads the active `builtin.sqlalchemy` generation for one workspace. It does not scan source or run analysis. The `workspace` parameter is required; `root=table` is the default, and `root=model` pages mapped models instead. Optional exact filters are `namespace`, `schema`, `table`, and `model`; `model` matches a model root or a table's owning model. An omitted schema includes all schemas; `schema=` selects only unqualified tables. `limit` defaults to 25 and accepts 1–100. `include=evidence,diagnostics` opts into either or both payloads. Unknown, repeated, malformed, or incompatible parameters return `INVALID_DATABASE_QUERY`.

```sh
curl 'http://127.0.0.1:4174/api/v1/database/schema?workspace=<workspace-id>&root=table&namespace=production&schema=public&limit=25&include=evidence,diagnostics'
```

The response includes workspace identity and name (never its filesystem path), active analyzer/run/generation metadata, diagnostic counts, the page's root IDs, and a bounded graph closure. Table roots include their model owners, mapped classes, columns, constraints, relationships, and immediate foreign-key or relationship targets with compact owner context. Model roots include their class, table contents, and immediate targets. Nodes and edges always include `evidenceCount`, `level`, `analyzerId`, and `generationId`; evidence arrays are omitted unless requested. Requested diagnostics include global diagnostics and diagnostics whose source files contribute evidence to the returned closure.

Roots use deterministic ordering. `nextCursor` is opaque and bound to the workspace, query filters, and active SQLAlchemy generation; `limit` may change between pages. Reusing a cursor after the active generation changes returns `DATABASE_SNAPSHOT_CHANGED` (409). Other machine-readable errors are `WORKSPACE_REQUIRED`, `INVALID_CURSOR`, `CURSOR_QUERY_MISMATCH`, `WORKSPACE_NOT_FOUND`, `DATABASE_ANALYSIS_NOT_FOUND`, and `DATABASE_QUERY_FAILED`.

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

Analyzer results may declare the exact active generations they consumed with `inputGenerations: [{ analyzerId, generationId }]` (up to 32, with at most one generation per analyzer). Evidence may identify those inputs using the canonical string key `<analyzerId>:<generationId>`; every key must be declared by the result. The host verifies that each input is still the active successful generation for the same workspace when committing, then stores immutable dependency rows in SQLite. A stale input fails the run without activating its output. Plugin API version 1 analyzers remain compatible because the result field and `AnalysisContext.architectureInputProvider` are optional additions.

The read-only `architectureInputProvider` on analyzer context returns only requested active generations for one workspace in a single SQLite read transaction, with contributions in stable ID order. When an upstream generation changes or its plugin is disabled, GraphLens recursively removes active pointers for derived generations that consumed it; historical generations, run records, and evidence remain available. No historical dependencies are backfilled. Migration 6 adds the dependency table, index, foreign keys, and integrity trigger.

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

### FastAPI source analyzer

`builtin.fastapi` statically reads Python source with the bundled parser. It never imports or executes workspace modules and does not require a Python interpreter or FastAPI installation. It recognizes statically constructed `FastAPI` applications and `APIRouter` instances, nested `include_router` mounts, supported path-operation decorators, `api_route`, and `add_api_route`. Literal prefixes and paths are concatenated as written; dynamic values, cycles, and unresolved handlers produce diagnostics instead of guessed routes.

The graph includes API endpoint identities, route handlers, explicit and scalar-inferred parameters, request bodies, response metadata, schema references, local dependency links, and supported security schemes. Supported parameter markers are `Path`, `Query`, `Header`, `Cookie`, `Body`, `Form`, and `File`; dependencies use statically resolved `Depends` and `Security` callables. Security output is limited to public constructor metadata for OAuth2 password/authorization-code bearer, API key, HTTP bearer/basic, and OpenID Connect schemes. Callable defaults and runtime values are never evaluated or persisted. Decorators and imports must be canonically imported from FastAPI for recognition.

The analyzer accepts the Python scanner options (`includeStubs`, `excludes`, `maxFiles`, `maxFileBytes`, and `maxTotalBytes`) plus `apiNamespace` (default `default`), `maxRouterDepth` (default 8, maximum 16), `maxDependencyDepth` (default 8, maximum 16), and `maxResolvedFunctionsPerRoute` (default 500, maximum 2000). It also caps effective routes at 5000 and applies the shared graph/evidence/diagnostic limits. The source revision hashes the effective Python scan configuration and file contents.

```sh
curl -X POST http://127.0.0.1:4174/api/v1/analysis-runs \
  -H 'content-type: application/json' \
  -d '{"workspaceId":"<workspace-id>","analyzerId":"builtin.fastapi","config":{"apiNamespace":"production","maxRouterDepth":8}}'
```

### OpenAPI document analyzer

`builtin.openapi` discovers `openapi.json`, `openapi.yaml`, `openapi.yml`, and `*.openapi.json|yaml|yml` files, or reads explicit `specFiles`, and statically projects OpenAPI 3.0, 3.1, and 3.2 documents. It does not execute code, fetch URLs, or read files referenced by a document. JSON/YAML syntax and duplicate mapping keys are checked strictly; YAML aliases and custom tags are rejected. Only supported same-document component JSON Pointers are linked; unresolved or external references remain explicit with diagnostics.

The graph includes shared `api_endpoint` identities, parameters, request and response bodies, schema/property nodes, document and operation tags, servers, and security requirements/schemes. Supported configuration is `apiNamespace` (default `default`), `specFiles` (up to 64 safe relative paths), `discover` (default `true`), `maxSpecFiles` (default and maximum 64), `maxFileBytes` (default 5 MiB, maximum 10 MiB), and `maxTotalBytes` (default 20 MiB, maximum 64 MiB). Explicitly selected missing or unsupported documents fail the analysis; empty discovery succeeds. The source revision includes the normalized scan configuration and document hashes.

```sh
curl -X POST http://127.0.0.1:4174/api/v1/analysis-runs \
  -H 'content-type: application/json' \
  -d '{"workspaceId":"<workspace-id>","analyzerId":"builtin.openapi","config":{"apiNamespace":"production"}}'
```

### Architecture correlation

`builtin.architecture` reads the active FastAPI, OpenAPI, and SQLAlchemy generations from one workspace-scoped input snapshot. FastAPI or OpenAPI must be available; SQLAlchemy input is optional. A partial snapshot is retained when one or more sources have no active generation, and the analyzer reports those missing inputs as informational diagnostics.

The resolver matches endpoints by their shared `api_endpoint` identity first, then by a unique `operationId` within the same namespace. Path-shape matching is opt-in with `allowPathShapeInference: true` and emits inferred matches at confidence `0.8`. Ambiguous candidates are reported without choosing a pair. Contract findings compare only facts both analyzers can state, including parameter identity and requiredness, request-body presence/requiredness, response statuses, and a single explicit security scheme. Unknown or dynamic values are not treated as mismatches.

Handler and dependency traversal is bounded. Defaults are `maxEndpoints: 1000`, `maxTraversalDepth: 4`, `maxVisitedSymbolsPerEndpoint: 250`, and `maxTotalTraversalVisits: 50000`; maximums are 5000, 8, 1000, and 250000 respectively. The resolver projects only the relevant API closure and reachable call/reference symbols. SQLAlchemy correlation requires a reached Python class with one `maps_to` model and one model-to-table relation. It does not infer database access from names, CRUD conventions, or runtime behavior.

Architecture result revisions include the normalized resolver configuration and the sorted analyzer/generation/source-revision inputs. Re-running after an upstream generation changes invalidates dependent architecture results through the generation dependency tracking described above.
