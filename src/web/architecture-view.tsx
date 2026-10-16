import React, { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import './architecture.css';
import { ProvenanceInspector } from './provenance-inspector.js';
import { SourceStatePanel } from './source-state.js';

type Workspace = { id: string; name: string; path: string };
type Root = 'endpoint' | 'handler' | 'model' | 'table' | 'finding';
type Level = 'DIRECT' | 'DERIVED' | 'INFERRED';
type Evidence = { id: string; subjectKind: 'node' | 'edge'; subjectId: string; level: Level; type: string; uri?: string; line?: number; detail?: string; provenance?: Record<string, unknown>; inputGenerations?: string[] };
type Owner = { analyzerId: string; generationId: number };
type ItemBase = { id: string; workspaceId: string; kind: string; properties: Record<string, unknown>; evidenceCount: number; evidence?: Evidence[]; level: Level; analyzerId?: string; generationId?: number; contributors?: Owner[]; propertySources?: Record<string, Owner[]>; propertyConflicts?: Array<{ property: string; values: Array<{ value: unknown; owner: Owner }> }> };
type NodeItem = ItemBase & { label: string; sourceId?: never; targetId?: never };
type EdgeItem = ItemBase & { sourceId: string; targetId: string; label?: string };
type Item = NodeItem | EdgeItem;
type Diagnostic = { code?: string; severity: 'info' | 'warning' | 'error'; message: string; uri?: string; line?: number; detail?: Record<string, unknown> };
type InputGeneration = { analyzerId: string; generationId: number };
type Result = { workspace: { id: string; name: string }; activeSnapshotId?: string; analysis: { analyzerId: string; analyzerVersion: string; generationId: number; runId: string; sourceRevision?: string; completedAt: string; inputGenerations: InputGeneration[]; diagnostics: { total: number; info: number; warning: number; error: number } }; query: { root: Root; node?: string; namespace?: string; method?: string; path?: string; finding?: 'gap' | 'ambiguous' | 'unresolved' | 'mismatch'; depth: number }; page: { limit: number; totalRootCount: number; rootCount: number; nextCursor?: string }; rootIds: string[]; nodes: Item[]; edges: Item[]; diagnostics?: Diagnostic[] };
type Filters = { workspace: string; root: Root; namespace: string; method: string; path: string; finding: '' | 'gap' | 'ambiguous' | 'unresolved' | 'mismatch'; limit: number; depth: number; includeEvidence: boolean; includeDiagnostics: boolean };
const roots: Root[] = ['endpoint', 'handler', 'model', 'table', 'finding'];
const initial: Filters = { workspace: '', root: 'endpoint', namespace: '', method: '', path: '', finding: '', limit: 25, depth: 3, includeEvidence: true, includeDiagnostics: false };
function filtersFromUrl(): Filters {
  const p = new URLSearchParams(location.search), root = p.get('root'), finding = p.get('finding');
  const limit = Number(p.get('limit') ?? initial.limit), depth = Number(p.get('depth') ?? initial.depth);
  const workspace = p.get('workspace') ?? '';
  return { ...initial, workspace: workspace.length <= 256 ? workspace : '', root: roots.includes(root as Root) ? root as Root : initial.root,
    namespace: (p.get('namespace') ?? '').slice(0, 256), method: validMethod(p.get('method') ?? '') ? p.get('method') ?? '' : '',
    path: (p.get('path') ?? '').slice(0, 2048), finding: ['gap','ambiguous','unresolved','mismatch'].includes(finding ?? '') ? finding as Filters['finding'] : '',
    limit: Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : initial.limit,
    depth: Number.isInteger(depth) && depth >= 0 && depth <= 6 ? depth : initial.depth,
    includeEvidence: p.get('evidence') !== 'false', includeDiagnostics: p.get('diagnostics') === 'true' };
}
function validMethod(value: string): boolean { return value === '' || ['GET','HEAD','POST','PUT','DELETE','CONNECT','OPTIONS','TRACE','PATCH'].includes(value); }
function writeFilterUrl(filters: Filters, mode: 'push' | 'replace') {
  const params = new URLSearchParams(location.search);
  params.set('view', 'architecture');
  for (const key of ['workspace','root','namespace','method','path','finding','limit','depth','evidence','diagnostics']) params.delete(key);
  if (filters.workspace) params.set('workspace', filters.workspace);
  params.set('root', filters.root);
  if (filters.namespace && filters.root === 'endpoint') params.set('namespace', filters.namespace);
  if (filters.method && filters.root === 'endpoint') params.set('method', filters.method);
  if (filters.path && filters.root === 'endpoint') params.set('path', filters.path);
  if (filters.finding && filters.root === 'finding') params.set('finding', filters.finding);
  params.set('limit', String(filters.limit)); params.set('depth', String(filters.depth));
  params.set('evidence', String(filters.includeEvidence)); params.set('diagnostics', String(filters.includeDiagnostics));
  const url = `${location.pathname}?${params}`;
  if (mode === 'push') window.history.pushState({}, '', url); else window.history.replaceState({}, '', url);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isText(value: unknown): value is string { return typeof value === 'string'; }
function isCount(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function parseResult(value: unknown): Result {
  if (!isRecord(value) || !isRecord(value.workspace) || !isText(value.workspace.id) || !isText(value.workspace.name) || !isRecord(value.analysis) ||
      value.analysis.analyzerId !== 'builtin.architecture' || !isText(value.analysis.analyzerVersion) || !isCount(value.analysis.generationId) || Number(value.analysis.generationId) < 1 ||
      !isText(value.analysis.runId) || !isText(value.analysis.completedAt) || (value.analysis.sourceRevision !== undefined && !isText(value.analysis.sourceRevision)) ||
      !Array.isArray(value.analysis.inputGenerations) || !isRecord(value.analysis.diagnostics) || !['total','info','warning','error'].every(k => isCount(value.analysis.diagnostics[k])) ||
      !isRecord(value.query) || !roots.includes(value.query.root as Root) || !isCount(value.query.depth) || Number(value.query.depth) > 6 ||
      ['node','namespace','method','path','finding'].some(key => value.query![key] !== undefined && !isText(value.query![key])) ||
      (value.query.finding !== undefined && !['gap','ambiguous','unresolved','mismatch'].includes(String(value.query.finding))) ||
      !isRecord(value.page) || !isCount(value.page.limit) || Number(value.page.limit) < 1 || Number(value.page.limit) > 100 || !isCount(value.page.rootCount) || Number(value.page.rootCount) > Number(value.page.limit) || !isCount(value.page.totalRootCount) || Number(value.page.rootCount) > Number(value.page.totalRootCount) ||
      (value.page.nextCursor !== undefined && !isText(value.page.nextCursor)) || !Array.isArray(value.rootIds) || !Array.isArray(value.nodes) || !Array.isArray(value.edges) ||
      (value.diagnostics !== undefined && !Array.isArray(value.diagnostics))) throw new Error('The architecture API returned an invalid response shape.');
  const inputs = value.analysis.inputGenerations;
  if (!inputs.every(x => isRecord(x) && isText(x.analyzerId) && isCount(x.generationId) && Number(x.generationId) > 0)) throw new Error('The architecture API returned invalid input generation metadata.');
  const nodes = value.nodes.map(parseNode), edges = value.edges.map(parseEdge);
  if (!value.rootIds.every(isText) || value.rootIds.length !== Number(value.page.rootCount) || new Set(value.rootIds).size !== value.rootIds.length ||
      new Set(nodes.map(item => item.id)).size !== nodes.length || new Set(edges.map(item => item.id)).size !== edges.length ||
      !nodes.every(item => item.workspaceId === value.workspace.id) || !edges.every(item => item.workspaceId === value.workspace.id) ||
      value.rootIds.some(id => !nodes.some(node => node.id === id)) || edges.some(edge => !nodes.some(node => node.id === edge.sourceId) || !nodes.some(node => node.id === edge.targetId))) throw new Error('The architecture API returned invalid graph data.');
  const analysis = value.analysis, page = value.page;
  if (value.diagnostics !== undefined && !(value.diagnostics as unknown[]).every(isDiagnostic)) throw new Error('The architecture API returned invalid diagnostics.');
  return { workspace: value.workspace as Result['workspace'], ...(isText(value.activeSnapshotId) ? { activeSnapshotId: value.activeSnapshotId } : {}), analysis: { ...analysis, inputGenerations: inputs as InputGeneration[], diagnostics: analysis.diagnostics as Result['analysis']['diagnostics'] }, query: value.query as Result['query'], page: page as Result['page'], rootIds: value.rootIds as string[], nodes, edges, ...(value.diagnostics === undefined ? {} : { diagnostics: value.diagnostics as Diagnostic[] }) };
}
function parseNode(value: unknown): NodeItem { validateItem(value); if (!isRecord(value) || !isText(value.label)) throw new Error('The architecture API returned an invalid node.'); return value as NodeItem; }
function parseEdge(value: unknown): EdgeItem { validateItem(value); if (!isRecord(value) || !isText(value.sourceId) || !isText(value.targetId)) throw new Error('The architecture API returned an invalid edge.'); return value as EdgeItem; }
function validateItem(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value) || !isText(value.id) || !isText(value.workspaceId) || !isText(value.kind) || !isRecord(value.properties) || !isCount(value.evidenceCount) ||
      !['DIRECT','DERIVED','INFERRED'].includes(String(value.level)) || (value.label !== undefined && !isText(value.label)) ||
      (value.evidence !== undefined && (!Array.isArray(value.evidence) || !value.evidence.every(isEvidence)))) throw new Error('The architecture API returned an invalid graph item.');
}
function isEvidence(value: unknown): value is Evidence { return isRecord(value) && isText(value.id) && isText(value.subjectId) && (value.subjectKind === 'node' || value.subjectKind === 'edge') && isText(value.type) && ['DIRECT','DERIVED','INFERRED'].includes(String(value.level)); }
function isDiagnostic(value: unknown): value is Diagnostic { return isRecord(value) && ['info','warning','error'].includes(String(value.severity)) && isText(value.message) && (value.code === undefined || isText(value.code)) && (value.uri === undefined || isText(value.uri)) && (value.line === undefined || isCount(value.line)); }
type PageTransition = { type: 'next'; previous: string | undefined } | { type: 'previous' } | { type: 'restart' };

export function ArchitectureView({ workspaces }: { workspaces: Workspace[] }) {
  const [filters, setFilters] = useState(filtersFromUrl);
  const [draftFilters, setDraftFilters] = useState(filtersFromUrl);
  const [result, setResult] = useState<Result>();
  const [selected, setSelected] = useState<Item>();
  const [error, setError] = useState<{ status: number; code?: string; message: string }>();
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [currentCursor, setCurrentCursor] = useState<string>();
  const [pageStack, setPageStack] = useState<Array<string | undefined>>([]);
  const graphElement = useRef<HTMLDivElement>(null);
  const cy = useRef<Core>();
  const requestId = useRef(0);
  const controller = useRef<AbortController>();
  const query = useMemo(() => {
    const params = new URLSearchParams({ workspace: filters.workspace, root: filters.root, limit: String(filters.limit), depth: String(filters.depth) });
    if (filters.root === 'endpoint') { if (filters.namespace) params.set('namespace', filters.namespace); if (filters.method) params.set('method', filters.method); if (filters.path) params.set('path', filters.path); }
    if (filters.root === 'finding' && filters.finding) params.set('finding', filters.finding);
    const include = [filters.includeEvidence && 'evidence', filters.includeDiagnostics && 'diagnostics'].filter(Boolean).join(',');
    if (include) params.set('include', include);
    return params;
  }, [filters]);
  const load = async (pageCursor?: string, transition: PageTransition = { type: 'restart' }) => {
    if (!filters.workspace) return;
    const request = ++requestId.current;
    controller.current?.abort();
    const abortController = new AbortController();
    controller.current = abortController;
    setLoading(true); setError(undefined);
    const params = new URLSearchParams(query); if (pageCursor) params.set('cursor', pageCursor);
    try {
      const response = await fetch(`/api/v1/architecture?${params}`, { signal: abortController.signal });
      const body: unknown = await response.json();
      if (request !== requestId.current) return;
      if (!response.ok) {
        const payload = isRecord(body) ? body : {};
        throw { status: response.status, code: isText(payload.code) ? payload.code : undefined, message: isText(payload.error) ? payload.error : 'Architecture query failed.' };
      }
      const parsed = parseResult(body);
      setResult(parsed); setSelected(undefined); setCursor(parsed.page.nextCursor); setCurrentCursor(pageCursor);
      if (transition.type === 'next') setPageStack(current => [...current, transition.previous]);
      if (transition.type === 'previous') setPageStack(current => current.slice(0, -1));
      if (transition.type === 'restart') setPageStack([]);
      setError(undefined);
    } catch (failure) {
      if (request === requestId.current && !abortController.signal.aborted) {
        const error = isRecord(failure) ? failure : {};
        setError({ status: isCount(error.status) ? Number(error.status) : 500, code: isText(error.code) ? error.code : undefined, message: isText(error.message) ? error.message : 'Architecture query failed.' });
      }
    }
    finally { if (request === requestId.current) setLoading(false); }
  };
  useEffect(() => {
    requestId.current++; setCursor(undefined); setCurrentCursor(undefined); setPageStack([]); setResult(undefined);
    if (filters.workspace) void load(undefined, { type: 'restart' }); else setLoading(false);
    return () => { requestId.current++; controller.current?.abort(); };
  }, [query]);
  useEffect(() => {
    const onPop = () => { const next = filtersFromUrl(); setFilters(next); setDraftFilters(next); };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => { writeFilterUrl(filters, 'replace'); }, [filters]);
  useEffect(() => () => { requestId.current++; controller.current?.abort(); cy.current?.destroy(); cy.current = undefined; }, []);
  useEffect(() => {
    if (!graphElement.current) return;
    cy.current?.destroy();
    if (!result) return;
    const columns: Record<string, number> = { api_endpoint: 0, python_function: 1, python_async_function: 1, sqlalchemy_model: 2, sqlalchemy_table: 3 };
    const grouped = new Map<number, Item[]>();
    for (const node of result.nodes) { const col = node.kind.startsWith('architecture_contract_') ? 4 : columns[node.kind] ?? 2; grouped.set(col, [...(grouped.get(col) ?? []), node]); }
    const positions = new Map<string, { x: number; y: number }>();
    for (const [col, items] of grouped) items.forEach((node, index) => positions.set(node.id, { x: 100 + col * 210, y: 70 + index * 100 }));
    cy.current = cytoscape({ container: graphElement.current, elements: [...result.nodes.map(n => ({ data: { id: n.id, label: n.label ?? n.kind, kind: n.kind, level: n.level }, classes: result.rootIds.includes(n.id) ? 'root' : '', position: positions.get(n.id) })), ...result.edges.map(e => ({ data: { id: e.id, source: e.sourceId, target: e.targetId, label: e.kind, level: e.level } }))], style: [
      { selector: 'node', style: { 'background-color': '#57c7b7', label: 'data(label)', color: '#e9eff5', 'font-size': 11, 'text-wrap': 'wrap', 'text-max-width': 120, width: 18, height: 18, 'text-valign': 'bottom', 'text-margin-y': 5 } },
      { selector: 'node[kind ^= "python_"]', style: { 'background-color': '#80a9e8' } },
      { selector: 'node[kind ^= "sqlalchemy_"]', style: { 'background-color': '#83c995' } },
      { selector: 'node[kind ^= "architecture_contract_"]', style: { 'background-color': '#f0b36b', shape: 'diamond' } },
      { selector: 'node[level = "DIRECT"]', style: { 'border-width': 2, 'border-style': 'solid', 'border-color': '#dffffa' } },
      { selector: 'node[level = "DERIVED"]', style: { 'border-width': 2, 'border-style': 'dotted', 'border-color': '#8cdbcc' } },
      { selector: 'node[level = "INFERRED"]', style: { 'border-width': 2, 'border-style': 'dashed', 'border-color': '#e2b96f' } },
      { selector: 'node.root', style: { width: 27, height: 27, 'border-width': 3 } },
      { selector: 'edge', style: { width: 1.5, 'line-color': '#536173', 'target-arrow-color': '#536173', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', label: 'data(label)', color: '#c0cad5', 'font-size': 9, 'text-background-color': '#10151d', 'text-background-opacity': 1 } },
      { selector: 'edge[level = "DIRECT"]', style: { width: 2.5, 'line-style': 'solid' } },
      { selector: 'edge[level = "DERIVED"]', style: { width: 2, 'line-style': 'dotted' } },
      { selector: 'edge[level = "INFERRED"]', style: { width: 2, 'line-style': 'dashed', 'line-color': '#e2b96f', 'target-arrow-color': '#e2b96f' } },
      { selector: ':selected', style: { 'underlay-color': '#dffffa', 'underlay-opacity': 0.35, 'underlay-padding': 5 } },
    ], layout: { name: 'preset', fit: true, padding: 40 } });
    cy.current.on('tap', 'node, edge', event => setSelected(result.nodes.concat(result.edges).find(item => item.id === event.target.id())));
    return () => { cy.current?.destroy(); cy.current = undefined; };
  }, [result]);
  const changeDraft = (key: keyof Filters, value: string | number | boolean) => {
    const next = { ...draftFilters, [key]: value } as Filters;
    setDraftFilters(next);
    if (key === 'workspace' && next.workspace !== filters.workspace) { writeFilterUrl(next, 'push'); setFilters(next); }
  };
  const applyFilters = () => {
    writeFilterUrl(draftFilters, 'push');
    const same = JSON.stringify(draftFilters) === JSON.stringify(filters);
    setFilters(draftFilters);
    if (same) void load(undefined, { type: 'restart' });
  };
  const pageNext = () => { if (cursor) void load(cursor, { type: 'next', previous: currentCursor }); };
  const pagePrevious = () => { if (pageStack.length) void load(pageStack.at(-1), { type: 'previous' }); };
  return <section className="architecture-view" aria-labelledby="architecture-title">
    <div className="architecture-heading"><div><p className="eyebrow">ANALYSIS SNAPSHOT</p><h1 id="architecture-title">Architecture</h1><p className="muted">Explore generated contracts and their source evidence.</p></div><p className="snapshot-meta">{result ? `Generation ${result.analysis.generationId}` : 'Workspace architecture'}</p></div>
    <FilterBar workspaces={workspaces} filters={draftFilters} onChange={changeDraft} onSubmit={applyFilters} loading={loading} />
    {filters.workspace && <SourceStatePanel workspaceId={filters.workspace} graphSnapshotId={result?.activeSnapshotId} refreshGraph={() => void load(undefined, { type: 'restart' })} mode="architecture" architectureGeneration={result?.analysis.generationId} codeGraphInput={result?.analysis.inputGenerations.find(input => input.analyzerId === 'builtin.codegraph')?.generationId}/>}
    {error && <div className="architecture-message error-message" role="alert"><strong>{error.status === 404 ? 'No active architecture snapshot' : error.status === 409 ? 'Snapshot changed' : error.status === 422 ? 'Query is too large' : 'Could not load architecture'}</strong><p>{error.message}</p>{error.status === 404 && <p>Run the FastAPI, OpenAPI, or SQLAlchemy analyzer, then run the architecture analyzer.</p>}{error.status === 409 && <button onClick={() => void load(undefined, { type: 'restart' })}>Restart paging</button>}{error.status === 422 && <p>Reduce the root limit or graph depth, then retry.</p>}</div>}
    {loading && <p className="architecture-message" role="status">Loading architecture snapshot…</p>}
    {!loading && !error && result && result.rootIds.length === 0 && <p className="architecture-message" role="status">No roots match these filters. Change the root type or filters.</p>}
    {result && <><div className="architecture-summary" aria-live="polite"><span>{result.page.totalRootCount} matching roots · {result.nodes.length} nodes · {result.edges.length} relationships</span><span>Input generations: {result.analysis.inputGenerations.length ? result.analysis.inputGenerations.map(x => `${x.analyzerId} #${x.generationId}`).join(' · ') : 'none'}</span></div>
      <div className="architecture-layout"><section className="architecture-graph-panel" aria-label="Architecture graph"><div className="graph-legend"><span>Endpoint · teal</span><span>Handler · blue</span><span>Model / table · green</span><span className="finding-key">Finding · amber</span><span>Evidence: solid DIRECT · dotted DERIVED · dashed INFERRED</span></div><div className="graph-controls"><button onClick={() => cy.current?.zoom(cy.current.zoom() * 1.2)} aria-label="Zoom in">+</button><button onClick={() => cy.current?.zoom(cy.current.zoom() / 1.2)} aria-label="Zoom out">−</button><button onClick={() => cy.current?.fit(undefined, 40)}>Fit graph</button></div><div ref={graphElement} className="architecture-canvas" aria-hidden="true" />
        <AccessibleGraph items={result.nodes} edges={result.edges} onSelect={setSelected} selectedId={selected?.id} />
        <div className="pagination"><span>Showing {result.page.rootCount} of {result.page.totalRootCount} roots</span><div><button disabled={!pageStack.length || loading} onClick={pagePrevious}>Previous</button><button disabled={!cursor || loading || !!error} onClick={pageNext}>Next</button></div></div>
      </section><Inspector item={selected} inputs={result.analysis.inputGenerations} analysis={result.analysis} />
      {filters.includeDiagnostics && <Diagnostics diagnostics={result.diagnostics ?? []} counts={result.analysis.diagnostics} />}</div></>}
    {!filters.workspace && !workspaces.length && <p className="architecture-message" role="status">No saved workspaces. Add a workspace when starting GraphLens, then run an analyzer.</p>}
  </section>;
}

function FilterBar({ workspaces, filters, onChange, onSubmit, loading }: { workspaces: Workspace[]; filters: Filters; onChange: (key: keyof Filters, value: string | number | boolean) => void; onSubmit: () => void; loading: boolean }) {
  return <details className="filters-disclosure" open><summary>Workspace and query</summary><form className="architecture-filters" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <label>Workspace<select value={filters.workspace} onChange={e => onChange('workspace', e.target.value)}><option value="">Select workspace</option>{workspaces.map(w => <option key={w.id} value={w.id}>{w.name} · {w.path}</option>)}</select></label>
    <label>Root type<select value={filters.root} onChange={e => onChange('root', e.target.value)}>{[['endpoint','Endpoints'],['handler','Handlers'],['model','Models'],['table','Tables'],['finding','Findings']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {filters.root === 'endpoint' && <><label>Namespace<input value={filters.namespace} onChange={e => onChange('namespace', e.target.value)} placeholder="Any namespace" /></label><label>Method<select value={filters.method} onChange={e => onChange('method', e.target.value)}><option value="">Any method</option>{['GET','HEAD','POST','PUT','DELETE','CONNECT','OPTIONS','TRACE','PATCH'].map(x => <option key={x}>{x}</option>)}</select></label><label>Path<input value={filters.path} onChange={e => onChange('path', e.target.value)} placeholder="/api/items" /></label></>}
    {filters.root === 'finding' && <label>Finding<select value={filters.finding} onChange={e => onChange('finding', e.target.value)}><option value="">All finding types</option>{[['gap','Gap'],['ambiguous','Ambiguous'],['unresolved','Unresolved'],['mismatch','Mismatch']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label>}
    <label>Root limit<select value={filters.limit} onChange={e => onChange('limit', Number(e.target.value))}>{[10,25,50,100].map(n => <option key={n}>{n}</option>)}</select></label><label>Depth<select value={filters.depth} onChange={e => onChange('depth', Number(e.target.value))}>{[0,1,2,3,4,5,6].map(n => <option key={n}>{n}</option>)}</select></label>
    <label className="check-label"><input type="checkbox" checked={filters.includeEvidence} onChange={e => onChange('includeEvidence', e.target.checked)} /> Include evidence</label><label className="check-label"><input type="checkbox" checked={filters.includeDiagnostics} onChange={e => onChange('includeDiagnostics', e.target.checked)} /> Include diagnostics</label><button type="submit" disabled={!filters.workspace || loading}>Refresh snapshot</button>
  </form></details>;
}

function AccessibleGraph({ items, edges, onSelect, selectedId }: { items: Item[]; edges: Item[]; onSelect: (item: Item) => void; selectedId?: string }) {
  const [nodeId, setNodeId] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const relationshipHeading = useRef<HTMLHeadingElement>(null);
  const selected = items.find(item => item.id === nodeId);
  const incident = selected ? edges.filter(edge => edge.sourceId === selected.id || edge.targetId === selected.id) : edges;
  useEffect(() => {
    if (!selectedId) return;
    const item = [...items, ...edges].find(candidate => candidate.id === selectedId);
    if (!item) return;
    setAnnouncement(`Selected ${item.kind.replaceAll('_', ' ')}: ${item.label ?? item.id}. ${item.level} evidence, ${item.evidenceCount} evidence items.`);
  }, [selectedId, items, edges]);
  useEffect(() => { if (nodeId && !items.some(item => item.id === nodeId)) setNodeId(''); }, [items, nodeId]);
  return <div className="graph-index"><section><h2>Keyboard graph navigation</h2><p className="visually-hidden" role="status" aria-live="polite">{announcement}</p><label>Node selector<select value={nodeId} onChange={event => { setNodeId(event.target.value); const item = items.find(candidate => candidate.id === event.target.value); if (item) onSelect(item); }}><option value="">Choose a node</option>{items.map(item => <option key={item.id} value={item.id}>{item.kind.replaceAll('_', ' ')} · {item.label ?? item.id}</option>)}</select></label><button type="button" disabled={!selected} onClick={() => relationshipHeading.current?.focus()}>Show selected node relationships</button><h3>Nodes</h3><ul>{items.map(item => <li key={item.id}><button className="graph-item" aria-pressed={selectedId === item.id} onClick={() => { setNodeId(item.id); onSelect(item); }}><span className="node-kind">{item.kind.replaceAll('_', ' ')}</span><strong>{item.label ?? item.id}</strong><small>{item.level} evidence · {item.evidenceCount} items</small></button></li>)}</ul></section><section><h2 ref={relationshipHeading} tabIndex={-1}>Relationships{selected ? ` · ${incident.length} for selected node` : ''}</h2><ul>{incident.map(edge => <li key={edge.id}><button className="graph-item edge-item" aria-pressed={selectedId === edge.id} onClick={() => onSelect(edge)}><span className="node-kind">{edge.kind.replaceAll('_', ' ')}</span><strong>{edge.sourceId} → {edge.targetId}</strong><small>{edge.level} evidence · {edge.evidenceCount} items</small></button></li>)}</ul></section></div>;
}

function Inspector({ item, inputs, analysis }: { item?: Item; inputs: Result['analysis']['inputGenerations']; analysis: Result['analysis'] }) {
  return <aside className="architecture-inspector"><details open><summary>Selection details</summary>{!item ? <p className="muted">Select a node or relationship in the graph or lists.</p> : <><p className="eyebrow">{item.kind.replaceAll('_', ' ')}</p><h3>{item.label ?? item.id}</h3><p>Evidence level: <strong>{item.level}</strong></p><p>Evidence count: {item.evidenceCount}</p>{item.sourceId && <p>Relationship: <code>{item.sourceId} → {item.targetId}</code></p>}<ProvenanceInspector item={item} inputGenerations={inputs}/><h3>Analysis generation</h3><p>Generation: {analysis.generationId}</p><p>Source revision: <code>{analysis.sourceRevision ?? 'not provided'}</code></p><ul>{inputs.map(input => <li key={input.analyzerId}><code>{input.analyzerId} #{input.generationId}</code></li>)}</ul></>}</details></aside>;
}
function Diagnostics({ diagnostics, counts }: { diagnostics: Diagnostic[]; counts: Result['analysis']['diagnostics'] }) { return <section className="diagnostics"><h2>Related diagnostics <span>{diagnostics.length} shown · {counts.warning} warnings, {counts.error} errors, {counts.total} generation-wide</span></h2>{diagnostics.length ? <ul>{diagnostics.map((item, i) => <li key={i}><strong>{item.severity} · {item.code ?? 'Diagnostic'}</strong><p>{item.message}</p>{item.uri && <code>{item.uri}{item.line ? `:${item.line}` : ''}</code>}</li>)}</ul> : <p className="muted">No related diagnostics for this page.</p>}</section>; }
