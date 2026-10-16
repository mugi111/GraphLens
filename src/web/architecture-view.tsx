import React, { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import './architecture.css';
import { useI18n } from './i18n.js';

type Workspace = { id: string; name: string; path: string };
type Root = 'endpoint' | 'handler' | 'model' | 'table' | 'finding';
type Level = 'DIRECT' | 'DERIVED' | 'INFERRED';
type Evidence = { id: string; subjectKind: 'node' | 'edge'; subjectId: string; level: Level; type: string; uri?: string; line?: number; detail?: string; provenance?: Record<string, unknown>; inputGenerations?: string[] };
type ItemBase = { id: string; workspaceId: string; kind: string; properties: Record<string, unknown>; evidenceCount: number; evidence?: Evidence[]; level: Level };
type NodeItem = ItemBase & { label: string; sourceId?: never; targetId?: never };
type EdgeItem = ItemBase & { sourceId: string; targetId: string; label?: string };
type Item = NodeItem | EdgeItem;
type Diagnostic = { code?: string; severity: 'info' | 'warning' | 'error'; message: string; uri?: string; line?: number; detail?: Record<string, unknown> };
type InputGeneration = { analyzerId: string; generationId: number };
type Result = { workspace: { id: string; name: string }; analysis: { analyzerId: string; analyzerVersion: string; generationId: number; runId: string; sourceRevision?: string; completedAt: string; inputGenerations: InputGeneration[]; diagnostics: { total: number; info: number; warning: number; error: number } }; query: { root: Root; node?: string; namespace?: string; method?: string; path?: string; finding?: 'gap' | 'ambiguous' | 'unresolved' | 'mismatch'; depth: number }; page: { limit: number; totalRootCount: number; rootCount: number; nextCursor?: string }; rootIds: string[]; nodes: Item[]; edges: Item[]; diagnostics?: Diagnostic[] };
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
  return { workspace: value.workspace as Result['workspace'], analysis: { ...analysis, inputGenerations: inputs as InputGeneration[], diagnostics: analysis.diagnostics as Result['analysis']['diagnostics'] }, query: value.query as Result['query'], page: page as Result['page'], rootIds: value.rootIds as string[], nodes, edges, ...(value.diagnostics === undefined ? {} : { diagnostics: value.diagnostics as Diagnostic[] }) };
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
function cssToken(name: string) {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

export function ArchitectureView({ workspaces }: { workspaces: Workspace[] }) {
  const { t } = useI18n();
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
      { selector: 'node', style: { 'background-color': cssToken('--color-graph-node'), 'border-width': 1, 'border-color': cssToken('--color-rule'), label: 'data(label)', color: cssToken('--color-ink'), 'font-size': 11, 'text-wrap': 'wrap', 'text-max-width': 120, width: 18, height: 18, 'text-valign': 'bottom', 'text-margin-y': 5 } },
      { selector: 'node[kind ^= "architecture_contract_"]', style: { shape: 'diamond' } },
      { selector: 'node[level = "DIRECT"]', style: { 'border-width': 2, 'border-style': 'solid', 'border-color': cssToken('--color-ink-2') } },
      { selector: 'node[level = "DERIVED"]', style: { 'border-width': 2, 'border-style': 'dotted', 'border-color': cssToken('--color-ink-2') } },
      { selector: 'node[level = "INFERRED"]', style: { 'border-width': 2, 'border-style': 'dashed', 'border-color': cssToken('--color-ink-2') } },
      { selector: 'node.root', style: { width: 27, height: 27, 'border-width': 3 } },
      { selector: 'edge', style: { width: 1.5, 'line-color': cssToken('--color-graph-edge'), 'target-arrow-color': cssToken('--color-graph-edge'), 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', label: 'data(label)', color: cssToken('--color-muted'), 'font-size': 9, 'text-background-color': cssToken('--color-paper-2'), 'text-background-opacity': 1 } },
      { selector: 'edge[level = "DIRECT"]', style: { width: 2.5, 'line-style': 'solid' } },
      { selector: 'edge[level = "DERIVED"]', style: { width: 2, 'line-style': 'dotted' } },
      { selector: 'edge[level = "INFERRED"]', style: { width: 2, 'line-style': 'dashed' } },
      { selector: ':selected', style: { 'underlay-color': cssToken('--color-accent'), 'underlay-opacity': 0.24, 'underlay-padding': 5 } },
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
    <div className="architecture-heading"><div><p className="eyebrow">{t('ANALYSIS SNAPSHOT')}</p><h1 id="architecture-title">{t('Architecture')}</h1><p className="muted">{t('Explore generated contracts and their source evidence.')}</p></div><p className="snapshot-meta">{result ? `${t('Generation')} ${result.analysis.generationId}` : t('Workspace architecture')}</p></div>
    <FilterBar workspaces={workspaces} filters={draftFilters} onChange={changeDraft} onSubmit={applyFilters} loading={loading} />
    {error && <div className="architecture-message error-message" role="alert"><strong>{t(error.status === 404 ? 'No active architecture snapshot' : error.status === 409 ? 'Snapshot changed' : error.status === 422 ? 'Query is too large' : 'Could not load architecture')}</strong><p>{error.message}</p>{error.status === 404 && <p>{t('Run the FastAPI, OpenAPI, or SQLAlchemy analyzer, then run the architecture analyzer.')}</p>}{error.status === 409 && <button className="button button-quiet" onClick={() => void load(undefined, { type: 'restart' })}>{t('Restart paging')}</button>}{error.status === 422 && <p>{t('Reduce the root limit or graph depth, then retry.')}</p>}</div>}
    {loading && <p className="architecture-message" role="status">{t('Loading architecture snapshot…')}</p>}
    {!loading && !error && result && result.rootIds.length === 0 && <p className="architecture-message" role="status">{t('No roots match these filters. Change the root type or filters.')}</p>}
    {result && <><div className="architecture-summary" aria-live="polite"><span>{result.page.totalRootCount} {t('matching roots')} · {result.nodes.length} {t('nodes')} · {result.edges.length} {t('relationships')}</span><span>{t('Input generations')}: {result.analysis.inputGenerations.length ? result.analysis.inputGenerations.map(x => `${x.analyzerId} #${x.generationId}`).join(' · ') : t('none')}</span></div>
      <div className="architecture-layout"><section className="architecture-graph-panel" aria-label={t('Architecture graph')}><div className="graph-legend"><span>{t('API contract · diamond')}</span><span>{t('Direct solid · derived dotted · inferred dashed')}</span></div><div className="graph-controls"><button className="button button-quiet" onClick={() => cy.current?.zoom(cy.current.zoom() * 1.2)} aria-label={t('Zoom in')}>+</button><button className="button button-quiet" onClick={() => cy.current?.zoom(cy.current.zoom() / 1.2)} aria-label={t('Zoom out')}>−</button><button className="button button-quiet" onClick={() => cy.current?.fit(undefined, 40)}>{t('Fit graph')}</button></div><div ref={graphElement} className="architecture-canvas" aria-hidden="true" />
        <AccessibleGraph items={result.nodes} edges={result.edges} onSelect={setSelected} selectedId={selected?.id} />
        <div className="pagination"><span>{t('Showing')} {result.page.rootCount} / {result.page.totalRootCount} {t('roots')}</span><div><button className="button button-quiet" disabled={!pageStack.length || loading} onClick={pagePrevious}>{t('Previous')}</button><button className="button button-quiet" disabled={!cursor || loading || !!error} onClick={pageNext}>{t('Next')}</button></div></div>
      </section><Inspector item={selected} inputs={result.analysis.inputGenerations} analysis={result.analysis} />
      {filters.includeDiagnostics && <Diagnostics diagnostics={result.diagnostics ?? []} counts={result.analysis.diagnostics} />}</div></>}
    {!filters.workspace && !workspaces.length && <p className="architecture-message" role="status">{t('No saved workspaces. Add a workspace when starting GraphLens, then run an analyzer.')}</p>}
  </section>;
}

function FilterBar({ workspaces, filters, onChange, onSubmit, loading }: { workspaces: Workspace[]; filters: Filters; onChange: (key: keyof Filters, value: string | number | boolean) => void; onSubmit: () => void; loading: boolean }) {
  const { t } = useI18n();
  return <details className="filters-disclosure" open><summary>{t('Workspace and query')}</summary><form className="architecture-filters" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <label>{t('Workspace')}<select name="workspace" autoComplete="off" value={filters.workspace} onChange={e => onChange('workspace', e.target.value)}><option value="">{t('Select workspace')}</option>{workspaces.map(w => <option key={w.id} value={w.id}>{w.name} · {w.path}</option>)}</select></label>
    <label>{t('Root type')}<select name="root" autoComplete="off" value={filters.root} onChange={e => onChange('root', e.target.value)}>{[['endpoint','Endpoints'],['handler','Handlers'],['model','Models'],['table','Tables'],['finding','Findings']].map(([value,label]) => <option key={value} value={value}>{t(label!)}</option>)}</select></label>
    {filters.root === 'endpoint' && <><label>{t('Namespace')}<input name="namespace" autoComplete="off" spellCheck={false} value={filters.namespace} onChange={e => onChange('namespace', e.target.value)} placeholder={t('Any namespace…')} /></label><label>{t('Method')}<select name="method" autoComplete="off" value={filters.method} onChange={e => onChange('method', e.target.value)}><option value="">{t('Any method')}</option>{['GET','HEAD','POST','PUT','DELETE','CONNECT','OPTIONS','TRACE','PATCH'].map(x => <option key={x}>{x}</option>)}</select></label><label>{t('Path')}<input name="path" autoComplete="off" spellCheck={false} value={filters.path} onChange={e => onChange('path', e.target.value)} placeholder="/api/items…" /></label></>}
    {filters.root === 'finding' && <label>{t('Finding')}<select name="finding" autoComplete="off" value={filters.finding} onChange={e => onChange('finding', e.target.value)}><option value="">{t('All finding types')}</option>{[['gap','Gap'],['ambiguous','Ambiguous'],['unresolved','Unresolved'],['mismatch','Mismatch']].map(([v,l]) => <option key={v} value={v}>{t(l!)}</option>)}</select></label>}
    <label>{t('Root limit')}<select name="limit" autoComplete="off" value={filters.limit} onChange={e => onChange('limit', Number(e.target.value))}>{[10,25,50,100].map(n => <option key={n}>{n}</option>)}</select></label><label>{t('Depth')}<select name="depth" autoComplete="off" value={filters.depth} onChange={e => onChange('depth', Number(e.target.value))}>{[0,1,2,3,4,5,6].map(n => <option key={n}>{n}</option>)}</select></label>
    <label className="check-label"><input name="includeEvidence" type="checkbox" checked={filters.includeEvidence} onChange={e => onChange('includeEvidence', e.target.checked)} /> {t('Include evidence')}</label><label className="check-label"><input name="includeDiagnostics" type="checkbox" checked={filters.includeDiagnostics} onChange={e => onChange('includeDiagnostics', e.target.checked)} /> {t('Include diagnostics')}</label><button className="button button-primary" type="submit" disabled={!filters.workspace || loading}>{t('Refresh snapshot')}</button>
  </form></details>;
}

function AccessibleGraph({ items, edges, onSelect, selectedId }: { items: Item[]; edges: Item[]; onSelect: (item: Item) => void; selectedId?: string }) {
  const { t } = useI18n();
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
  return <div className="graph-index"><section><h2>{t('Keyboard graph navigation')}</h2><p className="visually-hidden" role="status" aria-live="polite">{announcement}</p><label>{t('Node selector')}<select name="architectureNode" autoComplete="off" value={nodeId} onChange={event => { setNodeId(event.target.value); const item = items.find(candidate => candidate.id === event.target.value); if (item) onSelect(item); }}><option value="">{t('Choose a node')}</option>{items.map(item => <option key={item.id} value={item.id}>{item.kind.replaceAll('_', ' ')} · {item.label ?? item.id}</option>)}</select></label><button className="button button-quiet" type="button" disabled={!selected} onClick={() => relationshipHeading.current?.focus()}>{t('Show selected node relationships')}</button><h3>{t('Nodes')}</h3><ul>{items.map(item => <li key={item.id}><button className="graph-item" aria-pressed={selectedId === item.id} onClick={() => { setNodeId(item.id); onSelect(item); }}><span className="node-kind">{item.kind.replaceAll('_', ' ')}</span><strong>{item.label ?? item.id}</strong><small>{item.level} {t('evidence')} · {item.evidenceCount} {t('items')}</small></button></li>)}</ul></section><section><h2 ref={relationshipHeading} tabIndex={-1}>{t('Relationships')}{selected ? ` · ${incident.length} ${t('for selected node')}` : ''}</h2><ul>{incident.map(edge => <li key={edge.id}><button className="graph-item edge-item" aria-pressed={selectedId === edge.id} onClick={() => onSelect(edge)}><span className="node-kind">{edge.kind.replaceAll('_', ' ')}</span><strong>{edge.sourceId} → {edge.targetId}</strong><small>{edge.level} {t('evidence')} · {edge.evidenceCount} {t('items')}</small></button></li>)}</ul></section></div>;
}

function Inspector({ item, inputs, analysis }: { item?: Item; inputs: Result['analysis']['inputGenerations']; analysis: Result['analysis'] }) {
  const { t } = useI18n();
  return <aside className="architecture-inspector"><details open><summary>{t('Selection details')}</summary>{!item ? <p className="muted">{t('Select a node or relationship in the graph or lists.')}</p> : <><p className="eyebrow">{item.kind.replaceAll('_', ' ')}</p><h3>{item.label ?? item.id}</h3><p>{t('Evidence level')}: <strong>{item.level}</strong></p><p>{t('Evidence count')}: {item.evidenceCount}</p>{item.sourceId && <p>{t('Relationship')}: <code>{item.sourceId} → {item.targetId}</code></p>}<h3>{t('Properties and evidence')}</h3><pre>{JSON.stringify({ properties: item.properties, evidence: item.evidence ?? [] }, null, 2)}</pre><h3>{t('Analysis provenance')}</h3><p>{t('Generation')}: {analysis.generationId}</p><p>{t('Source revision')}: <code>{analysis.sourceRevision ?? t('not provided')}</code></p><ul>{inputs.map(input => <li key={input.analyzerId}><code>{input.analyzerId} #{input.generationId}</code></li>)}</ul></>}</details></aside>;
}
function Diagnostics({ diagnostics, counts }: { diagnostics: Diagnostic[]; counts: Result['analysis']['diagnostics'] }) { const { t } = useI18n(); return <section className="diagnostics"><h2>{t('Related diagnostics')} <span>{diagnostics.length} shown · {counts.warning} {t('warnings')}, {counts.error} {t('errors')}, {counts.total} {t('generation-wide')}</span></h2>{diagnostics.length ? <ul>{diagnostics.map((item, i) => <li key={i}><strong>{item.severity} · {item.code ?? t('Diagnostic')}</strong><p>{item.message}</p>{item.uri && <code>{item.uri}{item.line ? `:${item.line}` : ''}</code>}</li>)}</ul> : <p className="muted">{t('No related diagnostics for this page.')}</p>}</section>; }
