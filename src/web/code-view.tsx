import React, { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import { SourceEvidenceButton } from './source-viewer.js';
import './code-view.css';

type Workspace = { id: string; name: string };
type Evidence = { id: string; type: string; uri?: string; line?: number; level?: string; analyzerId?: string; generationId?: number };
type Node = { id: string; workspaceId: string; kind: string; label: string; properties: Record<string, unknown>; analyzerId: string; generationId: number; level: string; evidenceCount: number; evidence?: Evidence[] };
type Edge = { id: string; workspaceId: string; sourceId: string; targetId: string; kind: string; properties: Record<string, unknown>; analyzerId: string; generationId: number; level: string; evidenceCount: number; evidence?: Evidence[] };
type Page = { snapshotId: string; page: { nextCursor?: string }; nodes: Node[]; edges: Edge[] };
type Branch = { parent: string; mode: 'neighbors' | 'children'; owner?: string; nodes: Node[]; edges: Edge[]; cursor?: string };
type Selection = { type: 'node'; value: Node } | { type: 'edge'; value: Edge };
const identity = (workspaceId: string, id: string) => `${workspaceId}::${id}`;
const mergeByIdentity = <T extends { id: string; workspaceId: string }>(...groups: T[][]) => {
  const result = new Map<string, T>();
  groups.flat().forEach((item) => result.set(identity(item.workspaceId, item.id), item));
  return [...result.values()];
};

export function CodeView({ workspaces }: { workspaces: Workspace[] }) {
  const [selectedWorkspaces, setSelectedWorkspaces] = useState<string[]>([]);
  const [preset, setPreset] = useState('class');
  const [mode, setMode] = useState<'roots' | 'search'>('roots');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [root, setRoot] = useState<Page>();
  const [rootCursor, setRootCursor] = useState<string>();
  const [branches, setBranches] = useState<Record<string, Branch>>({});
  const [selection, setSelection] = useState<Selection>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const cy = useRef<Core>();
  const request = useRef<AbortController>();

  const nodes = useMemo(() => mergeByIdentity(root?.nodes ?? [], ...Object.values(branches).map((branch) => branch.nodes)), [root, branches]);
  const edges = useMemo(() => mergeByIdentity(root?.edges ?? [], ...Object.values(branches).map((branch) => branch.edges)), [root, branches]);

  const fetchPage = async (options: { mode: 'roots' | 'search' | 'neighbors' | 'children'; cursor?: string; focus?: Node; rootPage?: boolean }) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ workspaces: selectedWorkspaces.join(','), preset, mode: options.mode, limit: '25', include: 'evidence' });
      if (options.mode === 'search') params.set('q', query);
      if (kind && (options.mode === 'roots' || options.mode === 'search')) params.set('kind', kind);
      if (options.cursor) params.set('cursor', options.cursor);
      if (root?.snapshotId && !options.cursor) params.set('snapshot', root.snapshotId);
      if (options.focus) { params.set('node', options.focus.id); params.set('nodeWorkspace', options.focus.workspaceId); }
      const response = await fetch(`/api/v1/code-graph?${params}`, { signal: controller.signal });
      const result = await response.json() as Page & { error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Code graph request failed.');
      if (controller.signal.aborted || request.current !== controller) return;

      if (options.rootPage) {
        const nextNodes = options.cursor ? mergeByIdentity(root?.nodes ?? [], result.nodes) : result.nodes;
        const nextEdges = options.cursor ? mergeByIdentity(root?.edges ?? [], result.edges) : result.edges;
        if (nextNodes.length > 500 || nextEdges.length > 500) throw new Error('Display limit reached (500 nodes or 500 relationships). The page was not added.');
        setRoot({ ...result, nodes: nextNodes, edges: nextEdges }); setRootCursor(result.page.nextCursor); setBranches({});
      } else if (options.focus) {
        const branchKey = `${identity(options.focus.workspaceId, options.focus.id)}|${options.mode}`;
        const old = branches[branchKey];
        const branchNodes = options.cursor ? mergeByIdentity(old?.nodes ?? [], result.nodes) : result.nodes;
        const branchEdges = options.cursor ? mergeByIdentity(old?.edges ?? [], result.edges) : result.edges;
        const combinedNodes = mergeByIdentity(root?.nodes ?? [], ...Object.entries(branches).filter(([key]) => key !== branchKey).map(([, branch]) => branch.nodes), branchNodes);
        const combinedEdges = mergeByIdentity(root?.edges ?? [], ...Object.entries(branches).filter(([key]) => key !== branchKey).map(([, branch]) => branch.edges), branchEdges);
        if (combinedNodes.length > 500 || combinedEdges.length > 500) throw new Error('Display limit reached (500 nodes or 500 relationships). The branch page was not added.');
        const focusIdentity = identity(options.focus.workspaceId, options.focus.id);
        const owner = Object.entries(branches).find(([, branch]) => branch.nodes.some((node) => identity(node.workspaceId, node.id) === focusIdentity))?.[0];
        setBranches((current) => ({ ...current, [branchKey]: { parent: focusIdentity, mode: options.mode as Branch['mode'], ...(owner ? { owner } : {}), nodes: branchNodes, edges: branchEdges, cursor: result.page.nextCursor } }));
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message);
    } finally { if (request.current === controller) setBusy(false); }
  };

  useEffect(() => {
    if (selectedWorkspaces.length) void fetchPage({ mode, rootPage: true });
    else { setRoot(undefined); setRootCursor(undefined); setBranches({}); }
    return () => request.current?.abort();
    // Workspace and preset changes intentionally start a new root snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkspaces.join(','), preset]);

  useEffect(() => {
    if (!canvas.current) return;
    cy.current?.destroy();
    const graph = cytoscape({
      container: canvas.current,
      elements: [
        ...nodes.map((node) => ({ data: { id: identity(node.workspaceId, node.id), label: node.label || node.id, node } })),
        ...edges.map((edge) => ({ data: { id: `${identity(edge.workspaceId, edge.id)}:${edge.kind}`, source: identity(edge.workspaceId, edge.sourceId), target: identity(edge.workspaceId, edge.targetId), label: `${edge.kind} · ${edge.level}`, edge } })),
      ],
      style: [
        { selector: 'node', style: { label: 'data(label)', color: '#e9eff5', backgroundColor: '#57c7b7', 'font-size': 10, 'text-wrap': 'wrap', 'text-max-width': 120, width: 24, height: 24 } },
        { selector: 'edge', style: { label: 'data(label)', color: '#c0cad5', 'font-size': 8, 'line-color': '#718096', 'target-arrow-color': '#718096', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier' } },
      ],
      layout: { name: 'cose', animate: false, fit: true, padding: 24 }, minZoom: 0.25, maxZoom: 3,
    });
    graph.on('tap', 'node', (event) => setSelection({ type: 'node', value: event.target.data('node') as Node }));
    graph.on('tap', 'edge', (event) => setSelection({ type: 'edge', value: event.target.data('edge') as Edge }));
    cy.current = graph;
    return () => { graph.destroy(); cy.current = undefined; };
  }, [nodes, edges]);

  const selectedNode = selection?.type === 'node' ? selection.value : undefined;
  const branchKey = (node: Node, branchMode: Branch['mode']) => `${identity(node.workspaceId, node.id)}|${branchMode}`;
  const expand = (node: Node, branchMode: Branch['mode']) => {
    const key = branchKey(node, branchMode);
    if (!branches[key] && Object.keys(branches).length >= 16) { setError('Expansion limit reached (16 branches). Collapse a branch before expanding another.'); return; }
    void fetchPage({ mode: branchMode, focus: node });
  };
  const collapse = (node: Node, branchMode?: Branch['mode']) => {
    const parent = identity(node.workspaceId, node.id);
    setBranches((current) => {
      const removed = new Set(Object.entries(current).filter(([, branch]) => branch.parent === parent && (!branchMode || branch.mode === branchMode)).map(([key]) => key));
      let changed = true;
      while (changed) { changed = false; for (const [key, branch] of Object.entries(current)) if (branch.owner && removed.has(branch.owner) && !removed.has(key)) { removed.add(key); changed = true; } }
      return Object.fromEntries(Object.entries(current).filter(([key]) => !removed.has(key)));
    });
  };

  return <main className="code-view">
    <h1>Code</h1><p>Explore stored code relationships across active analyzer generations.</p>
    <div className="code-controls">
      <fieldset><legend>Workspaces (up to 16)</legend>{workspaces.map((workspace) => <label key={workspace.id}><input type="checkbox" checked={selectedWorkspaces.includes(workspace.id)} onChange={(event) => setSelectedWorkspaces((current) => event.target.checked ? [...current, workspace.id].slice(0, 16) : current.filter((id) => id !== workspace.id))}/>{workspace.name}</label>)}</fieldset>
      <label>View<select value={preset} onChange={(event) => setPreset(event.target.value)}><option value="class">Class</option><option value="calls">Function Call</option><option value="dependency">Dependency</option><option value="imports">Import</option></select></label>
      <label>Search<input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && (setMode('search'), void fetchPage({ mode: 'search', rootPage: true }))}/></label>
      <label>Exact kind<input value={kind} onChange={(event) => setKind(event.target.value)}/></label>
      <button disabled={busy || !selectedWorkspaces.length} onClick={() => { setMode('roots'); void fetchPage({ mode: 'roots', rootPage: true }); }}>Load roots</button>
      <button disabled={busy || !query.trim()} onClick={() => { setMode('search'); void fetchPage({ mode: 'search', rootPage: true }); }}>Search</button>
    </div>
    {error && <p role="alert">{error}</p>}{busy && <p role="status">Loading…</p>}
    <div className="code-layout"><section>
      <div className="code-canvas" ref={canvas} aria-label="Code graph canvas"/>
      <div className="code-actions">
        <button onClick={() => cy.current?.fit(undefined, 30)}>Fit</button><button onClick={() => cy.current?.reset()}>Reset zoom</button>
        <button disabled={!selectedNode} onClick={() => selectedNode && expand(selectedNode, 'neighbors')}>Expand one hop</button>
        <button disabled={!selectedNode} onClick={() => selectedNode && expand(selectedNode, 'children')}>Show members</button>
        <button disabled={!selectedNode} onClick={() => selectedNode && collapse(selectedNode)}>Collapse selected node</button>
        {rootCursor && <button disabled={busy} onClick={() => void fetchPage({ mode, cursor: rootCursor, rootPage: true })}>Next root page</button>}
      </div>
      <h2>Keyboard accessible graph index</h2>
      <ul>{nodes.map((node) => <li key={identity(node.workspaceId, node.id)}><button aria-pressed={selection?.type === 'node' && identity(selection.value.workspaceId, selection.value.id) === identity(node.workspaceId, node.id)} onClick={() => setSelection({ type: 'node', value: node })}>{node.label} · {node.kind} · {node.level}</button></li>)}
        {edges.map((edge) => <li key={identity(edge.workspaceId, edge.id)}><button aria-pressed={selection?.type === 'edge' && identity(selection.value.workspaceId, selection.value.id) === identity(edge.workspaceId, edge.id)} onClick={() => setSelection({ type: 'edge', value: edge })}>{edge.sourceId} → {edge.targetId} · {edge.kind} · {edge.level}</button></li>)}</ul>
      <h2>Expanded branches</h2>{Object.entries(branches).map(([key, branch]) => { const parent = nodes.find((node) => identity(node.workspaceId, node.id) === branch.parent); return <div key={key}><span>{parent?.label ?? branch.parent} · {branch.mode}</span><button onClick={() => parent && collapse(parent, branch.mode)}>Collapse branch</button>{branch.cursor && parent && <button disabled={busy} onClick={() => void fetchPage({ mode: branch.mode, focus: parent, cursor: branch.cursor })}>More in branch</button>}</div>; })}
    </section><aside><h2>Inspector</h2>{selection ? <><h3>{selection.type === 'node' ? selection.value.label : selection.value.kind}</h3><p>{selection.type} · {selection.value.kind} · {selection.value.level} · {selection.value.workspaceId} #{selection.value.generationId}</p><pre>{JSON.stringify(selection.value.properties, null, 2)}</pre><h3>Evidence</h3>{selection.value.evidence?.map((entry) => { const source = entry.uri && entry.id && entry.analyzerId && entry.generationId ? { workspaceId: selection.value.workspaceId, analyzerId: entry.analyzerId, generationId: entry.generationId, evidenceId: entry.id } : undefined; return <p key={entry.id}><code>{entry.type} {entry.uri}{entry.line ? `:${entry.line}` : ''}</code><br/><SourceEvidenceButton source={source}/></p>; }) ?? <p>Evidence was not included.</p>}</> : <p>Select a node or relationship.</p>}</aside></div>
  </main>;
}
