import React, { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import './database-view.css';

type Workspace = { id: string; name: string; path: string };
type Evidence = { id: string; uri?: string; line?: number; type: string; level: 'DIRECT' | 'DERIVED' | 'INFERRED' };
type GraphNode = { id: string; kind: string; label: string; properties: Record<string, unknown>; evidenceCount: number; evidence?: Evidence[] };
type GraphEdge = { id: string; kind: string; sourceId: string; targetId: string; properties: Record<string, unknown>; evidenceCount: number; evidence?: Evidence[] };
type Result = { workspace: { id: string; name: string }; analysis: { generationId: number; analyzerVersion: string; completedAt: string }; query: { root: 'table' | 'model' }; page: { limit: number; rootCount: number; totalRootCount: number; nextCursor?: string }; rootIds: string[]; nodes: GraphNode[]; edges: GraphEdge[]; diagnostics?: Array<{ code?: string; message: string; uri?: string; line?: number }> };
type Selected = GraphNode | GraphEdge;
type Filters = { workspace: string; namespace: string; schema: string; table: string; model: string; includeEvidence: boolean; includeDiagnostics: boolean };
type Cursor = { current?: string; next?: string; stack: Array<string | undefined> };
const initialFilters = (): Filters => {
  const params = new URLSearchParams(location.search);
  return { workspace: safeParam(params, 'workspace', 256), namespace: safeParam(params, 'namespace', 256), schema: safeParam(params, 'schema', 255), table: safeParam(params, 'table', 255), model: safeParam(params, 'model', 512), includeEvidence: params.get('evidence') !== 'false', includeDiagnostics: params.get('diagnostics') === 'true' };
};
function safeParam(params: URLSearchParams, key: string, max: number) { const value = params.get(key) ?? ''; return value.length <= max ? value : ''; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string'; }
function validResult(value: unknown): value is Result {
  if (!record(value) || !record(value.workspace) || !text(value.workspace.id) || !text(value.workspace.name) || !record(value.analysis) || !Number.isSafeInteger(value.analysis.generationId) ||
    !record(value.query) || (value.query.root !== 'table' && value.query.root !== 'model') || !record(value.page) || !Number.isSafeInteger(value.page.limit) || !Number.isSafeInteger(value.page.rootCount) || !Number.isSafeInteger(value.page.totalRootCount) ||
    (value.page.nextCursor !== undefined && !text(value.page.nextCursor)) || !Array.isArray(value.rootIds) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return false;
  const nodes = value.nodes as unknown[], edges = value.edges as unknown[];
  return nodes.every(node => record(node) && text(node.id) && text(node.kind) && text(node.label) && record(node.properties) && Number.isSafeInteger(node.evidenceCount)) &&
    edges.every(edge => record(edge) && text(edge.id) && text(edge.kind) && text(edge.sourceId) && text(edge.targetId) && record(edge.properties) && Number.isSafeInteger(edge.evidenceCount)) &&
    (value.diagnostics === undefined || Array.isArray(value.diagnostics));
}
function writeUrl(filters: Filters, mode: 'push' | 'replace') {
  const params = new URLSearchParams(location.search);
  params.set('view', 'database');
  for (const key of ['workspace', 'namespace', 'schema', 'table', 'model', 'evidence', 'diagnostics', 'root', 'limit', 'cursor', 'include']) params.delete(key);
  if (filters.workspace) params.set('workspace', filters.workspace);
  if (filters.namespace) params.set('namespace', filters.namespace);
  if (filters.schema) params.set('schema', filters.schema);
  if (filters.table) params.set('table', filters.table);
  if (filters.model) params.set('model', filters.model);
  params.set('evidence', String(filters.includeEvidence));
  params.set('diagnostics', String(filters.includeDiagnostics));
  const url = `${location.pathname}?${params}`;
  if (mode === 'push') history.pushState({}, '', url); else history.replaceState({}, '', url);
}
function printable(value: unknown, fallback = 'Unknown') { return value === null || value === undefined || value === '' ? fallback : String(value); }
function tableName(node: GraphNode) { const schema = node.properties.schema; return `${schema ? `${String(schema)}.` : ''}${printable(node.properties.tableName, node.label)}`; }
function evidenceLocation(item?: GraphNode | GraphEdge) {
  const evidence = item?.evidence?.find(entry => entry.uri) ?? item?.evidence?.[0];
  return evidence ? { uri: evidence.uri, line: evidence.line, type: evidence.type, level: evidence.level } : undefined;
}

export function DatabaseView({ workspaces }: { workspaces: Workspace[] }) {
  const [filters, setFilters] = useState(initialFilters);
  const [draft, setDraft] = useState(initialFilters);
  const [result, setResult] = useState<Result>();
  const [selection, setSelection] = useState<Selected>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ status: number; code?: string; message: string }>();
  const [cursor, setCursor] = useState<Cursor>({ stack: [] });
  const graphElement = useRef<HTMLDivElement>(null);
  const cy = useRef<Core>();
  const requestId = useRef(0);
  const controller = useRef<AbortController>();
  const query = useMemo(() => {
    const params = new URLSearchParams({ workspace: filters.workspace, root: 'table', limit: '25' });
    if (filters.namespace) params.set('namespace', filters.namespace);
    if (filters.schema) params.set('schema', filters.schema);
    if (filters.table) params.set('table', filters.table);
    if (filters.model) params.set('model', filters.model);
    const include = [filters.includeEvidence && 'evidence', filters.includeDiagnostics && 'diagnostics'].filter(Boolean).join(',');
    if (include) params.set('include', include);
    return params;
  }, [filters]);
  const load = async (pageCursor?: string, transition: 'next' | 'previous' | 'restart' = 'restart') => {
    if (!filters.workspace) return;
    const request = ++requestId.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setLoading(true); setError(undefined);
    const params = new URLSearchParams(query); if (pageCursor) params.set('cursor', pageCursor);
    try {
      const response = await fetch(`/api/v1/database/schema?${params}`, { signal: abort.signal });
      const body: unknown = await response.json();
      if (request !== requestId.current) return;
      if (!response.ok) {
        const payload = record(body) ? body : {};
        throw { status: response.status, code: text(payload.code) ? payload.code : undefined, message: text(payload.error) ? payload.error : 'Database schema query failed.' };
      }
      if (!validResult(body)) throw { status: 500, message: 'The database schema API returned an invalid response.' };
      setResult(body); setSelection(undefined);
      setCursor(current => ({ current: pageCursor, next: body.page.nextCursor, stack: transition === 'restart' ? [] : transition === 'next' ? [...current.stack, current.current] : current.stack.slice(0, -1) }));
    } catch (failure) {
      if (request === requestId.current && !abort.signal.aborted) {
        const payload = record(failure) ? failure : {};
        setError({ status: Number.isSafeInteger(payload.status) ? Number(payload.status) : 500, code: text(payload.code) ? payload.code : undefined, message: text(payload.message) ? payload.message : 'Database schema query failed.' });
      }
    } finally { if (request === requestId.current) setLoading(false); }
  };
  useEffect(() => {
    requestId.current++; controller.current?.abort(); setResult(undefined); setSelection(undefined); setCursor({ stack: [] });
    if (filters.workspace) void load(); else setLoading(false);
    return () => { requestId.current++; controller.current?.abort(); };
  }, [query]);
  useEffect(() => { const onPop = () => { const next = initialFilters(); setFilters(next); setDraft(next); }; addEventListener('popstate', onPop); return () => removeEventListener('popstate', onPop); }, []);
  useEffect(() => { writeUrl(filters, 'replace'); }, [filters]);
  useEffect(() => () => { controller.current?.abort(); cy.current?.destroy(); }, []);

  const rootIds = new Set(result?.rootIds ?? []);
  const tables = result?.nodes.filter(node => node.kind === 'sqlalchemy_table' && rootIds.has(node.id)) ?? [];
  const contextTables = result?.nodes.filter(node => node.kind === 'sqlalchemy_table' && !rootIds.has(node.id)) ?? [];
  const allTables = [...tables, ...contextTables];
  const columnsFor = (table: GraphNode) => result?.edges.filter(edge => edge.kind === 'contains' && edge.sourceId === table.id).map(edge => result.nodes.find(node => node.id === edge.targetId)).filter((node): node is GraphNode => node?.kind === 'sqlalchemy_column') ?? [];
  const constraintsFor = (table: GraphNode) => result?.edges.filter(edge => edge.kind === 'contains' && edge.sourceId === table.id).map(edge => result.nodes.find(node => node.id === edge.targetId)).filter((node): node is GraphNode => node?.kind === 'sqlalchemy_constraint') ?? [];
  const models = result?.nodes.filter(node => node.kind === 'sqlalchemy_model') ?? [];
  const modelToCode = result?.edges.filter(edge => edge.kind === 'maps_to') ?? [];
  const relationships = result?.edges.filter(edge => edge.kind === 'relationship') ?? [];
  const foreignKeys = result?.edges.filter(edge => edge.kind === 'foreign_key') ?? [];

  useEffect(() => {
    if (!graphElement.current) return;
    cy.current?.destroy();
    if (!result) return;
    const tableNodes = result.nodes.filter(node => node.kind === 'sqlalchemy_table');
    const graphEdges = result.edges.filter(edge => edge.kind === 'foreign_key');
    const pairs = new Map<string, { sourceId: string; targetId: string; labels: string[] }>();
    for (const edge of graphEdges) {
      const sourceColumn = result.nodes.find(node => node.id === edge.sourceId && node.kind === 'sqlalchemy_column');
      const targetColumn = result.nodes.find(node => node.id === edge.targetId && node.kind === 'sqlalchemy_column');
      if (!sourceColumn || !targetColumn) continue;
      const sourceTable = tableNodes.find(table => table.properties.tableName === sourceColumn.properties.tableName && table.properties.schema === sourceColumn.properties.schema);
      const targetTable = tableNodes.find(table => table.properties.tableName === targetColumn.properties.tableName && table.properties.schema === targetColumn.properties.schema);
      if (!sourceTable || !targetTable) continue;
      const key = `${sourceTable.id}\u0000${targetTable.id}`;
      const pair = pairs.get(key) ?? { sourceId: sourceTable.id, targetId: targetTable.id, labels: [] };
      pair.labels.push(`${printable(sourceColumn.properties.columnName, sourceColumn.label)} → ${printable(targetColumn.properties.columnName, targetColumn.label)}`);
      pairs.set(key, pair);
    }
    const positions = new Map<string, { x: number; y: number }>();
    tableNodes.forEach((table, index) => positions.set(table.id, { x: 130 + (index % 3) * 280, y: 90 + Math.floor(index / 3) * 220 }));
    cy.current = cytoscape({ container: graphElement.current, elements: [
      ...tableNodes.map(table => ({ data: { id: table.id, label: `${result.rootIds.includes(table.id) ? '' : 'Related context · '}${tableName(table)}`, kind: table.kind, root: result.rootIds.includes(table.id) }, classes: result.rootIds.includes(table.id) ? '' : 'context', position: positions.get(table.id) })),
      ...[...pairs.values()].map((pair, index) => ({ data: { id: `fk-${index}-${pair.sourceId}`, source: pair.sourceId, target: pair.targetId, label: pair.labels.sort().join(', '), kind: 'foreign_key' } })),
    ], style: [
      { selector: 'node', style: { shape: 'round-rectangle', width: 190, height: 'label', padding: '12px', 'background-color': '#182a31', 'border-width': 2, 'border-color': '#57c7b7', label: 'data(label)', color: '#e9eff5', 'font-size': 12, 'text-wrap': 'wrap', 'text-max-width': 170, 'text-valign': 'center', 'text-halign': 'center' } },
      { selector: 'node.context', style: { 'background-color': '#202b35', 'border-color': '#91a2b2', 'border-style': 'dashed', color: '#d3dce6' } },
      { selector: 'node.selected', style: { 'border-width': 4, 'border-color': '#f0bd72' } },
      { selector: 'edge', style: { width: 2, 'line-color': '#83c995', 'target-arrow-color': '#83c995', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', label: 'data(label)', color: '#d5e2df', 'font-size': 9, 'text-wrap': 'wrap', 'text-max-width': 180, 'text-background-color': '#10151d', 'text-background-opacity': 1, 'text-background-padding': 2 } },
    ], layout: { name: 'preset', fit: true, padding: 40 } });
    cy.current.on('tap', 'node', event => setSelection(result.nodes.find(node => node.id === event.target.id())));
    return () => { cy.current?.destroy(); cy.current = undefined; };
  }, [result]);
  useEffect(() => {
    if (!cy.current) return;
    cy.current.nodes().removeClass('selected');
    if (selection && !('sourceId' in selection)) cy.current.$id(selection.id).addClass('selected');
  }, [selection]);

  const change = (key: keyof Filters, value: string | boolean) => {
    const next = { ...draft, [key]: value }; setDraft(next);
    if (key === 'workspace' && next.workspace !== filters.workspace) { writeUrl(next, 'push'); setFilters(next); }
  };
  const apply = () => { writeUrl(draft, 'push'); const same = JSON.stringify(filters) === JSON.stringify(draft); setFilters(draft); if (same) { setCursor({ stack: [] }); void load(); } };
  const pageNext = () => cursor.next && void load(cursor.next, 'next');
  const pagePrevious = () => cursor.stack.length && void load(cursor.stack.at(-1), 'previous');
  const selectedNode = selection && 'sourceId' in selection ? undefined : selection as GraphNode | undefined;
  const selectedConstraint = selectedNode?.kind === 'sqlalchemy_constraint' ? selectedNode : undefined;
  const relationshipNode = selectedNode?.kind === 'sqlalchemy_relationship' ? selectedNode : selection && 'sourceId' in selection && selection.kind === 'relationship' ? result?.nodes.find(node => node.id === selection.sourceId && node.kind === 'sqlalchemy_relationship') : undefined;
  const source = evidenceLocation(selection);

  return <section className="database-view" aria-labelledby="database-title">
    <div className="database-heading"><div><p className="eyebrow">SQLALCHEMY SNAPSHOT</p><h1 id="database-title">Database</h1><p className="muted">Explore tables, columns, keys, ORM mappings, and their source evidence.</p></div><p className="database-generation">{result ? `Generation ${result.analysis.generationId}` : 'Database schema'}</p></div>
    <details className="database-filter-disclosure" open><summary>Workspace and filters</summary><form className="database-filters" onSubmit={event => { event.preventDefault(); apply(); }}>
      <label>Workspace<select value={draft.workspace} onChange={event => change('workspace', event.target.value)}><option value="">Select workspace</option>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.path}</option>)}</select></label>
      <label>Database namespace<input value={draft.namespace} onChange={event => change('namespace', event.target.value)} placeholder="All namespaces" /></label>
      <label>Schema<input value={draft.schema} onChange={event => change('schema', event.target.value)} placeholder="Default schema" /></label>
      <label>Table<input value={draft.table} onChange={event => change('table', event.target.value)} placeholder="All tables" /></label>
      <label>ORM model<input value={draft.model} onChange={event => change('model', event.target.value)} placeholder="All mapped models" /></label>
      <label className="database-check"><input type="checkbox" checked={draft.includeEvidence} onChange={event => change('includeEvidence', event.target.checked)} /> Include source evidence</label>
      <label className="database-check"><input type="checkbox" checked={draft.includeDiagnostics} onChange={event => change('includeDiagnostics', event.target.checked)} /> Include diagnostics</label>
      <button type="submit" disabled={!draft.workspace || loading}>Apply filters</button>
    </form></details>
    {loading && <p className="database-message" role="status" aria-busy="true">Loading database snapshot…</p>}
    {error && <div className="database-message database-error" role="alert"><strong>{error.status === 404 && error.code === 'DATABASE_ANALYSIS_NOT_FOUND' ? 'No active SQLAlchemy snapshot' : error.status === 409 ? 'Snapshot changed' : error.status === 422 ? 'Query is too large' : 'Could not load database schema'}</strong><p>{error.message}</p>{error.status === 404 && error.code === 'DATABASE_ANALYSIS_NOT_FOUND' && <p>Run the SQLAlchemy analyzer for this workspace, then refresh the snapshot.</p>}{error.status === 409 && <button onClick={() => { setCursor({ stack: [] }); void load(undefined, 'restart'); }}>Restart paging</button>}</div>}
    {!draft.workspace && <p className="database-message" role="status">Select a saved workspace to browse its database snapshot.</p>}
    {!loading && !error && result && tables.length === 0 && <p className="database-message" role="status">No tables match these filters. Try another schema or model, or run the SQLAlchemy analyzer.</p>}
    {result && tables.length > 0 && <>
      <div className="database-summary" aria-live="polite"><span>Showing {result.page.rootCount} of {result.page.totalRootCount} matching tables · {contextTables.length} related context table(s) · {result.edges.length} relationships</span><span>SQLAlchemy generation {result.analysis.generationId} · {result.analysis.completedAt}</span></div>
      <div className="database-layout">
        <section className="database-list-panel" aria-labelledby="database-tables-title">
          <div className="database-panel-heading"><h2 id="database-tables-title">Tables</h2><span>{result.page.rootCount} shown</span></div>
          <ul className="database-table-list">{tables.map(table => <li key={table.id}><button className="database-table-button" aria-pressed={selection?.id === table.id} onClick={() => { setSelection(table); cy.current?.$id(table.id).select(); cy.current?.center(cy.current.$id(table.id)); }}><strong>{tableName(table)}</strong><span>{columnsFor(table).length} columns · {models.filter(model => result.edges.some(edge => edge.kind === 'contains' && edge.sourceId === model.id && edge.targetId === table.id)).length} ORM models</span></button></li>)}</ul>
          {contextTables.length > 0 && <><h3 className="database-context-heading">Related context tables</h3><p className="database-context-note">These related tables are included to explain foreign-key edges; they are not part of the paged table results.</p><ul className="database-table-list">{contextTables.map(table => <li key={table.id}><button className="database-table-button context-table-button" aria-pressed={selection?.id === table.id} onClick={() => setSelection(table)}><strong>{tableName(table)}</strong><span>Related context · {columnsFor(table).length} visible columns</span></button></li>)}</ul></>}
          <div className="database-pagination"><span>Page contains {result.page.rootCount} of {result.page.totalRootCount} matching table roots</span><div><button disabled={!cursor.stack.length || loading} onClick={pagePrevious}>Previous</button><button disabled={!cursor.next || loading || !!error} onClick={pageNext}>Next</button></div></div>
        </section>
        <section className="database-diagram-panel" aria-labelledby="database-diagram-title"><div className="database-panel-heading"><h2 id="database-diagram-title">Entity relationship diagram</h2><div className="database-graph-controls"><button onClick={() => cy.current?.zoom(cy.current.zoom() * 1.2)} aria-label="Zoom in">+</button><button onClick={() => cy.current?.zoom(cy.current.zoom() / 1.2)} aria-label="Zoom out">−</button><button onClick={() => cy.current?.fit(undefined, 40)}>Fit</button></div></div><p className="database-diagram-help">Directed lines show foreign-key column pairs. Select a table or use the table and relationship lists for keyboard access.</p><div ref={graphElement} className="database-canvas" aria-hidden="true" />
          <div className="database-relations"><h3>Foreign-key relationships</h3>{foreignKeys.length ? <ul>{foreignKeys.map(edge => { const from = result.nodes.find(node => node.id === edge.sourceId), to = result.nodes.find(node => node.id === edge.targetId); return <li key={edge.id}><button className="database-relation-button" aria-pressed={selection?.id === edge.id} onClick={() => setSelection(edge)}><strong>{from ? `${printable(from.properties.tableName)}.${printable(from.properties.columnName)}` : edge.sourceId} → {to ? `${printable(to.properties.tableName)}.${printable(to.properties.columnName)}` : edge.targetId}</strong><small>{edge.properties.resolved === false ? 'Unresolved target' : 'Foreign key'}</small></button></li>; })}</ul> : <p className="muted">No resolved column-to-column foreign keys appear in this snapshot.</p>}</div>
        </section>
        <aside className="database-inspector" aria-labelledby="database-inspector-title"><h2 id="database-inspector-title">Selection details</h2>{!selection ? <p className="muted">Select a table, column, key, relationship, or ORM model to inspect it.</p> : <>
          <p className="eyebrow">{selection.kind.replaceAll('_', ' ')}</p><h3>{selection.label}</h3>
          {selectedNode?.kind === 'sqlalchemy_table' && <><p>Database table <code>{tableName(selectedNode)}</code></p><h4>Columns and keys</h4><ul className="database-columns">{columnsFor(selectedNode).map(column => <li key={column.id}><button onClick={() => setSelection(column)} aria-pressed={selection.id === column.id}><strong>{printable(column.properties.columnName, column.label)}</strong><span>{printable(column.properties.typeName)}{column.properties.nullable === false ? ' · NOT NULL' : column.properties.nullable === true ? ' · nullable' : ''}</span>{column.properties.primaryKey === true && <em>Primary key</em>}{foreignKeys.some(edge => edge.sourceId === column.id) && <em>Foreign key</em>}</button></li>)}</ul><h4>Constraints</h4>{constraintsFor(selectedNode).length ? <ul className="database-constraints">{constraintsFor(selectedNode).map(constraint => <li key={constraint.id}><button onClick={() => setSelection(constraint)} aria-pressed={selection.id === constraint.id}><strong>{printable(constraint.properties.constraintKind, constraint.label)}</strong><span>{printable(constraint.properties.name, 'Unnamed constraint')}</span></button></li>)}</ul> : <p className="muted">No table-level constraints were recorded.</p>}</>}
          {selectedNode?.kind === 'sqlalchemy_column' && <dl className="database-properties"><dt>Column</dt><dd>{printable(selectedNode.properties.columnName, selectedNode.label)}</dd><dt>Type</dt><dd>{printable(selectedNode.properties.typeName)}</dd><dt>Primary key</dt><dd>{selectedNode.properties.primaryKey === true ? 'Yes' : selectedNode.properties.primaryKey === false ? 'No' : 'Not specified'}</dd><dt>Nullable</dt><dd>{selectedNode.properties.nullable === true ? 'Yes' : selectedNode.properties.nullable === false ? 'No' : 'Not specified'}</dd></dl>}
          {selectedConstraint && <><dl className="database-properties"><dt>Constraint type</dt><dd>{printable(selectedConstraint.properties.constraintKind)}</dd><dt>Name</dt><dd>{printable(selectedConstraint.properties.name, 'Unnamed')}</dd><dt>Resolution</dt><dd>{selectedConstraint.properties.resolved === true ? 'Resolved' : selectedConstraint.properties.resolved === false ? 'Unresolved' : 'Not reported'}</dd></dl>{Array.isArray(selectedConstraint.properties.columns) && <><h4>{selectedConstraint.properties.constraintKind === 'foreign_key' ? 'Ordered column mapping' : 'Ordered columns'}</h4><ol className="composite-columns">{(selectedConstraint.properties.columns as unknown[]).map((column, index) => <li key={`${index}-${String(column)}`}><code>{String(column)}</code>{selectedConstraint.properties.constraintKind === 'foreign_key' && <span> → <code>{Array.isArray(selectedConstraint.properties.references) ? String(selectedConstraint.properties.references[index] ?? 'Unresolved') : 'Unresolved'}</code></span>}</li>)}</ol></>}</>}
          {selectedNode?.kind === 'sqlalchemy_model' && <><dl className="database-properties"><dt>Qualified model</dt><dd>{printable(selectedNode.properties.module)}.{printable(selectedNode.properties.qualifiedName, selectedNode.label)}</dd><dt>Table mapping</dt><dd>{printable(selectedNode.properties.tableName)}</dd></dl><h4>Related code</h4>{modelToCode.filter(edge => edge.targetId === selectedNode.id).map(edge => { const code = result.nodes.find(node => node.id === edge.sourceId); const location = evidenceLocation(code) ?? evidenceLocation(selectedNode); return <div className="database-code-reference" key={edge.id}><strong>{code?.label ?? 'Mapped ORM class'}</strong><p>{location?.uri ? `${location.uri}${location.line ? `:${location.line}` : ''}` : 'Source location not available'}</p>{code && <button type="button" onClick={() => setSelection(code)}>Select related code node</button>}</div>; })}</>}
          {selectedNode?.kind === 'python_class' && <><dl className="database-properties"><dt>Class</dt><dd>{printable(selectedNode.properties.qualifiedName, selectedNode.label)}</dd><dt>Module</dt><dd>{printable(selectedNode.properties.module)}</dd></dl><p className="database-code-reference">Related source class for the selected ORM model. Evidence identifies its source location.</p></>}
          {relationshipNode && <dl className="database-properties"><dt>Relationship target</dt><dd>{printable(relationshipNode.properties.target)}</dd><dt>Resolution</dt><dd>{relationshipNode.properties.resolved === true ? 'Resolved' : relationshipNode.properties.resolved === false ? 'Unresolved' : 'Not reported'}</dd><dt>Back-populates</dt><dd>{printable(relationshipNode.properties.backPopulates)}</dd></dl>}
          {'sourceId' in selection && <p className="database-edge-detail">{selection.sourceId} → {selection.targetId}</p>}
          {source && <p className="database-evidence">Evidence: {source.type} · {source.level}{source.uri ? <><br /><code>{source.uri}{source.line ? `:${source.line}` : ''}</code></> : null}</p>}
          <p className="database-evidence-count">{selection.evidenceCount} evidence item(s)</p>
        </>}</aside>
        <section className="database-models" aria-labelledby="database-models-title"><div className="database-panel-heading"><h2 id="database-models-title">ORM models</h2><span>{models.length} in this snapshot</span></div><p className="database-repository-gap">Related Repository exploration is unavailable: the current analysis graph does not contain Repository nodes or ORM-to-Repository links.</p>{models.length ? <ul className="database-model-list">{models.map(model => { const mappedTable = allTables.find(table => result.edges.some(edge => edge.kind === 'contains' && edge.sourceId === model.id && edge.targetId === table.id)); const isContextMapping = mappedTable ? !rootIds.has(mappedTable.id) : false; const code = modelToCode.find(edge => edge.targetId === model.id); const sourceNode = code && result.nodes.find(node => node.id === code.sourceId); const location = evidenceLocation(sourceNode) ?? evidenceLocation(model); return <li key={model.id}><button className="database-model-button" aria-pressed={selection?.id === model.id} onClick={() => setSelection(model)}><strong>{printable(model.properties.module)}.{printable(model.properties.qualifiedName, model.label)}</strong><span>{mappedTable ? `Table: ${tableName(mappedTable)}${isContextMapping ? ' · related context table' : ''}` : 'Table mapping unavailable'}</span><small>{sourceNode ? `${sourceNode.label} · ${location?.uri ?? 'source location unavailable'}${location?.line ? `:${location.line}` : ''}` : 'Related source class was not included in the snapshot'}</small></button></li>; })}</ul> : <p className="muted">No mapped ORM models are included in this table page.</p>}
          {relationships.length > 0 && <><h3>ORM relationships</h3><ul className="database-model-list">{relationships.map(edge => { const from = result.nodes.find(node => node.id === edge.sourceId), to = result.nodes.find(node => node.id === edge.targetId); return <li key={edge.id}><button className="database-model-button" onClick={() => setSelection(edge)}><strong>{from?.label ?? edge.sourceId} → {to?.label ?? edge.targetId}</strong><span>{edge.kind.replaceAll('_', ' ')} · {edge.properties.resolved === false ? 'unresolved' : 'resolved'}</span></button></li>; })}</ul></>}
        </section>
      </div>
      {result.diagnostics && <section className="database-diagnostics"><h2>SQLAlchemy diagnostics ({result.diagnostics.length})</h2>{result.diagnostics.length ? <ul>{result.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code ?? 'diagnostic'}-${index}`}><strong>{diagnostic.code ?? 'Diagnostic'}</strong><p>{diagnostic.message}</p>{diagnostic.uri && <code>{diagnostic.uri}{diagnostic.line ? `:${diagnostic.line}` : ''}</code>}</li>)}</ul> : <p className="muted">No diagnostics were reported for this snapshot.</p>}</section>}
    </>}
    {!workspaces.length && !draft.workspace && <p className="database-message" role="status">No saved workspaces. Add a workspace when starting GraphLens, then run the SQLAlchemy analyzer.</p>}
  </section>;
}
