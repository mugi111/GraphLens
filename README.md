# GraphLens

GraphLens is a local-first architecture explorer for code, APIs, data models, and their relationships. It runs one loopback-only Node.js process: a Hono API, SQLite graph store, and compiled React/Cytoscape workspace view.

## Requirements

- Node.js 20.11 or newer
- A CodeGraph MCP server only when inspecting its connection capability
- Node.js 22.5 through 24 and an existing CodeGraph 1.6.2 package installation only when importing CodeGraph snapshots

## Run GraphLens

```sh
npx graphlens --workspace /path/to/repository
```

The server listens on `http://127.0.0.1:4174` and opens the browser by default. Use `--no-open` in terminals without a browser.

Pass `--workspace` repeatedly to set the initial workspace list. GraphLens stores the database and plugins in the OS user data directory. macOS uses `~/Library/Application Support/GraphLens`, Windows uses `%LOCALAPPDATA%/GraphLens`, and Linux uses `$XDG_DATA_HOME/graphlens` or `~/.local/share/graphlens` when `XDG_DATA_HOME` is unset. Use `--data-dir <path>` on server, plugin, or query commands to select a different directory; relative paths are resolved from the current directory.

```sh
npx graphlens --workspace /path/to/repository --data-dir ./graphlens-data
```

If a legacy database exists at `.graphlens/graphlens.sqlite` in the current directory, GraphLens reports its location. It does not migrate or copy legacy data automatically. To continue using it, pass `--data-dir ./.graphlens`.

## Sync model

Each successful sync writes a new immutable generation and switches the active generation within one SQLite transaction. A failed sync never replaces the current graph, so the browser continues to show the last successful snapshot.

`POST /api/v1/sync` activates the local demo fixture, and `GET /api/v1/sync/:runId` returns its state. Source indexing uses the analyzer run API described below. The UI uses these read APIs:

- `GET /api/v1/status`
- `GET /api/v1/workspaces`
- `GET /api/v1/graph?workspace=<id>&limit=<n>`
- `GET /api/v1/nodes/:nodeId`

## Workspace graph explorer

The Workspace view browses active graph facts from one or more registered workspaces. Select roots, expand `contains` relationships, follow bounded neighbor links, or search labels with literal substring matching. The view shows only facts stored by active analyzers, including their analyzer and generation identifiers; it does not infer directory structure or identify facts as CodeGraph data.

`GET /api/v1/workspace-graph` accepts a required comma-separated `workspaces` selection (1–16 IDs) and these modes:

- `mode=roots` (default) returns nodes without an active incoming `contains` relationship.
- `mode=children&node=<id>` returns the node's outgoing `contains` relationships.
- `mode=neighbors&node=<id>&direction=<outgoing|incoming|both>` returns incident relationships.
- `mode=search&q=<text>` searches labels using literal text; optional `kind=<exact-kind>` filters roots or search results.

`limit` defaults to 25 and accepts 1–100 roots or relationships per page. A response is bounded to 250 nodes, 200 edges, 1,000 evidence records, and 1 MiB each of properties and evidence payloads; requests that exceed a bound return `WORKSPACE_GRAPH_LIMIT_EXCEEDED`. Pass the returned `cursor` and `snapshot` to continue against the same active generations; the page size may change between requests. If those generations change, GraphLens returns `WORKSPACE_GRAPH_SNAPSHOT_CHANGED` and the query must be restarted. `include=evidence` adds recorded evidence. Workspace responses include IDs and names but omit filesystem paths. Unknown, repeated, incompatible, or malformed query parameters return `INVALID_WORKSPACE_GRAPH_QUERY`; other errors include `INVALID_CURSOR`, `WORKSPACE_NOT_FOUND`, and `WORKSPACE_GRAPH_NODE_NOT_FOUND`.

## Source evidence

Evidence with a supported local file location can be opened from the Workspace, Database, Architecture, and Impact inspectors. GraphLens resolves the file from the selected evidence and active analyzer generation; requests cannot supply a filesystem path. The viewer reads at most 2 MiB and displays up to 100 numbered lines around the recorded line. It labels the result as the current working file because files may have changed since analysis. Evidence without a safe local file location remains available with its recorded details.

## Analyzer runtime

GraphLens composes built-in analyzers and previously enabled package plugins at startup. Every analyzer declares a host API version (`"1"`) and its graph, evidence, and diagnostics capabilities. Duplicate analyzer IDs and incompatible descriptors are rejected before a run is created. `GET /api/v1/analyzers` lists loaded analyzers; `GET /api/v1/plugins` lists sanitized plugin inventory recorded in the selected database. Plugin management is available through the CLI; the HTTP plugin API remains read-only.

Manage packages in the same user data directory used by the server. The database is `graphlens.db`, and plugin packages are stored in its `plugins/` subdirectory. Use the same `--data-dir` value when managing plugins and starting GraphLens:

```sh
graphlens plugin list --data-dir ./graphlens-data
graphlens plugin add @scope/package@1.2.3 --data-dir ./graphlens-data
graphlens plugin remove my-plugin --data-dir ./graphlens-data
```

`add` accepts only an exact semantic version and a public npm package name. `list` does not load plugin code or interrupt live analysis. Plugin commands do not start the HTTP listener or browser. A successful `remove` disables the plugin and clears its active graph contributions before deleting package files. If file cleanup fails, the plugin remains disabled and its contributions stay cleared; rerun the same remove command to retry cleanup. The API endpoint `GET /api/v1/plugins` returns the same sanitized inventory as `plugin list`; no install/remove HTTP routes are exposed.

Plugins are exact-version npm packages stored under `<data-dir>/plugins/<plugin-id>` beside the selected SQLite database. Installation does not invoke package lifecycle scripts. Packages declare a `graphlens` object in `package.json` with `id`, `apiVersion`, a package-relative `entry` module, and the expected `analyzers` descriptors (`id`, `version`, `apiVersion`, `capabilities`). That module exports `createAnalyzer()`, matching the public `GraphLensPluginFactory` contract, which returns an analyzer or an array of analyzers (synchronously or asynchronously) matching those descriptors. The host plugin API version is exported as `PLUGIN_API_VERSION` (currently `"1"`). GraphLens validates package identity, the exact npm lockfile and its saved hash, manifest compatibility, registry ID collisions, and canonical entry-path containment before importing the module or registering it in SQLite. A failed startup validation disables that plugin and invalidates its active graph contributions while allowing other plugins and the app to start.

**Security boundary:** package authors' analyzer code runs in-process with GraphLens permissions. This is not a sandbox. `--ignore-scripts` prevents npm lifecycle scripts, but it does not make imported plugin code safe; only install packages from sources you trust. GraphLens loads only packages already marked enabled in the selected database and never installs or updates packages automatically. Disabling/removing a plugin first clears its active graph contributions so they cannot remain visible after package removal.

The built-in `builtin.demo` analyzer provides the same clearly labelled local fixture graph used by `--demo`. Startup records every supplied workspace even before it has an active generation.

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

The **Database** view presents paged table roots as an ER diagram and table list. Selecting a table shows its columns, primary/foreign-key flags, and constraints; composite foreign keys retain their ordered column mapping. Referenced tables included only as query context are marked separately and are not counted as page roots. ORM models link to their mapped class and source evidence when those facts are present. Repository exploration is not available until the graph contains Repository nodes and ORM-to-Repository relationships.

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

## CodeGraph snapshot ingestion

GraphLens can import a complete local CodeGraph snapshot through the installed CodeGraph SDK. The SDK is not bundled or installed by GraphLens. Pass the package root for an existing `@colbymchenry/codegraph` 1.6.2 installation:

```sh
graphlens --workspace /path/to/repository \
  --codegraph-sdk /path/to/node_modules/@colbymchenry/codegraph
```

The option registers the `builtin.codegraph` snapshot analyzer; it does not start an import. Start an explicit analysis run for a registered workspace with `POST /api/v1/analysis-runs`, using `{"workspaceId":"<workspace-id>","analyzerId":"builtin.codegraph"}`. The analyzer uses CodeGraph's public `getDatabasePath`, `getCodeGraphDir`, `DatabaseConnection`, and `QueryBuilder` exports. It opens the database read-only, enforces SQLite query-only mode, and reads schema version 15 and extraction version 28 from one transaction. It rejects incomplete index states, synthesis in progress, pending references, parser initialization errors, and supported-language files with no extracted nodes. Parse errors, failed unresolved references, and warning-only skip markers are reported as diagnostics. YAML, Twig, and properties files are represented by their CodeGraph file records because these formats do not create symbol nodes.

An import fails without replacing the active GraphLens generation if the CodeGraph version or completeness checks fail, another CodeGraph writer owns the lock, or the input exceeds 10,000 rows, 9,000 graph contributions, 10,000 bytes per field, or 16 MiB of serialized analyzer output. A successful run activates the complete generation atomically. `/api/v1/status` reports the MCP connection and snapshot ingestion capability separately.

GraphLens itself continues to support Node.js 20.11 and newer. The CodeGraph SDK integration requires Node.js 22.5 through 24 because CodeGraph uses the built-in `node:sqlite` API.

## CodeGraph MCP capability

On startup, GraphLens probes the configured CodeGraph MCP server with standard MCP stdio `initialize` and `tools/list` requests, and lists its available tools for connection diagnostics:

```sh
graphlens --workspace /repo \
  --codegraph-command codegraph-mcp-server \
  --codegraph-arg --profile=local
```

The command must start an MCP server that uses line-delimited JSON-RPC over stdin/stdout. GraphLens uses the connection and tool list for diagnostics only. MCP connection status is separate from the full snapshot imported by the SDK analyzer.

For UI preview only, `--demo` loads a visibly labelled three-node fixture. It is never identified as CodeGraph data:

```sh
npx graphlens --workspace . --demo
```

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

### Frontend HTTP consumer analyzer

`builtin.frontend-http` statically scans only the explicitly selected `frontendPaths` (workspace-relative files or directories) for `.js`, `.jsx`, `.ts`, and `.tsx` source. Set both `frontendPaths` and a non-default `apiNamespace`; the namespace joins the canonical `api_endpoint` identity used by backend and OpenAPI analyzers. It recognizes direct calls to the unshadowed global `fetch` with a root-relative string literal URL and an optional static `method` string (default `GET`). It does not execute modules or resolve workspace dependencies. Dynamic URLs/options, unsupported URLs, and files where `fetch` may be shadowed produce diagnostics. Syntax errors or source changes during scanning fail the run without activating partial results. Scanning is bounded to 2000 files, 1 MiB per file, 16 MiB total, and 1000 requests.

```sh
curl -X POST http://127.0.0.1:4174/api/v1/analysis-runs \
  -H 'content-type: application/json' \
  -d '{"workspaceId":"<workspace-id>","analyzerId":"builtin.frontend-http","config":{"frontendPaths":["src"],"apiNamespace":"production"}}'
```

### Architecture correlation

`builtin.architecture` reads the active FastAPI, OpenAPI, SQLAlchemy, and frontend HTTP generations from one workspace-scoped input snapshot. At least one FastAPI, OpenAPI, or frontend HTTP generation must be available; SQLAlchemy input is optional. A partial snapshot is retained when one or more sources have no active generation, and the analyzer reports those missing inputs as informational diagnostics. Frontend request nodes and their source files are included as consumers; OpenAPI operations remain specifications.

The resolver matches endpoints by their shared `api_endpoint` identity first, then by a unique `operationId` within the same namespace. Path-shape matching is opt-in with `allowPathShapeInference: true` and emits inferred matches at confidence `0.8`. Ambiguous candidates are reported without choosing a pair. Contract findings compare only facts both analyzers can state, including parameter identity and requiredness, request-body presence/requiredness/media type, response statuses, and a single explicit security scheme. Unknown or dynamic values are not treated as mismatches.

Handler and dependency traversal is bounded. Defaults are `maxEndpoints: 1000`, `maxTraversalDepth: 4`, `maxVisitedSymbolsPerEndpoint: 250`, and `maxTotalTraversalVisits: 50000`; maximums are 5000, 8, 1000, and 250000 respectively. The resolver projects only the relevant API closure and reachable call/reference symbols. SQLAlchemy correlation requires a reached Python class with one `maps_to` model and one model-to-table relation. It does not infer database access from names, CRUD conventions, or runtime behavior.

Architecture result revisions include the normalized resolver configuration and the sorted analyzer/generation/source-revision inputs. Re-running after an upstream generation changes invalidates dependent architecture results through the generation dependency tracking described above.

`GET /api/v1/architecture?workspace=<workspace-id>` returns a bounded view of the active `builtin.architecture` generation. `root` accepts `endpoint` (default), `handler`, `model`, `table`, or `finding`; `node=<exact-id>` focuses one node from that generation. Endpoint roots accept exact `namespace`, `method`, and `path` filters. Finding roots accept `finding=gap|ambiguous|unresolved|mismatch`. Results are ordered deterministically and paged with `limit` (1–100, default 25) and the opaque `cursor` returned by the previous response. A cursor is bound to its workspace, active generation, filters, depth, and include options; a changed active generation returns 409.

`depth` controls bidirectional traversal across the explicit architecture edge allowlist (0–6, default 3). `include=evidence,diagnostics` opts into related evidence and diagnostics; nodes and edges always include `level` and `evidenceCount`. Responses are rejected with 422 rather than truncated when they exceed 2,000 nodes, 4,000 edges, 5,000 included evidence records, or 1,000 included diagnostics. Unknown or duplicate query parameters are rejected. Query filters must match their selected root; `node` focus cannot be combined with semantic filters or a cursor. Cursor/query mismatches return 400, while a changed active generation returns 409.

```sh
curl 'http://127.0.0.1:4174/api/v1/architecture?workspace=<workspace-id>&root=endpoint&method=GET&path=/users&depth=2&include=evidence,diagnostics'
```

### Cross-workspace API contract matching

GraphLens compares active `builtin.architecture` generations across 2–16 unique workspace IDs in a single read transaction. A deterministic SHA-256 snapshot ID represents the sorted workspace/generation set. Unregistered workspaces are rejected; registered workspaces without an active architecture generation are reported separately. Snapshot metadata includes workspace names and generation/input details, with graph facts, evidence, and diagnostics in ID order. Workspace filesystem paths are omitted from workspace metadata.

Contracts match only on an exact non-default namespace, uppercase HTTP method, and exact route path. FastAPI routes act as providers, OpenAPI operations as specifications, and frontend HTTP requests as consumers. A shared contract appears only when at least two workspaces contain the same key. Consumer requests link to the shared contract, which links to each provider endpoint for dependency traversal; OpenAPI operations are not treated as consumers. Duplicate FastAPI providers are retained and reported; GraphLens does not select a winner. Matching does not use `operationId`, default namespaces, or path-shape patterns. Resolver limits default to 5,000 input endpoints, 2,500 shared contracts, and 10,000 output edges, with configurable ceilings of 20,000, 10,000, and 40,000. Exceeding a configured limit returns no partial output.

### Cross-workspace architecture query

`GET /api/v1/cross-workspace/architecture` pages shared contract hubs (default) or workspace endpoints from 2–16 workspace IDs. Optional exact filters are `namespace`, uppercase `method`, and absolute `path`; `workspace` restricts roots to a selected workspace. `depth` is 0–8 (default 4), `limit` is 1–100 (default 25), and `include=evidence,diagnostics` opts into provenance and diagnostics. The opaque cursor is bound to the sorted workspace set, query filters, and current snapshot ID; `limit` can change between pages. A changed generation vector returns `CROSS_WORKSPACE_SNAPSHOT_CHANGED` (409). Too few active architecture generations return `INSUFFICIENT_ACTIVE_ARCHITECTURE_WORKSPACES` (409). Closure bounds are 3,000 nodes, 6,000 edges, 5,000 included evidence records, and 1,000 included diagnostics; excess results return 422 without truncation.

The same read-only query is available from the CLI and prints JSON:

```sh
graphlens query architecture --workspaces <workspace-id-1,workspace-id-2> --root contract --namespace payments --method GET --path /payments --depth 4 --limit 25 --include evidence,diagnostics
```

Get workspace IDs from `GET /api/v1/workspaces`. The query command opens the selected user data directory's existing `graphlens.db` in read-only mode; it does not create the database, apply migrations, start the server, or open a browser. It reports an error if the database is missing, uninitialized, or incompatible with this GraphLens version.

### Cross-workspace impact

`GET /api/v1/impact?workspaces=<id1,id2>&node=<stable-node-id>` returns the directed impact neighborhood for a stable workspace node ID or global contract ID. `direction` is `dependents`, `dependencies`, or `both` (default); `depth` is 1–8 (default 4). Inferred edges are omitted unless `includeInferred=true`. `limit` sets the node ceiling from 1–2,000 (default 500). `include=evidence,diagnostics` opts into provenance and diagnostics.

Impact traversal normalizes architecture relationships to dependent → dependency, then follows the requested direction. Contract findings are attached to the result and are not traversed. The response includes one deterministic shortest path for each reached node, its distance and impact role, plus snapshot generation metadata. A target outside the selected active architecture graph returns `IMPACT_TARGET_NOT_FOUND` (404); fewer than two selected active architecture generations returns `INSUFFICIENT_ACTIVE_ARCHITECTURE_WORKSPACES` (409). Results exceeding 2,000 nodes, 4,000 edges, 2,000 paths, 5,000 included evidence records, or 1,000 diagnostics return 422 without partial output.

The read-only CLI supports the same query:

```sh
graphlens query impact --workspaces <workspace-id-1,workspace-id-2> --node <stable-node-id> --direction dependents --depth 4 --includeInferred false --include evidence,diagnostics
```

The **Impact** view in the local UI discovers shared contracts or workspace endpoints from the selected active architecture snapshots, then lets you trace either direction. Frontend consumers appear when `builtin.frontend-http` and the corresponding backend or specification analyzer have active generations and their exact contract keys match. The graph connects each request to its source file and shared contract, then connects that contract to provider endpoints and their handler, model, and table relationships. Matching uses the frontend analyzer's configured namespace; unsupported and dynamic request forms are not mapped. Workspace groups, global contract hubs, impact roles, and evidence levels use distinct shapes, outlines, and line patterns. Each reached node has one deterministic shortest path; the path selector and keyboard-accessible node index work without graph-canvas interaction. The view records its workspace set, target filters, selected node, direction, and traversal options in the URL.
