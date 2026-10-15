import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './workspace.css';
import { SourceEvidenceButton } from './source-viewer.js';

type Workspace = { id: string; name: string; path: string };
type Evidence = { id: string; type: string; uri?: string; line?: number; detail?: string; level?: string; analyzerId?: string; generationId?: number; provenance?: Record<string, unknown> };
type Node = { id: string; workspaceId: string; kind: string; label: string; properties: Record<string, unknown>; analyzerId: string; generationId: number; level: string; evidenceCount: number; evidence?: Evidence[] };
type Edge = { id: string; workspaceId: string; sourceId: string; targetId: string; kind: string; properties: Record<string, unknown>; analyzerId: string; generationId: number; level: string; evidenceCount: number; evidence?: Evidence[] };
type Page = { snapshotId: string; workspaces: Array<{ id: string; name: string }>; generations: Array<{ workspaceId: string; analyzerId: string; generationId: number }>; page: { limit: number; nextCursor?: string }; rootIds: string[]; nodes: Node[]; edges: Edge[] };
type Selection = { node?: Node; edge?: Edge };
type Branch = { nodes: Node[]; edges: Edge[]; cursor?: string; nodeId?: string; mode?: 'children' | 'neighbors'; loading?: boolean; error?: string };
type ViewState = { workspaces: string[]; mode: 'roots' | 'search'; q: string; kind: string; focus: string; expanded: string[]; neighbors: string[] };
const PAGE_SIZE = 25;

function parseUrlState(known: Workspace[]): ViewState {
  const params = new URLSearchParams(location.search); const ids = new Set(known.map((item) => item.id));
  const selected = (params.get('workspaces') ?? '').split(',').filter((id) => ids.has(id)).sort();
  const mode = params.get('mode') === 'search' ? 'search' : 'roots';
  const expanded = params.getAll('expanded').filter((id, index, all) => Boolean(id) && id.length <= 512 && all.indexOf(id) === index).slice(0, 8);
  const neighbors = params.getAll('neighbors').filter((id, index, all) => Boolean(id) && id.length <= 512 && all.indexOf(id) === index).slice(0, 8);
  const focus = (params.get('focus') ?? '').slice(0, 512);
  return { workspaces: (selected.length ? selected : known.map((item) => item.id)).slice(0, 16), mode, q: mode === 'search' ? (params.get('q') ?? '').slice(0, 256) : '', kind: (params.get('kind') ?? '').slice(0, 128), focus, expanded, neighbors };
}

export function WorkspaceView({ workspaces, refreshKey }: { workspaces: Workspace[]; refreshKey: number }) {
  const [filters, setFilters] = useState<ViewState>(() => parseUrlState(workspaces));
  const filtersRef = useRef(filters); filtersRef.current = filters;
  const [page, setPage] = useState<Page>(); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const [rootCursor, setRootCursor] = useState<string>(); const [selection, setSelection] = useState<Selection>();
  const [branches, setBranches] = useState<Record<string, Branch>>({}); const [snapshot, setSnapshot] = useState<string>(); const [workspaceFilter, setWorkspaceFilter] = useState('');
  const [canvasScale, setCanvasScale] = useState(1); const [canvasPan, setCanvasPan] = useState({ x: 0, y: 0 }); const [canvasPage, setCanvasPage] = useState(0); const [canvasEdgePage, setCanvasEdgePage] = useState(0);
  const [kindDraft, setKindDraft] = useState('');
  const initialized = useRef(false); const branchControllers = useRef(new Map<string, AbortController>()); const rootController = useRef<AbortController | undefined>(undefined); const restoredExpanded = useRef(new Set<string>()); const restoreFocus = useRef(Boolean(new URLSearchParams(location.search).get('focus')));
  const syncUrl = useCallback((next: ViewState, history: 'push' | 'replace' = 'push') => {
    const params = new URLSearchParams(location.search); params.set('view', 'overview');
    if (next.workspaces.length) params.set('workspaces', next.workspaces.join(',')); else params.delete('workspaces');
    params.set('mode', next.mode); if (next.mode === 'search' && next.q) params.set('q', next.q); else params.delete('q');
    if (next.kind) params.set('kind', next.kind); else params.delete('kind');
    if (next.focus) params.set('focus', next.focus); else params.delete('focus');
    params.delete('expanded'); for (const id of next.expanded.slice(0, 8)) params.append('expanded', id);
    params.delete('neighbors'); for (const id of next.neighbors.slice(0, 8)) params.append('neighbors', id);
    const url = `${location.pathname}?${params.toString()}`; window.history[history === 'push' ? 'pushState' : 'replaceState']({}, '', url);
  }, []);
  const reload = useCallback((next: ViewState, cursor?: string, expected?: string) => {
    rootController.current?.abort();
    if (!next.workspaces.length || (next.mode === 'search' && !next.q.trim())) { setPage(undefined); setRootCursor(undefined); setError(''); setLoading(false); setSnapshot(undefined); return () => {}; }
    const controller = new AbortController(); rootController.current = controller; setLoading(true); setError('');
    if (!cursor) { setSelection(undefined); if (restoreFocus.current) restoreFocus.current = true; }
    const params = new URLSearchParams({ workspaces: next.workspaces.join(','), mode: next.mode, limit: String(PAGE_SIZE) });
    if (next.mode === 'search') params.set('q', next.q); if (next.kind) params.set('kind', next.kind); params.set('include', 'evidence');
    if (cursor) params.set('cursor', cursor); if (expected) params.set('snapshot', expected);
    fetch(`/api/v1/workspace-graph?${params}`, { signal: controller.signal }).then(async (response) => {
      const value = await response.json(); if (!response.ok) { const err = new Error(value.error ?? 'Workspace graph request failed.'); (err as Error & { code?: string }).code = value.code; throw err; }
      return value as Page;
    }).then((result) => {
      if (controller.signal.aborted || rootController.current !== controller) return;
      setSnapshot(result.snapshotId); setPage((current) => cursor ? current ? { ...result, nodes: mergeNodes(current.nodes, result.nodes), edges: mergeEdges(current.edges, result.edges) } : result : result);
      setRootCursor(result.page.nextCursor); if (!cursor) { setBranches({}); setSelection(undefined); restoredExpanded.current.clear(); }
    }).catch((cause: unknown) => {
      if (controller.signal.aborted || rootController.current !== controller) return;
      const err = cause as Error & { code?: string };
      if (err.code === 'WORKSPACE_GRAPH_SNAPSHOT_CHANGED') { setSnapshot(undefined); setBranches({}); setPage(undefined); setRootCursor(undefined); setSelection(undefined); setError('The active graph changed. The view was reset; reload the page to see the latest snapshot.'); }
      else setError(err.message || 'Workspace graph request failed.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); if (rootController.current === controller) rootController.current = undefined; };
  }, []);
  useEffect(() => { const cleanup = reload(filters); return cleanup; }, [filters.workspaces.join(','), filters.mode, filters.q, filters.kind, refreshKey, reload]);
  useEffect(() => { if (!initialized.current && workspaces.length) { initialized.current = true; setFilters(parseUrlState(workspaces)); } }, [workspaces]);
  useEffect(() => () => { for (const controller of branchControllers.current.values()) controller.abort(); branchControllers.current.clear(); }, [filters.workspaces.join(','), filters.mode, filters.q, filters.kind, refreshKey]);
  useEffect(() => () => { rootController.current?.abort(); }, []);
  useEffect(() => { const onPop = () => {
    const previous = filtersRef.current; const next = parseUrlState(workspaces);
    const sameRoots = JSON.stringify({ workspaces: [...previous.workspaces].sort(), mode: previous.mode, q: previous.q, kind: previous.kind }) === JSON.stringify({ workspaces: [...next.workspaces].sort(), mode: next.mode, q: next.q, kind: next.kind });
    rootController.current?.abort(); rootController.current = undefined; for (const controller of branchControllers.current.values()) controller.abort(); branchControllers.current.clear(); restoredExpanded.current.clear(); restoreFocus.current = Boolean(next.focus); setLoading(false);
    setFilters(next); setBranches({}); setSelection(undefined); setError('');
    setCanvasEdgePage(0);
    if (!sameRoots) { setPage(undefined); setRootCursor(undefined); setSnapshot(undefined); setCanvasPage(0); }
  }; window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, [workspaces]);
  useEffect(() => { setKindDraft(filters.kind); }, [filters.kind]);

  const updateFilters = (next: ViewState) => { rootController.current?.abort(); for (const controller of branchControllers.current.values()) controller.abort(); branchControllers.current.clear(); const reset = { ...next, focus: '', expanded: [], neighbors: [] }; setFilters(reset); syncUrl(reset); setPage(undefined); setRootCursor(undefined); setSnapshot(undefined); setBranches({}); setSelection(undefined); setCanvasPage(0); setCanvasEdgePage(0); restoredExpanded.current.clear(); restoreFocus.current = false; };
  const focusNode = (node: Node) => { restoreFocus.current = false; setCanvasEdgePage(0); setSelection({ node }); const next = { ...filters, focus: node.id }; setFilters(next); syncUrl(next, 'replace'); };
  const focusEdge = (edge: Edge) => { restoreFocus.current = false; setSelection({ edge }); };
  const toggleWorkspace = (id: string) => {
    if (!filters.workspaces.includes(id) && filters.workspaces.length >= 16) return;
    const ids = filters.workspaces.includes(id) ? filters.workspaces.filter((item) => item !== id) : [...filters.workspaces, id];
    updateFilters({ ...filters, workspaces: ids });
  };
  const setMode = (mode: ViewState['mode']) => updateFilters({ ...filters, mode, q: mode === 'search' ? filters.q : '' });
  const search = (event: React.FormEvent) => { event.preventDefault(); updateFilters({ ...filters, mode: 'search', q: (event.currentTarget as HTMLFormElement).elements.namedItem('search') instanceof HTMLInputElement ? ((event.currentTarget as HTMLFormElement).elements.namedItem('search') as HTMLInputElement).value : filters.q }); };

  const fetchBranch = async (path: string, node: Node, cursor?: string, mode: 'children' | 'neighbors' = 'children') => {
    const params = new URLSearchParams({ workspaces: filters.workspaces.join(','), mode, node: node.id, limit: String(PAGE_SIZE) }); if (mode === 'neighbors') params.set('direction', 'both'); if (cursor) params.set('cursor', cursor); if (snapshot) params.set('snapshot', snapshot);
    params.set('include', 'evidence'); branchControllers.current.get(path)?.abort(); const controller = new AbortController(); branchControllers.current.set(path, controller);
    setBranches((current) => ({ ...current, [path]: { ...(current[path] ?? { nodes: [], edges: [] }), nodeId: node.id, mode, loading: true, error: undefined } }));
    try {
      const response = await fetch(`/api/v1/workspace-graph?${params}`, { signal: controller.signal }); const body = await response.json();
      if (controller.signal.aborted || branchControllers.current.get(path) !== controller) return;
      if (!response.ok) { if (body.code === 'WORKSPACE_GRAPH_SNAPSHOT_CHANGED') { setPage(undefined); setSnapshot(undefined); setBranches({}); setRootCursor(undefined); setSelection(undefined); } throw new Error(body.error ?? 'Unable to expand node.'); }
      const result = body as Page;
      if (snapshot && result.snapshotId !== snapshot) { setPage(undefined); setSnapshot(undefined); setBranches({}); setRootCursor(undefined); setSelection(undefined); throw new Error('The active graph changed. The view was reset; reload to continue.'); }
      setSnapshot(result.snapshotId);
      setBranches((current) => { const previous = current[path] ?? { nodes: [], edges: [] }; return { ...current, [path]: { nodes: cursor ? mergeNodes(previous.nodes, result.nodes) : result.nodes.filter((item) => item.id !== node.id), edges: cursor ? mergeEdges(previous.edges, result.edges) : result.edges, cursor: result.page.nextCursor, nodeId: node.id, mode, loading: false } }; });
    } catch (cause) { if (!controller.signal.aborted) setBranches((current) => ({ ...current, [path]: { ...(current[path] ?? { nodes: [], edges: [] }), loading: false, error: (cause as Error).message } })); }
    finally { if (branchControllers.current.get(path) === controller) branchControllers.current.delete(path); }
  };
  useEffect(() => {
    if (restoreFocus.current && filters.focus) { const focused = [...(page?.nodes ?? []), ...Object.values(branches).flatMap((branch) => branch.nodes)].find((node) => node.id === filters.focus); if (focused) { restoreFocus.current = false; setSelection({ node: focused }); } }
    else if (!filters.focus) restoreFocus.current = false;
    const candidates: Array<{ path: string; node: Node }> = (page?.nodes ?? []).map((node) => ({ path: `root:${node.id}`, node }));
    for (const [parentPath, branch] of Object.entries(branches)) for (const edge of branch.edges) {
      const childId = edge.sourceId === branch.nodeId ? edge.targetId : edge.sourceId;
      const child = branch.nodes.find((node) => node.id === childId); if (child) candidates.push({ path: `${parentPath}/${edge.id}`, node: child });
    }
    for (const id of filters.expanded) {
      const candidate = candidates.find((item) => item.node.id === id); if (!candidate || branches[candidate.path] || restoredExpanded.current.has(candidate.path)) continue;
      restoredExpanded.current.add(candidate.path); void fetchBranch(candidate.path, candidate.node);
    }
    for (const id of filters.neighbors) {
      const candidate = candidates.find((item) => item.node.id === id); if (!candidate) continue;
      const path = `${candidate.path}|neighbors`; if (branches[path] || restoredExpanded.current.has(path)) continue;
      restoredExpanded.current.add(path); void fetchBranch(path, candidate.node, undefined, 'neighbors');
    }
  }, [page, branches, filters.focus, filters.expanded.join(','), filters.neighbors.join(','), fetchBranch]);
  const isBranchWithin = (key: string, path: string) => key === path || key === `${path}|neighbors` || key.startsWith(`${path}/`);
  const abortBranchTree = (path: string) => { for (const [key, controller] of branchControllers.current) if (isBranchWithin(key, path)) { controller.abort(); branchControllers.current.delete(key); restoredExpanded.current.delete(key); } };
  const toggleBranch = (path: string, node: Node) => {
    const expanded = filters.expanded.includes(node.id);
    let next = { ...filters, expanded: expanded ? filters.expanded.filter((id) => id !== node.id) : [...filters.expanded.slice(-7), node.id] };
    if (branches[path]) { abortBranchTree(path); restoredExpanded.current.delete(path); const nextBranches = { ...branches }; const removedIds = new Set<string>([node.id]); for (const key of Object.keys(nextBranches)) if (isBranchWithin(key, path)) { if (nextBranches[key].nodeId) removedIds.add(nextBranches[key].nodeId!); delete nextBranches[key]; } next = { ...next, expanded: next.expanded.filter((id) => !removedIds.has(id)), neighbors: next.neighbors.filter((id) => !removedIds.has(id)) }; setFilters(next); syncUrl(next); setBranches(nextBranches); return; }
    setFilters(next); syncUrl(next);
    restoredExpanded.current.add(path);
    void fetchBranch(path, node);
  };
  const toggleNeighbors = (path: string, node: Node) => {
    const isOpen = filters.neighbors.includes(node.id); const nextFilters = { ...filters, neighbors: isOpen ? filters.neighbors.filter((id) => id !== node.id) : [...filters.neighbors.slice(-7), node.id] }; setFilters(nextFilters); syncUrl(nextFilters);
    if (branches[path]) { branchControllers.current.get(path)?.abort(); branchControllers.current.delete(path); restoredExpanded.current.delete(path); setBranches((current) => { const next = { ...current }; delete next[path]; return next; }); return; }
    restoredExpanded.current.add(path);
    void fetchBranch(path, node, undefined, 'neighbors');
  };
  const roots = page?.nodes ?? [];
  const selectedWorkspaces = useMemo(() => new Set(filters.workspaces), [filters.workspaces]);
  const canvasNodeData = useMemo(() => mergeNodes(roots, Object.values(branches).flatMap((branch) => branch.nodes)), [roots, branches]);
  const graphCanvas = useMemo(() => {
    const start = canvasPage * 100; const primaryNodes = canvasNodeData.slice(start, start + 100);
    const allEdges = mergeEdges([...(page?.edges ?? []), ...Object.values(branches).flatMap((branch) => branch.edges)], []).filter((edge) => canvasNodeData.some((node) => node.id === edge.sourceId) && canvasNodeData.some((node) => node.id === edge.targetId));
    const edgeStart = canvasEdgePage * 75; const edges = allEdges.slice(edgeStart, edgeStart + 75);
    const nodeById = new Map(canvasNodeData.map((node) => [node.id, node]));
    const visibleIds = new Set(primaryNodes.map((node) => node.id));
    for (const edge of edges) { if (visibleIds.size >= 250) break; visibleIds.add(edge.sourceId); if (visibleIds.size < 250) visibleIds.add(edge.targetId); }
    const nodes = [...visibleIds].map((id) => nodeById.get(id)).filter((node): node is Node => Boolean(node));
    const positions = new Map(nodes.map((node, index) => [node.id, { x: 125 + (index % 4) * 220, y: 55 + Math.floor(index / 4) * 82 }] as const));
    return { nodes, edges, positions, width: 825, height: Math.max(130, Math.ceil(nodes.length / 4) * 82 + 25), start, end: start + primaryNodes.length, primaryCount: primaryNodes.length, contextCount: Math.max(0, nodes.length - primaryNodes.length), total: canvasNodeData.length, edgeStart, edgeEnd: Math.min(edgeStart + edges.length, allEdges.length), totalEdges: allEdges.length };
  }, [canvasNodeData, page?.edges, branches, canvasPage, canvasEdgePage]);
  const canvasDrag = useRef<{ pointerId: number; x: number; y: number } | undefined>(undefined);
  useEffect(() => {
    const focusIndex = canvasNodeData.findIndex((node) => node.id === filters.focus);
    if (focusIndex >= 0) setCanvasPage((current) => { const next = Math.floor(focusIndex / 100); if (next !== current) setCanvasEdgePage(0); return next; });
    else setCanvasPage((current) => { const next = Math.min(current, Math.max(0, Math.ceil(canvasNodeData.length / 100) - 1)); if (next !== current) setCanvasEdgePage(0); return next; });
  }, [filters.focus, canvasNodeData]);
  useEffect(() => {
    if (!selection?.edge) return;
    const endpointIndex = canvasNodeData.findIndex((node) => node.id === selection.edge!.sourceId || node.id === selection.edge!.targetId);
    if (endpointIndex >= 0 && Math.floor(endpointIndex / 100) !== canvasPage) { setCanvasEdgePage(0); setCanvasPage(Math.floor(endpointIndex / 100)); return; }
    const edgeIndex = graphCanvas.edges.findIndex((edge) => edge.id === selection.edge!.id);
    if (edgeIndex >= 0) return;
    if (graphCanvas.totalEdges > 75) {
      const allVisibleEdges = mergeEdges([...(page?.edges ?? []), ...Object.values(branches).flatMap((branch) => branch.edges)], []).filter((edge) => canvasNodeData.some((node) => node.id === edge.sourceId) && canvasNodeData.some((node) => node.id === edge.targetId));
      const index = allVisibleEdges.findIndex((edge) => edge.id === selection.edge!.id); if (index >= 0) setCanvasEdgePage(Math.floor(index / 75));
    }
  }, [selection?.edge?.id, canvasNodeData, canvasPage, graphCanvas, branches, page?.edges]);
  const panBy = (x: number, y: number) => setCanvasPan((current) => ({ x: Math.max(-1600, Math.min(1600, current.x + x)), y: Math.max(-3200, Math.min(3200, current.y + y)) }));
  const zoomBy = (factor: number) => setCanvasScale((current) => Math.max(0.4, Math.min(2.5, current * factor)));
  const fitCanvas = () => { setCanvasScale(1); setCanvasPan({ x: 0, y: 0 }); };
  const filteredWorkspaces = workspaces.filter((workspace) => workspace.name.toLocaleLowerCase().includes(workspaceFilter.trim().toLocaleLowerCase()));

  const renderNode = (node: Node, path: string, ancestors: Set<string>, depth: number): React.ReactNode => {
    const branch = branches[path];
    const neighborPath = `${path}|neighbors`; const neighbors = branches[neighborPath];
    return <li key={path} className="wg-tree-item" style={{ '--depth': depth } as React.CSSProperties}>
      <div className={`wg-node-row ${selection?.node?.id === node.id ? 'selected' : ''}`}>
        <button className="wg-expand" aria-label={`${branch ? 'Collapse' : 'Expand'} ${node.label}`} aria-expanded={Boolean(branch)} disabled={depth >= 32 || (!branch && filters.expanded.length >= 8)} onClick={() => toggleBranch(path, node)}>{branch ? '−' : '+'}</button>
        <button className="wg-node-select" onClick={() => focusNode(node)}><span className="wg-label">{node.label || '(unlabelled fact)'}</span><span className="wg-kind">{node.kind}</span></button>
        <button className="wg-neighbor-toggle" aria-expanded={Boolean(neighbors)} aria-label={`Show neighbors of ${node.label}`} disabled={!neighbors && Object.keys(branches).length >= 8} onClick={() => toggleNeighbors(neighborPath, node)}>{neighbors ? 'Hide neighbors' : 'Neighbors'}</button>
      </div>
      {branch?.loading && <p className="wg-inline-state" role="status">Loading children…</p>}
      {branch?.error && <p className="wg-error" role="alert">{branch.error}</p>}
      {!!branch?.edges.length && <ul className="wg-tree">{branch.edges.map((edge) => {
        const childId = edge.sourceId === node.id ? edge.targetId : edge.sourceId; const child = branch.nodes.find((item) => item.id === childId);
        return <li key={edge.id} className="wg-edge-row"><button className="wg-edge-select" onClick={() => focusEdge(edge)}>{edge.kind} · {edge.sourceId === node.id ? 'outgoing' : 'incoming'}</button>{child && (ancestors.has(child.id) ? <span className="wg-cycle">Cycle to {child.label}</span> : renderNode(child, `${path}/${edge.id}`, new Set([...ancestors, child.id]), depth + 1))}</li>;
      })}</ul>}
      {branch?.cursor && <button className="wg-more-child" onClick={() => void fetchBranch(path, node, branch.cursor)}>{branch.mode === 'neighbors' ? 'Load more neighbors' : 'Load more children'}</button>}
      {neighbors?.loading && <p className="wg-inline-state" role="status">Loading neighbors…</p>}
      {neighbors?.error && <p className="wg-error" role="alert">{neighbors.error}</p>}
      {!!neighbors?.edges.length && <ul className="wg-neighbors">{neighbors.edges.map((edge) => {
        const neighborId = edge.sourceId === node.id ? edge.targetId : edge.sourceId; const neighbor = neighbors.nodes.find((item) => item.id === neighborId);
        return <li key={edge.id}><button className="wg-edge-select" onClick={() => focusEdge(edge)}>{edge.kind} · {edge.sourceId === node.id ? 'outgoing' : 'incoming'}</button>{neighbor && <button className="wg-neighbor-node" onClick={() => focusNode(neighbor)}>{neighbor.label || '(unlabelled fact)'} <span>{neighbor.kind}</span></button>}</li>;
      })}</ul>}
      {neighbors?.cursor && <button className="wg-more-child" onClick={() => void fetchBranch(neighborPath, node, neighbors.cursor, 'neighbors')}>Load more neighbors</button>}
    </li>;
  };

  return <section className="wg-layout" aria-label="Workspace graph explorer">
    <aside className="wg-controls"><h1>Workspace</h1><p className="wg-muted">Explore facts from active analyzers in registered workspaces.</p>
      <fieldset><legend>Workspaces ({filters.workspaces.length}/16)</legend>{workspaces.length ? <><label className="wg-workspace-filter">Filter workspaces<input type="search" value={workspaceFilter} onChange={(event) => setWorkspaceFilter(event.target.value)} maxLength={128}/></label>{filteredWorkspaces.map((workspace) => <label className="wg-check" key={workspace.id}><input type="checkbox" checked={selectedWorkspaces.has(workspace.id)} disabled={!selectedWorkspaces.has(workspace.id) && filters.workspaces.length >= 16} onChange={() => toggleWorkspace(workspace.id)}/><span>{workspace.name}</span></label>)}{filteredWorkspaces.length === 0 && <p className="wg-muted">No matching workspaces.</p>}</> : <p className="wg-muted">No registered workspaces.</p>}</fieldset>
      <div className="wg-modes" role="group" aria-label="Graph view mode"><button aria-pressed={filters.mode === 'roots'} onClick={() => setMode('roots')}>Roots</button><button aria-pressed={filters.mode === 'search'} onClick={() => setMode('search')}>Search</button></div>
      {filters.mode === 'search' && <form className="wg-search" onSubmit={search}><label htmlFor="wg-search-input">Literal label search</label><input key={filters.q} id="wg-search-input" name="search" maxLength={256} defaultValue={filters.q} placeholder="Search labels"/><button type="submit">Search</button></form>}
      <label className="wg-kind-filter">Exact kind filter<input value={kindDraft} maxLength={128} onChange={(event) => setKindDraft(event.target.value)} onBlur={() => { if (kindDraft !== filters.kind) updateFilters({ ...filters, kind: kindDraft }); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); updateFilters({ ...filters, kind: kindDraft }); } }}/></label>
      {page && <div className="wg-snapshot"><strong>{page.nodes.length} shown</strong><span>{page.generations.length} active analyzer generation(s)</span></div>}
    </aside>
    <section className="wg-results" aria-label="Workspace facts">
      {!filters.workspaces.length ? <div className="wg-empty"><h2>Select a workspace</h2><p>Choose one or more registered workspaces to browse available facts.</p></div> : filters.mode === 'search' && !filters.q.trim() ? <div className="wg-empty"><h2>Enter a search term</h2><p>Search uses literal label text.</p></div> : null}
      {loading && <p className="wg-status" role="status">Loading workspace facts…</p>}
      {error && <div className="wg-error" role="alert"><p>{error}</p><button onClick={() => { setSnapshot(undefined); setPage(undefined); reload(filters); }}>Reload</button></div>}
      {!loading && !error && filters.workspaces.length > 0 && (filters.mode !== 'search' || filters.q.trim()) && roots.length === 0 && <div className="wg-empty"><h2>No facts found</h2><p>Run an available analyzer or adjust the selected workspaces and filters.</p></div>}
      {graphCanvas.nodes.length > 0 && <div className="wg-canvas-wrap"><h2>Graph canvas</h2><div className="wg-canvas-toolbar" role="group" aria-label="Graph canvas controls">
        <button aria-label="Zoom in" onClick={() => zoomBy(1.2)}>Zoom in</button><button aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>Zoom out</button>
        <button aria-label="Pan left" onClick={() => panBy(80, 0)}>←</button><button aria-label="Pan right" onClick={() => panBy(-80, 0)}>→</button><button aria-label="Pan up" onClick={() => panBy(0, 80)}>↑</button><button aria-label="Pan down" onClick={() => panBy(0, -80)}>↓</button><button onClick={fitCanvas}>Fit</button>
        <span className="wg-canvas-count" aria-live="polite">Primary nodes {graphCanvas.total === 0 ? 0 : graphCanvas.start + 1}–{graphCanvas.end} of {graphCanvas.total}; {graphCanvas.contextCount} relationship context nodes</span>
        {graphCanvas.total > 100 && <><button disabled={canvasPage === 0} onClick={() => { setCanvasPage((current) => Math.max(0, current - 1)); setCanvasEdgePage(0); }}>Previous nodes</button><button disabled={graphCanvas.end >= graphCanvas.total} onClick={() => { setCanvasPage((current) => current + 1); setCanvasEdgePage(0); }}>Next nodes</button></>}
        <span className="wg-canvas-count" aria-live="polite">Showing {graphCanvas.totalEdges === 0 ? 0 : graphCanvas.edgeStart + 1}–{graphCanvas.edgeEnd} of {graphCanvas.totalEdges} relationships on this node page</span>
        {graphCanvas.totalEdges > 75 && <><button disabled={canvasEdgePage === 0} onClick={() => setCanvasEdgePage((current) => Math.max(0, current - 1))}>Previous relationships</button><button disabled={graphCanvas.edgeEnd >= graphCanvas.totalEdges} onClick={() => setCanvasEdgePage((current) => current + 1)}>Next relationships</button></>}
      </div><p className="wg-canvas-help">Each canvas page shows up to 100 primary nodes, 250 nodes including relationship endpoints, and 75 relationships. Relationship pages cover all relationships among loaded nodes, including relationships between context nodes and across primary node pages. Use the node and relationship page controls to browse larger loaded neighborhoods. Drag to pan or use the controls. Selecting a node in the list or canvas brings it into view.</p><svg className="wg-canvas" viewBox={`0 0 ${graphCanvas.width} ${graphCanvas.height}`} role="group" aria-label="Bounded workspace graph canvas" onWheel={(event) => { event.preventDefault(); zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1); }} onPointerDown={(event) => { if ((event.target as Element).closest('.wg-canvas-node')) return; canvasDrag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { const drag = canvasDrag.current; if (!drag || drag.pointerId !== event.pointerId) return; const rect = event.currentTarget.getBoundingClientRect(); const dx = (event.clientX - drag.x) * graphCanvas.width / rect.width / canvasScale; const dy = (event.clientY - drag.y) * graphCanvas.height / rect.height / canvasScale; canvasDrag.current = { ...drag, x: event.clientX, y: event.clientY }; panBy(dx, dy); }} onPointerUp={(event) => { if (canvasDrag.current?.pointerId === event.pointerId) canvasDrag.current = undefined; }} onPointerCancel={() => { canvasDrag.current = undefined; }}>
        <g transform={`translate(${canvasPan.x} ${canvasPan.y}) scale(${canvasScale})`}>
          {graphCanvas.edges.map((edge) => { const source = graphCanvas.positions.get(edge.sourceId); const target = graphCanvas.positions.get(edge.targetId); return source && target ? <g key={edge.id} aria-hidden="true"><line x1={source.x} y1={source.y} x2={target.x} y2={target.y}/><text x={(source.x + target.x) / 2} y={(source.y + target.y) / 2 - 4}>{edge.kind}</text></g> : null; })}
          {graphCanvas.nodes.map((node) => { const point = graphCanvas.positions.get(node.id)!; return <g key={node.id} className={`wg-canvas-node ${filters.focus === node.id ? 'focused' : ''}`} role="button" tabIndex={0} aria-label={`${node.label}, ${node.kind}`} onClick={() => focusNode(node)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusNode(node); } }}><title>{`${node.label} · ${node.kind}`}</title><rect x={point.x - 95} y={point.y - 19} width="190" height="38" rx="7"/><text x={point.x} y={point.y - 2}>{node.label || '(unlabelled fact)'}</text><text className="wg-canvas-kind" x={point.x} y={point.y + 12}>{node.kind}</text></g>; })}
        </g>
      </svg></div>}
      {roots.length > 0 && <ul className="wg-tree wg-root-list">{roots.map((node) => renderNode(node, `root:${node.id}`, new Set([node.id]), 0))}</ul>}
      {rootCursor && <button className="wg-load-more" disabled={loading} onClick={() => reload(filters, rootCursor, snapshot)}>Load more facts</button>}
      {page && <div className="wg-source-note">Facts are attributed only to the analyzer and evidence recorded with each result. No additional source or directory facts are inferred here.</div>}
    </section>
    <aside className="wg-inspector"><h2>{selection?.edge ? 'Relationship' : 'Fact details'}</h2>{selection?.node ? <><h3>{selection.node.label || '(unlabelled fact)'}</h3><p><code>{selection.node.kind}</code></p><Metadata node={selection.node}/><h3>Properties</h3><pre>{JSON.stringify(selection.node.properties, null, 2)}</pre><EvidenceList item={selection.node} generations={page?.generations ?? []} evidence={selection.node.evidence ?? []} count={selection.node.evidenceCount}/></> : selection?.edge ? <><h3>{selection.edge.kind}</h3><p>{selection.edge.sourceId} → {selection.edge.targetId}</p><Metadata node={selection.edge}/><h3>Properties</h3><pre>{JSON.stringify(selection.edge.properties, null, 2)}</pre><EvidenceList item={selection.edge} generations={page?.generations ?? []} evidence={selection.edge.evidence ?? []} count={selection.edge.evidenceCount}/></> : <p className="wg-muted">Select a fact or relationship to inspect its stored properties and evidence.</p>}</aside>
  </section>;
}
function Metadata({ node }: { node: { workspaceId: string; analyzerId: string; generationId: number; level: string } }) { return <dl className="wg-meta"><dt>Workspace</dt><dd>{node.workspaceId}</dd><dt>Analyzer</dt><dd>{node.analyzerId}</dd><dt>Generation</dt><dd>{node.generationId}</dd><dt>Evidence level</dt><dd>{node.level}</dd></dl>; }
function EvidenceList({ item, generations, evidence, count }: { item: Node | Edge; generations: Page['generations']; evidence: Evidence[]; count: number }) { return <><h3>Evidence ({count})</h3>{count === 0 ? <p className="wg-muted">No evidence was recorded.</p> : !evidence.length ? <p className="wg-muted">Evidence is available through the include=evidence query.</p> : <ul className="wg-evidence">{evidence.map((entry) => { const provenance = entry.provenance; const sources = provenance && typeof provenance.analyzerId === 'string' && typeof provenance.generationId === 'number' && typeof provenance.sourceEvidenceId === 'string' ? [{ workspaceId: item.workspaceId, analyzerId: provenance.analyzerId, generationId: provenance.generationId, evidenceId: provenance.sourceEvidenceId }] : provenance && Array.isArray(provenance.sources) ? provenance.sources.flatMap(value => { if (!value || typeof value !== 'object') return []; const source = value as Record<string, unknown>; const generation = generations.find(candidate => candidate.workspaceId === item.workspaceId && candidate.analyzerId === source.analyzerId); return generation && typeof source.analyzerId === 'string' && typeof source.evidenceId === 'string' ? [{ workspaceId: item.workspaceId, analyzerId: source.analyzerId, generationId: generation.generationId, evidenceId: source.evidenceId }] : []; }) : entry.uri && entry.analyzerId && entry.generationId ? [{ workspaceId: item.workspaceId, analyzerId: entry.analyzerId, generationId: entry.generationId, evidenceId: entry.id }] : []; return <li key={entry.id}><strong>{entry.type}</strong><span>{entry.uri ?? 'No source location recorded'}{entry.line ? `:${entry.line}` : ''}</span>{entry.detail && <p>{entry.detail}</p>}{sources.length ? sources.map(source => <SourceEvidenceButton key={`${source.analyzerId}:${source.generationId}:${source.evidenceId}`} source={source}/>) : <span>Source file unavailable for this evidence.</span>}</li>; })}</ul>}</>; }
function mergeNodes(a: Node[], b: Node[]) { const map = new Map(a.map((item) => [item.id, item])); for (const item of b) map.set(item.id, item); return [...map.values()]; }
function mergeEdges(a: Edge[], b: Edge[]) { const map = new Map(a.map((item) => [item.id, item])); for (const item of b) map.set(item.id, item); return [...map.values()]; }
