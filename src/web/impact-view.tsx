import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImpactGraph } from './impact-graph.js';
import { ImpactInspector } from './impact-inspector.js';
import type { ImpactEdge, ImpactNode, ImpactResult, RootPage } from './impact-types.js';
import './impact.css';

type Workspace = { id: string; name: string };
type Filters = { workspaces: string[]; root: 'contract' | 'endpoint'; namespace: string; method: string; path: string; target: string; direction: 'dependents' | 'dependencies' | 'both'; depth: number; limit: number; includeInferred: boolean; includeEvidence: boolean; includeDiagnostics: boolean };
type Failure = { status: number; code?: string; message: string };
const methods = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'];
const initial: Filters = { workspaces: [], root: 'contract', namespace: '', method: '', path: '', target: '', direction: 'both', depth: 4, limit: 500, includeInferred: false, includeEvidence: false, includeDiagnostics: false };

function readFilters(): Filters {
  const params = new URLSearchParams(location.search);
  const ids = (params.get('impactWorkspaces') ?? '').split(',').filter(Boolean);
  const direction = params.get('impactDirection');
  const root = params.get('impactRoot');
  const depth = Number(params.get('impactDepth') ?? initial.depth), limit = Number(params.get('impactLimit') ?? initial.limit);
  return { ...initial, workspaces: [...new Set(ids)].slice(0, 16), root: root === 'endpoint' ? 'endpoint' : 'contract', namespace: (params.get('impactNamespace') ?? '').slice(0, 256), method: methods.includes(params.get('impactMethod') ?? '') ? params.get('impactMethod')! : '', path: (params.get('impactPath') ?? '').slice(0, 2048), target: params.get('impactNode') ?? '', direction: direction === 'dependents' || direction === 'dependencies' ? direction : 'both', depth: Number.isInteger(depth) && depth >= 1 && depth <= 8 ? depth : 4, limit: Number.isInteger(limit) && limit >= 1 && limit <= 2000 ? limit : 500, includeInferred: params.get('impactInferred') === 'true', includeEvidence: params.get('impactEvidence') === 'true', includeDiagnostics: params.get('impactDiagnostics') === 'true' };
}
function writeFilters(filters: Filters) {
  const params = new URLSearchParams(location.search);
  params.set('view', 'impact');
  for (const key of ['impactWorkspaces', 'impactRoot', 'impactNamespace', 'impactMethod', 'impactPath', 'impactNode', 'impactDirection', 'impactDepth', 'impactLimit', 'impactInferred', 'impactEvidence', 'impactDiagnostics']) params.delete(key);
  if (filters.workspaces.length) params.set('impactWorkspaces', [...filters.workspaces].sort().join(','));
  params.set('impactRoot', filters.root); if (filters.namespace) params.set('impactNamespace', filters.namespace); if (filters.method) params.set('impactMethod', filters.method); if (filters.path) params.set('impactPath', filters.path); if (filters.target) params.set('impactNode', filters.target);
  params.set('impactDirection', filters.direction); params.set('impactDepth', String(filters.depth)); params.set('impactLimit', String(filters.limit)); params.set('impactInferred', String(filters.includeInferred)); params.set('impactEvidence', String(filters.includeEvidence)); params.set('impactDiagnostics', String(filters.includeDiagnostics));
  window.history.replaceState({}, '', `${location.pathname}?${params}`);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
const levels = ['DIRECT', 'DERIVED', 'INFERRED'];
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }
function isScope(value: unknown): boolean { return isRecord(value) && isStringArray(value.workspaceIds) && isStringArray(value.missingArchitectureWorkspaceIds) && Array.isArray(value.workspaces) && value.workspaces.every((item) => isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string'); }
function isGeneration(value: unknown): boolean { return isRecord(value) && typeof value.workspaceId === 'string' && typeof value.analyzerId === 'string' && Number.isSafeInteger(value.generationId) && typeof value.runId === 'string' && typeof value.completedAt === 'string' && (value.sourceRevision === undefined || typeof value.sourceRevision === 'string'); }
function isInputGeneration(value: unknown): boolean { return isRecord(value) && typeof value.workspaceId === 'string' && typeof value.analyzerId === 'string' && Number.isSafeInteger(value.generationId); }
function isNode(value: unknown): boolean { return isRecord(value) && typeof value.id === 'string' && (value.scope === 'workspace' ? typeof value.workspaceId === 'string' : value.scope === 'global' && value.workspaceId === undefined) && typeof value.kind === 'string' && typeof value.label === 'string' && isRecord(value.properties) && levels.includes(String(value.level)); }
function isEvidenceSource(value: unknown): boolean { return isRecord(value) && typeof value.workspaceId === 'string' && typeof value.analyzerId === 'string' && Number.isSafeInteger(value.generationId) && typeof value.nodeId === 'string' && isStringArray(value.evidenceIds); }
function isEvidence(value: unknown): boolean { return isRecord(value) && typeof value.id === 'string' && typeof value.subjectId === 'string' && (value.subjectKind === 'node' || value.subjectKind === 'edge') && typeof value.type === 'string' && levels.includes(String(value.level)) && Array.isArray(value.sources) && value.sources.every(isEvidenceSource); }
function parseFailure(body: unknown, status: number): Failure { const payload = isRecord(body) ? body : {}; return { status, ...(typeof payload.code === 'string' ? { code: payload.code } : {}), message: typeof payload.error === 'string' ? payload.error : 'The impact request failed.' }; }
function parseRoots(body: unknown): RootPage {
  if (!isRecord(body) || !isStringArray(body.rootIds) || !Array.isArray(body.nodes) || !Array.isArray(body.edges) || !isRecord(body.page) || !Number.isSafeInteger(body.page.totalRootCount) || !isScope(body.scope) || !isRecord(body.snapshot) || typeof body.snapshot.id !== 'string' || !Array.isArray(body.snapshot.generations) || !body.snapshot.generations.every(isGeneration) || !Array.isArray(body.snapshot.inputGenerations) || !body.snapshot.inputGenerations.every(isInputGeneration)) throw new Error('Target discovery returned an invalid response.');
  const nodeIds = new Set(body.nodes.filter(isNode).map((node) => node.id));
  if (!body.nodes.every(isNode) || body.rootIds.some((id) => !nodeIds.has(id)) || !body.edges.every((edge) => isRecord(edge) && typeof edge.id === 'string' && (edge.scope === 'workspace' || edge.scope === 'cross-workspace') && typeof edge.sourceId === 'string' && typeof edge.targetId === 'string' && nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId) && typeof edge.kind === 'string' && levels.includes(String(edge.level)) && isRecord(edge.properties) && Array.isArray(edge.evidence) && edge.evidence.every(isEvidence)) || (body.page.nextCursor !== undefined && typeof body.page.nextCursor !== 'string') || !Number.isSafeInteger(body.page.rootCount)) throw new Error('Target discovery returned invalid graph data.');
  return body as unknown as RootPage;
}
function parseImpact(body: unknown): ImpactResult {
  if (!isRecord(body) || !isRecord(body.snapshot) || typeof body.snapshot.id !== 'string' || !Array.isArray(body.snapshot.generations) || !body.snapshot.generations.every(isGeneration) || !Array.isArray(body.snapshot.inputGenerations) || !body.snapshot.inputGenerations.every(isInputGeneration) || !isRecord(body.summary) || !['impactedNodeCount', 'edgeCount', 'workspaceCount', 'maxDistance', 'inferredPathCount'].every((key) => Number.isSafeInteger(body.summary[key])) || !isRecord(body.target) || !isScope(body.scope) || !isRecord(body.query) || !['dependents', 'dependencies', 'both'].includes(String(body.query.direction)) || !Number.isSafeInteger(body.query.depth) || typeof body.query.node !== 'string' || !Array.isArray(body.nodes) || !Array.isArray(body.edges) || !Array.isArray(body.paths) || !Array.isArray(body.findings) || (body.evidence !== undefined && !Array.isArray(body.evidence)) || (body.diagnostics !== undefined && !Array.isArray(body.diagnostics))) throw new Error('The impact API returned an invalid response.');
  const nodeIds = new Set(body.nodes.filter(isRecord).map((node) => node.id));
  const validEdge = (edge: unknown) => isRecord(edge) && typeof edge.id === 'string' && (edge.scope === 'workspace' || edge.scope === 'cross-workspace') && typeof edge.sourceId === 'string' && typeof edge.targetId === 'string' && nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId) && typeof edge.kind === 'string' && levels.includes(String(edge.level)) && isRecord(edge.properties) && Array.isArray(edge.evidence) && edge.evidence.every(isEvidence);
  const validImpactNode = (node: unknown) => isNode(node) && Number.isSafeInteger(node.distance) && ['target', 'dependent', 'dependency'].includes(String(node.impactRole));
  if (!body.nodes.every(validImpactNode) || !body.edges.every(validEdge) || !isNode(body.target) || !body.paths.every((path) => isRecord(path) && typeof path.nodeId === 'string' && isStringArray(path.nodeIds) && isStringArray(path.edgeIds) && isStringArray(path.workspaceIds) && levels.includes(String(path.level)) && path.nodeIds.every((id) => nodeIds.has(id)) && path.edgeIds.every((id) => body.edges.some((edge) => isRecord(edge) && edge.id === id))) || !body.findings.every(isNode) || (body.evidence !== undefined && !body.evidence.every(isEvidence)) || (body.diagnostics !== undefined && !body.diagnostics.every((item) => isRecord(item) && typeof item.severity === 'string' && typeof item.message === 'string'))) throw new Error('The impact API returned invalid graph data.');
  return body as unknown as ImpactResult;
}

export function ImpactView({ workspaces }: { workspaces: Workspace[] }) {
  const [filters, setFilters] = useState<Filters>(() => readFilters());
  const [targets, setTargets] = useState<RootPage>();
  const [rootNodes, setRootNodes] = useState<RootPage['nodes']>([]);
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [targetLoading, setTargetLoading] = useState(false);
  const [targetError, setTargetError] = useState<Failure>();
  const [impact, setImpact] = useState<ImpactResult>();
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure>();
  const [selected, setSelected] = useState<ImpactNode | ImpactEdge>();
  const [pathId, setPathId] = useState('');
  const [showTargetLimit, setShowTargetLimit] = useState(false);
  const [targetPaginationStopped, setTargetPaginationStopped] = useState(false);
  const [impactRetryNonce, setImpactRetryNonce] = useState(0);
  const targetSequence = useRef(0), impactSequence = useRef(0);
  const targetAbort = useRef<AbortController>(), impactAbort = useRef<AbortController>();
  const workspaceKey = [...filters.workspaces].sort().join(',');
  const targetQuery = useMemo(() => {
    const params = new URLSearchParams({ workspaces: workspaceKey, root: filters.root, depth: '0', limit: '100' });
    if (filters.namespace) params.set('namespace', filters.namespace); if (filters.method) params.set('method', filters.method); if (filters.path) params.set('path', filters.path);
    return params;
  }, [workspaceKey, filters.root, filters.namespace, filters.method, filters.path]);
  const queryKey = useMemo(() => JSON.stringify({ workspaceKey, node: filters.target, direction: filters.direction, depth: filters.depth, limit: filters.limit, inferred: filters.includeInferred, evidence: filters.includeEvidence, diagnostics: filters.includeDiagnostics, retry: impactRetryNonce }), [workspaceKey, filters, impactRetryNonce]);
  const update = (patch: Partial<Filters>, clearTarget = false) => setFilters((current) => { const next = { ...current, ...patch, ...(clearTarget ? { target: '' } : {}) }; writeFilters(next); return next; });
  const loadTargetPage = useCallback(async (cursor?: string, append = false) => {
    if (filters.workspaces.length < 2 || filters.workspaces.length > 16) { setTargets(undefined); setRootNodes([]); setTargetError(undefined); return; }
    const request = ++targetSequence.current; targetAbort.current?.abort(); const controller = new AbortController(); targetAbort.current = controller;
    setTargetLoading(true); setTargetError(undefined);
    const params = new URLSearchParams(targetQuery); if (cursor) params.set('cursor', cursor);
    try {
      const response = await fetch(`/api/v1/cross-workspace/architecture?${params}`, { signal: controller.signal });
      const body: unknown = await response.json(); if (request !== targetSequence.current) return;
      if (!response.ok) throw parseFailure(body, response.status);
      const page = parseRoots(body); setTargets((current) => append && current ? { ...page, rootIds: [...new Set([...current.rootIds, ...page.rootIds])], nodes: [...current.nodes, ...page.nodes.filter((node) => !current.nodes.some((item) => item.id === node.id))] } : page); setTargetIds((current) => append ? [...new Set([...current, ...page.rootIds])] : page.rootIds); setRootNodes((current) => append ? [...current, ...page.nodes.filter((node) => !current.some((item) => item.id === node.id))] : page.nodes); setShowTargetLimit(append || !page.page.nextCursor); if (!append) setTargetPaginationStopped(false);
    } catch (error) { if (request === targetSequence.current && !controller.signal.aborted) { setTargetError(isRecord(error) ? error as Failure : { status: 500, message: error instanceof Error ? error.message : 'Target discovery failed.' }); if (cursor) { setTargetPaginationStopped(true); setShowTargetLimit(false); setTargets((current) => current ? { ...current, page: { ...current.page, nextCursor: undefined } } : current); } } }
    finally { if (request === targetSequence.current) setTargetLoading(false); }
  }, [filters.workspaces, targetQuery]);
  const restartTargetDiscovery = () => {
    setTargetPaginationStopped(false); setTargets(undefined); setRootNodes([]); setTargetIds([]); setShowTargetLimit(false);
    void loadTargetPage();
  };
  useEffect(() => {
    setTargets(undefined); setRootNodes([]); setTargetIds([]); setTargetPaginationStopped(false); setTargetError(undefined); setImpact(undefined); setFailure(undefined); setSelected(undefined); setPathId('');
    const timer = window.setTimeout(() => void loadTargetPage(), 200);
    return () => { window.clearTimeout(timer); targetSequence.current++; targetAbort.current?.abort(); };
  }, [loadTargetPage]);
  useEffect(() => {
    if (filters.target && !targetIds.includes(filters.target) && targets?.page.nextCursor && !targetLoading && !targetPaginationStopped) void loadTargetPage(targets.page.nextCursor, true);
  }, [filters.target, targetIds, targets, targetLoading, targetPaginationStopped, loadTargetPage]);
  useEffect(() => {
    impactSequence.current++; impactAbort.current?.abort(); setImpact(undefined); setFailure(undefined); setSelected(undefined); setPathId('');
    if (!filters.target || filters.workspaces.length < 2 || filters.workspaces.length > 16) { setLoading(false); return; }
    const timer = window.setTimeout(async () => {
      const request = ++impactSequence.current; const controller = new AbortController(); impactAbort.current = controller; setLoading(true);
      const params = new URLSearchParams({ workspaces: workspaceKey, node: filters.target, direction: filters.direction, depth: String(filters.depth), limit: String(filters.limit), includeInferred: String(filters.includeInferred) });
      const include = [filters.includeEvidence && 'evidence', filters.includeDiagnostics && 'diagnostics'].filter(Boolean).join(','); if (include) params.set('include', include);
      try {
        const response = await fetch(`/api/v1/impact?${params}`, { signal: controller.signal }); const body: unknown = await response.json(); if (request !== impactSequence.current) return;
        if (!response.ok) throw parseFailure(body, response.status); setImpact(parseImpact(body)); setFailure(undefined);
      } catch (error) { if (request === impactSequence.current && !controller.signal.aborted) setFailure(isRecord(error) ? error as Failure : { status: 500, message: error instanceof Error ? error.message : 'Impact query failed.' }); }
      finally { if (request === impactSequence.current) setLoading(false); }
    }, 150);
    return () => { window.clearTimeout(timer); impactSequence.current++; impactAbort.current?.abort(); };
  }, [queryKey]);
  useEffect(() => {
    const onPop = () => { setFilters(readFilters()); setImpact(undefined); setTargets(undefined); setRootNodes([]); setTargetIds([]); };
    addEventListener('popstate', onPop); return () => removeEventListener('popstate', onPop);
  }, [workspaces]);
  useEffect(() => () => { targetSequence.current++; impactSequence.current++; targetAbort.current?.abort(); impactAbort.current?.abort(); }, []);
  const targetOptions = useMemo(() => rootNodes.filter((node) => targetIds.includes(node.id)), [rootNodes, targetIds]);
  const selectedTarget = targetOptions.find((node) => node.id === filters.target);
  const unknownWorkspaceIds = filters.workspaces.filter((id) => !workspaces.some((workspace) => workspace.id === id));
  const [announcement, setAnnouncement] = useState('');
  const handleSelect = useCallback((item: ImpactNode | ImpactEdge) => { setSelected(item); setAnnouncement('distance' in item ? `Selected ${item.impactRole} node ${item.label}, ${item.level} evidence, distance ${item.distance}.` : `Selected ${item.kind} relationship, ${item.level} evidence.`); }, []);
  const toggleWorkspace = (id: string, checked: boolean) => {
    const next = checked ? [...filters.workspaces, id] : filters.workspaces.filter((item) => item !== id);
    if (next.length <= 16) update({ workspaces: next }, true);
  };
  const chooseTarget = (target: string) => update({ target });
  const titleForNode = (id: string) => impact?.nodes.find((node) => node.id === id)?.label ?? id;
  const activePath = impact?.paths.find((path) => path.nodeId === pathId);
  const workspaceNames = useMemo(() => new Map(impact?.scope.workspaces.map((workspace) => [workspace.id, workspace.name]) ?? []), [impact]);
  return <section className="impact-view" aria-labelledby="impact-title">
    <div className="impact-heading"><div><p className="eyebrow">CROSS-WORKSPACE ANALYSIS</p><h1 id="impact-title">Impact</h1><p className="impact-muted">Trace architecture dependencies in either direction across selected workspace snapshots.</p></div><p className="impact-snapshot">{impact ? `Snapshot ${impact.snapshot.id.slice(0, 12)}` : 'Atomic architecture snapshot'}</p></div>
    <section className="impact-controls" aria-label="Impact query controls">
      <fieldset className="impact-workspaces"><legend>Workspaces · choose 2–16</legend>{workspaces.length ? workspaces.map((workspace) => <label key={workspace.id}><input type="checkbox" checked={filters.workspaces.includes(workspace.id)} disabled={!filters.workspaces.includes(workspace.id) && filters.workspaces.length >= 16} onChange={(event) => toggleWorkspace(workspace.id, event.target.checked)}/><span>{workspace.name}</span></label>) : <p className="impact-muted">No saved workspaces.</p>}{unknownWorkspaceIds.map((id) => <label key={id} className="impact-unknown-workspace"><input type="checkbox" checked onChange={() => update({ workspaces: filters.workspaces.filter((item) => item !== id) }, true)}/><span>Unavailable workspace: <code>{id}</code> · remove</span></label>)}</fieldset>
      <label>Target type<select value={filters.root} onChange={(event) => update({ root: event.target.value as Filters['root'] }, true)}><option value="contract">Shared API contract</option><option value="endpoint">Workspace endpoint</option></select></label>
      <label>Exact namespace<input value={filters.namespace} maxLength={256} onChange={(event) => update({ namespace: event.target.value }, true)} placeholder="payments"/></label>
      <label>Exact method<select value={filters.method} onChange={(event) => update({ method: event.target.value }, true)}><option value="">Any method</option>{methods.map((method) => <option key={method}>{method}</option>)}</select></label>
      <label>Exact path<input value={filters.path} maxLength={2048} onChange={(event) => update({ path: event.target.value }, true)} placeholder="/v1/orders"/></label>
      <label className="impact-target-select">Target<select value={filters.target} onChange={(event) => chooseTarget(event.target.value)} disabled={!targetOptions.length}><option value="">Choose an available target</option>{targetOptions.map((node) => <option key={node.id} value={node.id}>{node.label} · {node.kind}{node.scope === 'workspace' ? ` · ${workspaces.find((item) => item.id === node.workspaceId)?.name ?? node.workspaceId}` : ' · global contract'}</option>)}</select></label>
      <label>Direction<select value={filters.direction} onChange={(event) => update({ direction: event.target.value as Filters['direction'] })}><option value="both">Both directions</option><option value="dependents">Dependents</option><option value="dependencies">Dependencies</option></select></label>
      <label>Depth <output>{filters.depth}</output><input type="range" min="1" max="8" value={filters.depth} onChange={(event) => update({ depth: Number(event.target.value) })}/></label>
      <label>Node limit<select value={filters.limit} onChange={(event) => update({ limit: Number(event.target.value) })}><option value="500">500 · default</option><option value="1000">1,000</option><option value="2000">2,000 · hard ceiling</option></select></label>
      <label className="impact-check"><input type="checkbox" checked={filters.includeInferred} onChange={(event) => update({ includeInferred: event.target.checked })}/>Include inferred relationships</label>
      <label className="impact-check"><input type="checkbox" checked={filters.includeEvidence} onChange={(event) => update({ includeEvidence: event.target.checked })}/>Include evidence</label>
      <label className="impact-check"><input type="checkbox" checked={filters.includeDiagnostics} onChange={(event) => update({ includeDiagnostics: event.target.checked })}/>Include diagnostics</label>
    </section>
    {workspaces.length > 0 && filters.workspaces.length < 2 && <p className="impact-message" role="status">Choose at least two workspaces to load cross-workspace targets.</p>}
    {filters.workspaces.length > 16 && <p className="impact-message" role="alert">Select no more than 16 workspaces.</p>}
    {targetLoading && <p className="impact-message" role="status" aria-live="polite">Loading target choices…</p>}
    {!workspaces.length && <p className="impact-message" role="status">No saved workspaces are available. Add workspaces and run the architecture analyzer before tracing impact.</p>}
    {targetError && <ImpactError failure={targetError} onRetry={restartTargetDiscovery} targetDiscovery/ >}
    {targets && targets.scope.missingArchitectureWorkspaceIds.length > 0 && <p className="impact-notice">Registered workspace(s) without an active architecture generation: {targets.scope.missingArchitectureWorkspaceIds.map((id) => workspaces.find((workspace) => workspace.id === id)?.name ?? id).join(', ')}.</p>}
    {targets && targets.page.totalRootCount === 0 && !targetLoading && <p className="impact-message" role="status">No target matches these exact filters. Adjust the target type or filters.</p>}
    {targets?.page.nextCursor && <div className="impact-target-more"><span>{targetOptions.length} of {targets.page.totalRootCount} matching targets loaded</span><button type="button" disabled={targetLoading} onClick={() => void loadTargetPage(targets.page.nextCursor, true)}>Load more targets</button></div>}
    {targetPaginationStopped && targets && <p className="impact-muted" role="status">{targetOptions.length} of {targets.page.totalRootCount} matching targets loaded. Additional targets could not be loaded; retry target discovery to start again.</p>}
    {!targets?.page.nextCursor && !targetPaginationStopped && targetOptions.length > 0 && showTargetLimit && <p className="impact-muted" role="status">All {targetOptions.length} matching targets are available.</p>}
    {failure && <ImpactError failure={failure} onRetry={() => { if (failure.status === 404) restartTargetDiscovery(); setImpactRetryNonce((nonce) => nonce + 1); }}/ >}
    {loading && <p className="impact-message" role="status" aria-live="polite">Tracing bounded dependency paths…</p>}
    {!loading && !failure && filters.target && !impact && <p className="impact-message" role="status">Choose a valid target from the available list.</p>}
    {impact && <>
      <div className="impact-summary" aria-live="polite"><span><strong>{impact.summary.impactedNodeCount}</strong> impacted nodes · <strong>{impact.summary.edgeCount}</strong> relationships · <strong>{impact.summary.workspaceCount}</strong> workspaces</span><span>Maximum distance {impact.summary.maxDistance} · {impact.summary.inferredPathCount} inferred paths · {impact.snapshot.generations.length} active generations</span></div>
      <p className="impact-notice">Frontend requests are traced when an active frontend HTTP generation and an exact namespace, method, and path match are present in the selected workspace snapshots. Unsupported or dynamic requests are not mapped.</p>
      {impact.nodes.length === 1 && filters.direction !== 'dependencies' && <p className="impact-muted">No dependent nodes are currently observed in these architecture snapshots.</p>}
      <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
      <div className="impact-layout">
        <div className="impact-main-column">
          <section className="impact-paths" aria-labelledby="impact-path-title"><div><h2 id="impact-path-title">Shortest paths</h2><label>Highlight path<select value={pathId} onChange={(event) => { const id = event.target.value; setPathId(id); const path = impact.paths.find((entry) => entry.nodeId === id); setAnnouncement(path ? `Selected shortest path to ${titleForNode(path.nodeId)}, ${path.nodeIds.length - 1} hops.` : 'Cleared shortest path highlight.'); }}><option value="">All reached nodes</option>{impact.paths.map((path) => <option key={path.nodeId} value={path.nodeId}>{titleForNode(path.nodeId)} · {path.nodeIds.length - 1} hops</option>)}</select></label></div>
            {activePath ? <ol>{activePath.nodeIds.map((nodeId, index) => <li key={`${activePath.nodeId}:${index}`}><button type="button" onClick={() => { const found = impact.nodes.find((node) => node.id === nodeId); if (found) { setSelected(found); setAnnouncement(`Selected path node ${found.label}, ${found.impactRole}, step ${index}.`); } }}>{titleForNode(nodeId)}<small>{index === 0 ? 'selected target' : `step ${index} · ${impact.nodes.find((node) => node.id === nodeId)?.impactRole ?? ''}`}</small></button></li>)}</ol> : <p className="impact-muted">Select a reached node to inspect its deterministic shortest path.</p>}
          </section>
          <ImpactGraph nodes={impact.nodes} edges={impact.edges} paths={impact.paths} workspaceNames={workspaceNames} selectedId={selected?.id} pathId={pathId} onSelect={handleSelect}/>
        </div>
        <ImpactInspector item={selected} result={impact}/>
      </div>
    </>}
    {targetOptions.length > 0 && !impact && <p className="impact-muted">{selectedTarget ? `Selected target: ${selectedTarget.label}` : 'Targets are ready. Select one to calculate impact.'}</p>}
  </section>;
}

function ImpactError({ failure, onRetry, targetDiscovery = false }: { failure: Failure; onRetry: () => void; targetDiscovery?: boolean }) {
  const title = failure.status === 404 ? 'Target not found' : failure.status === 409 ? 'Insufficient or changed snapshot' : failure.status === 422 ? 'Impact result exceeds the response bound' : 'Impact query failed';
  return <div className="impact-error" role="alert"><strong>{title}{failure.code ? ` · ${failure.code}` : ''}</strong><p>{failure.message}</p>{failure.status === 404 && <p>Reload target choices and select a current node from the active workspace generations.</p>}{failure.status === 409 && <p>Confirm that at least two selected workspaces have active architecture generations, then choose the target again.</p>}{failure.status === 422 && <p>{targetDiscovery ? 'Narrow the workspace set or add exact namespace, method, and path filters before loading targets.' : 'Reduce depth, lower the node limit, or exclude inferred relationships and evidence.'}</p>}<button type="button" onClick={onRetry}>Retry</button></div>;
}
