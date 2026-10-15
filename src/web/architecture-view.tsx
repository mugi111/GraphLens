import React, { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import './architecture.css';

type Workspace = { id: string; name: string; path: string };
type Item = { id: string; label?: string; kind: string; sourceId?: string; targetId?: string; properties?: Record<string, unknown>; evidenceCount?: number; evidence?: unknown[]; level?: string };
type Result = { workspace: string; analysis: { generationId: number; sourceRevision?: string; inputGenerations: Array<{ analyzerId: string; generationId: number }>; diagnostics: { total: number; warning: number; error: number } }; page: { totalRootCount: number; rootCount: number; nextCursor?: string }; rootIds: string[]; nodes: Item[]; edges: Item[]; diagnostics?: Array<Record<string, unknown>> };
type Filters = { workspace: string; root: string; namespace: string; method: string; path: string; finding: string; limit: number; depth: number; includeEvidence: boolean; includeDiagnostics: boolean };
const initial: Filters = { workspace: '', root: 'endpoint', namespace: '', method: '', path: '', finding: '', limit: 25, depth: 3, includeEvidence: true, includeDiagnostics: false };
function filtersFromUrl(): Filters { const p = new URLSearchParams(location.search); return { ...initial, workspace: p.get('workspace') ?? '', root: p.get('root') ?? initial.root, namespace: p.get('namespace') ?? '', method: p.get('method') ?? '', path: p.get('path') ?? '', finding: p.get('finding') ?? '', limit: Number(p.get('limit') ?? initial.limit), depth: Number(p.get('depth') ?? initial.depth), includeEvidence: p.get('evidence') !== 'false', includeDiagnostics: p.get('diagnostics') === 'true' }; }

export function ArchitectureView({ workspaces }: { workspaces: Workspace[] }) {
  const [filters, setFilters] = useState(filtersFromUrl);
  const [result, setResult] = useState<Result>();
  const [selected, setSelected] = useState<Item>();
  const [error, setError] = useState<{ status: number; code?: string; message: string }>();
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [currentCursor, setCurrentCursor] = useState<string>();
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const graphElement = useRef<HTMLDivElement>(null);
  const cy = useRef<Core>();
  const requestId = useRef(0);
  const query = useMemo(() => {
    const params = new URLSearchParams({ workspace: filters.workspace, root: filters.root, limit: String(filters.limit), depth: String(filters.depth) });
    if (filters.root === 'endpoint') { if (filters.namespace) params.set('namespace', filters.namespace); if (filters.method) params.set('method', filters.method); if (filters.path) params.set('path', filters.path); }
    if (filters.root === 'finding' && filters.finding) params.set('finding', filters.finding);
    const include = [filters.includeEvidence && 'evidence', filters.includeDiagnostics && 'diagnostics'].filter(Boolean).join(',');
    if (include) params.set('include', include);
    return params;
  }, [filters]);
  const load = async (pageCursor?: string) => {
    if (!filters.workspace) return;
    const request = ++requestId.current;
    setLoading(true); setError(undefined);
    const params = new URLSearchParams(query); if (pageCursor) params.set('cursor', pageCursor);
    try {
      const response = await fetch(`/api/v1/architecture?${params}`);
      const body = await response.json();
      if (request !== requestId.current) return;
      if (!response.ok) throw { status: response.status, code: body.code, message: body.error ?? 'Architecture query failed.' };
      setResult(body); setSelected(undefined); setCursor(body.page.nextCursor); setCurrentCursor(pageCursor); setError(undefined);
    } catch (failure) { if (request === requestId.current) { setError(failure as { status: number; code?: string; message: string }); setResult(undefined); } }
    finally { if (request === requestId.current) setLoading(false); }
  };
  useEffect(() => { requestId.current++; setCursor(undefined); setCurrentCursor(undefined); setHistory([]); setResult(undefined); if (filters.workspace) void load(); else setLoading(false); }, [query]);
  useEffect(() => { const onPop = () => setFilters(filtersFromUrl()); addEventListener('popstate', onPop); return () => removeEventListener('popstate', onPop); }, []);
  useEffect(() => { const params = new URLSearchParams(location.search); params.set('view', 'architecture'); for (const key of ['workspace','root','namespace','method','path','finding','limit','depth','evidence','diagnostics']) params.delete(key); if (filters.workspace) params.set('workspace', filters.workspace); params.set('root', filters.root); if (filters.namespace && filters.root === 'endpoint') params.set('namespace', filters.namespace); if (filters.method && filters.root === 'endpoint') params.set('method', filters.method); if (filters.path && filters.root === 'endpoint') params.set('path', filters.path); if (filters.finding && filters.root === 'finding') params.set('finding', filters.finding); params.set('limit', String(filters.limit)); params.set('depth', String(filters.depth)); params.set('evidence', String(filters.includeEvidence)); params.set('diagnostics', String(filters.includeDiagnostics)); history.replaceState({}, '', `${location.pathname}?${params}`); }, [filters]);
  useEffect(() => {
    if (!graphElement.current) return;
    cy.current?.destroy();
    if (!result) return;
    const columns: Record<string, number> = { api_endpoint: 0, python_function: 1, python_async_function: 1, sqlalchemy_model: 2, sqlalchemy_table: 3 };
    const grouped = new Map<number, Item[]>();
    for (const node of result.nodes) { const col = node.kind.startsWith('architecture_contract_') ? 4 : columns[node.kind] ?? 2; grouped.set(col, [...(grouped.get(col) ?? []), node]); }
    const positions = new Map<string, { x: number; y: number }>();
    for (const [col, items] of grouped) items.forEach((node, index) => positions.set(node.id, { x: 100 + col * 210, y: 70 + index * 100 }));
    cy.current = cytoscape({ container: graphElement.current, elements: [...result.nodes.map(n => ({ data: { id: n.id, label: n.label ?? n.kind, kind: n.kind, level: n.level, root: result.rootIds.includes(n.id) }, position: positions.get(n.id) })), ...result.edges.map(e => ({ data: { id: e.id, source: e.sourceId, target: e.targetId, label: e.kind } }))], style: [
      { selector: 'node', style: { 'background-color': '#57c7b7', label: 'data(label)', color: '#e9eff5', 'font-size': 11, 'text-wrap': 'wrap', 'text-max-width': 120, width: 18, height: 18, 'text-valign': 'bottom', 'text-margin-y': 5 } },
      { selector: 'node[kind ^= "python_"]', style: { 'background-color': '#80a9e8' } },
      { selector: 'node[kind ^= "sqlalchemy_"]', style: { 'background-color': '#83c995' } },
      { selector: 'node[kind ^= "architecture_contract_"]', style: { 'background-color': '#f0b36b', shape: 'diamond' } },
      { selector: 'node[level = "INFERRED"]', style: { 'border-width': 2, 'border-style': 'dashed', 'border-color': '#e2b96f' } },
      { selector: 'node[root]', style: { width: 27, height: 27, 'border-width': 3, 'border-color': '#dffffa' } },
      { selector: 'edge', style: { width: 1.5, 'line-color': '#536173', 'target-arrow-color': '#536173', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', label: 'data(label)', color: '#c0cad5', 'font-size': 9, 'text-background-color': '#10151d', 'text-background-opacity': 1 } },
      { selector: ':selected', style: { 'underlay-color': '#dffffa', 'underlay-opacity': 0.35, 'underlay-padding': 5 } },
    ], layout: { name: 'preset', fit: true, padding: 40 } });
    cy.current.on('tap', 'node, edge', event => setSelected(result.nodes.concat(result.edges).find(item => item.id === event.target.id())));
    return () => { cy.current?.destroy(); cy.current = undefined; };
  }, [result]);
  const change = (key: keyof Filters, value: string | number | boolean) => setFilters(current => ({ ...current, [key]: value }));
  const updateFilter = (key: keyof Filters, value: string | number | boolean) => { change(key, value); };
  const pageNext = () => { if (!cursor) return; setHistory(current => [...current, currentCursor]); void load(cursor); };
  const pagePrevious = () => { const previous = history.at(-1); setHistory(current => current.slice(0, -1)); void load(previous); };
  return <section className="architecture-view" aria-labelledby="architecture-title">
    <div className="architecture-heading"><div><p className="eyebrow">ANALYSIS SNAPSHOT</p><h1 id="architecture-title">Architecture</h1><p className="muted">Explore generated contracts and their source evidence.</p></div><p className="snapshot-meta">{result ? `Generation ${result.analysis.generationId}` : 'Workspace architecture'}</p></div>
    <FilterBar workspaces={workspaces} filters={filters} onChange={updateFilter} onSubmit={() => { setHistory([]); void load(); }} loading={loading} />
    {error && <div className="architecture-message error-message" role="alert"><strong>{error.status === 404 ? 'No active architecture snapshot' : error.status === 409 ? 'Snapshot changed' : error.status === 422 ? 'Query is too large' : 'Could not load architecture'}</strong><p>{error.message}</p>{error.status === 404 && <p>Run the FastAPI, OpenAPI, or SQLAlchemy analyzer, then run the architecture analyzer.</p>}{error.status === 409 && <button onClick={() => { setHistory([]); void load(); }}>Restart paging</button>}{error.status === 422 && <p>Reduce the root limit or graph depth, then retry.</p>}</div>}
    {loading && <p className="architecture-message" role="status">Loading architecture snapshot…</p>}
    {!loading && !error && result && result.rootIds.length === 0 && <p className="architecture-message" role="status">No roots match these filters. Change the root type or filters.</p>}
    {result && <><div className="architecture-summary" aria-live="polite"><span>{result.page.totalRootCount} matching roots · {result.nodes.length} nodes · {result.edges.length} relationships</span><span>Input generations: {result.analysis.inputGenerations.length ? result.analysis.inputGenerations.map(x => `${x.analyzerId} #${x.generationId}`).join(' · ') : 'none'}</span></div>
      <div className="architecture-layout"><section className="architecture-graph-panel" aria-label="Architecture graph"><div className="graph-legend"><span>Endpoint · teal</span><span>Handler · blue</span><span>Model / table · green</span><span className="finding-key">Finding · amber</span><span>Dashed border: inferred</span></div><div className="graph-controls"><button onClick={() => cy.current?.zoom(cy.current.zoom() * 1.2)} aria-label="Zoom in">+</button><button onClick={() => cy.current?.zoom(cy.current.zoom() / 1.2)} aria-label="Zoom out">−</button><button onClick={() => cy.current?.fit(undefined, 40)}>Fit graph</button></div><div ref={graphElement} className="architecture-canvas" aria-hidden="true" />
        <AccessibleGraph items={result.nodes} edges={result.edges} onSelect={setSelected} selectedId={selected?.id} />
        <div className="pagination"><span>Showing {result.page.rootCount} of {result.page.totalRootCount} roots</span><div><button disabled={!history.length || loading} onClick={pagePrevious}>Previous</button><button disabled={!cursor || loading} onClick={pageNext}>Next</button></div></div>
      </section><Inspector item={selected} inputs={result.analysis.inputGenerations} analysis={result.analysis} />
      {filters.includeDiagnostics && <Diagnostics diagnostics={result.diagnostics ?? []} counts={result.analysis.diagnostics} />}</div></>}
    {!filters.workspace && !workspaces.length && <p className="architecture-message" role="status">No saved workspaces. Add a workspace when starting GraphLens, then run an analyzer.</p>}
  </section>;
}

function FilterBar({ workspaces, filters, onChange, onSubmit, loading }: { workspaces: Workspace[]; filters: Filters; onChange: (key: keyof Filters, value: string | number | boolean) => void; onSubmit: () => void; loading: boolean }) {
  return <details className="filters-disclosure" open><summary>Workspace and query</summary><form className="architecture-filters" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <label>Workspace<select value={filters.workspace} onChange={e => onChange('workspace', e.target.value)}><option value="">Select workspace</option>{workspaces.map(w => <option key={w.id} value={w.id}>{w.name} · {w.path}</option>)}</select></label>
    <label>Root type<select value={filters.root} onChange={e => onChange('root', e.target.value)}>{[['endpoint','Endpoints'],['handler','Handlers'],['model','Models'],['table','Tables'],['finding','Findings']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {filters.root === 'endpoint' && <><label>Namespace<input value={filters.namespace} onChange={e => onChange('namespace', e.target.value)} placeholder="Any namespace" /></label><label>Method<select value={filters.method} onChange={e => onChange('method', e.target.value)}><option value="">Any method</option>{['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'].map(x => <option key={x}>{x}</option>)}</select></label><label>Path<input value={filters.path} onChange={e => onChange('path', e.target.value)} placeholder="/api/items" /></label></>}
    {filters.root === 'finding' && <label>Finding<select value={filters.finding} onChange={e => onChange('finding', e.target.value)}><option value="">All finding types</option>{[['gap','Gap'],['ambiguous','Ambiguous'],['unresolved','Unresolved'],['mismatch','Mismatch']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label>}
    <label>Root limit<select value={filters.limit} onChange={e => onChange('limit', Number(e.target.value))}>{[10,25,50,100].map(n => <option key={n}>{n}</option>)}</select></label><label>Depth<select value={filters.depth} onChange={e => onChange('depth', Number(e.target.value))}>{[0,1,2,3,4,5,6].map(n => <option key={n}>{n}</option>)}</select></label>
    <label className="check-label"><input type="checkbox" checked={filters.includeEvidence} onChange={e => onChange('includeEvidence', e.target.checked)} /> Include evidence</label><label className="check-label"><input type="checkbox" checked={filters.includeDiagnostics} onChange={e => onChange('includeDiagnostics', e.target.checked)} /> Include diagnostics</label><button type="submit" disabled={!filters.workspace || loading}>Refresh snapshot</button>
  </form></details>;
}

function AccessibleGraph({ items, edges, onSelect, selectedId }: { items: Item[]; edges: Item[]; onSelect: (item: Item) => void; selectedId?: string }) {
  const [nodeId, setNodeId] = useState('');
  const selected = items.find(item => item.id === nodeId);
  const incident = selected ? edges.filter(edge => edge.sourceId === selected.id || edge.targetId === selected.id) : edges;
  return <div className="graph-index"><section><h2>Keyboard graph navigation</h2><label>Node selector<select value={nodeId} onChange={event => { setNodeId(event.target.value); const item = items.find(candidate => candidate.id === event.target.value); if (item) onSelect(item); }}><option value="">Choose a node</option>{items.map(item => <option key={item.id} value={item.id}>{item.kind.replaceAll('_', ' ')} · {item.label ?? item.id}</option>)}</select></label><h3>Nodes</h3><ul>{items.map(item => <li key={item.id}><button className="graph-item" aria-pressed={selectedId === item.id} onClick={() => { setNodeId(item.id); onSelect(item); }}><span className="node-kind">{item.kind.replaceAll('_', ' ')}</span><strong>{item.label ?? item.id}</strong><small>{item.level ?? 'No evidence'} · {item.evidenceCount ?? 0} evidence</small></button></li>)}</ul></section><section><h2>Relationships{selected ? ` · ${incident.length} for selected node` : ''}</h2><ul>{incident.map(edge => <li key={edge.id}><button className="graph-item edge-item" aria-pressed={selectedId === edge.id} onClick={() => onSelect(edge)}><span className="node-kind">{edge.kind.replaceAll('_', ' ')}</span><strong>{edge.sourceId} → {edge.targetId}</strong><small>{edge.level ?? 'No evidence'} · {edge.evidenceCount ?? 0} evidence</small></button></li>)}</ul></section></div>;
}

function Inspector({ item, inputs, analysis }: { item?: Item; inputs: Result['analysis']['inputGenerations']; analysis?: Result['analysis'] }) {
  return <aside className="architecture-inspector"><details open><summary>Selection details</summary>{!item ? <p className="muted">Select a node or relationship in the graph or lists.</p> : <><p className="eyebrow">{item.kind.replaceAll('_', ' ')}</p><h3>{item.label ?? item.id}</h3><p>Evidence level: <strong>{item.level ?? 'No evidence'}</strong></p><p>Evidence count: {item.evidenceCount ?? 0}</p>{item.sourceId && <p>Relationship: <code>{item.sourceId} → {item.targetId}</code></p>}<h3>Properties and evidence</h3><pre>{JSON.stringify({ properties: item.properties ?? {}, evidence: item.evidence ?? [] }, null, 2)}</pre><h3>Analysis provenance</h3><p>Generation: {analysis?.generationId ?? '—'}</p><p>Source revision: <code>{analysis?.sourceRevision ?? 'not provided'}</code></p><ul>{inputs.map(input => <li key={input.analyzerId}><code>{input.analyzerId} #{input.generationId}</code></li>)}</ul></>}</details></aside>;
}
function Diagnostics({ diagnostics, counts }: { diagnostics: Array<Record<string, unknown>>; counts: Result['analysis']['diagnostics'] }) { return <section className="diagnostics"><h2>Related diagnostics <span>{diagnostics.length} shown · {counts.warning} warnings, {counts.error} errors, {counts.total} generation-wide</span></h2>{diagnostics.length ? <ul>{diagnostics.map((item, i) => <li key={i}><strong>{String(item.severity ?? 'info')} · {String(item.code ?? 'Diagnostic')}</strong><p>{String(item.message ?? '')}</p>{item.uri && <code>{String(item.uri)}{item.line ? `:${String(item.line)}` : ''}</code>}</li>)}</ul> : <p className="muted">No related diagnostics for this page.</p>}</section>; }
