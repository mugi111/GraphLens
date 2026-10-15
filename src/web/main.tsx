import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import cytoscape, { type Core } from 'cytoscape';
import { ArchitectureView } from './architecture-view.js';
import './style.css';

type Node = { id:string; label:string; kind:string; properties:Record<string,unknown>; evidence?: unknown[] };
type Graph = { nodes:Node[]; edges:{id:string;sourceId:string;targetId:string;kind:string}[] };
type Workspace = { id:string; name:string; path:string };
function OverviewView({ status, refreshKey }: { status: any; refreshKey: number }) {
  const graphElement = useRef<HTMLDivElement>(null); const cy = useRef<Core>();
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] }); const [selected, setSelected] = useState<Node>();
  const load = async () => { const g = await fetch('/api/v1/graph').then(r=>r.json()); setGraph(g); };
  useEffect(() => { void load(); }, [refreshKey]);
  useEffect(() => {
    if (!graphElement.current) return; cy.current?.destroy();
    cy.current = cytoscape({ container: graphElement.current, elements: [
      ...graph.nodes.map(n=>({ data:{ id:n.id, label:n.label, kind:n.kind } })),
      ...graph.edges.map(e=>({ data:{ id:e.id, source:e.sourceId, target:e.targetId, label:e.kind } }))
    ], style:[
      { selector:'node', style:{ 'background-color':'#57c7b7', label:'data(label)', color:'#e9eff5','font-size':11,'text-wrap':'wrap','text-max-width':100 } },
      { selector:'edge', style:{ width:1.5,'line-color':'#536173','target-arrow-color':'#536173','target-arrow-shape':'triangle','curve-style':'bezier',label:'data(label)',color:'#9facba','font-size':9 } }
    ], layout:{ name:'cose', animate:false, padding:32 } });
    cy.current.on('tap', 'node', (event) => { const id=event.target.id(); void fetch(`/api/v1/nodes/${id}`).then(r=>r.json()).then(setSelected); });
    return () => { cy.current?.destroy(); cy.current = undefined; };
  }, [graph]);
  return <div className="workspace"><aside><h2>Workspaces</h2><p>{status?.workspaces ?? 0} saved workspace(s)</p><p className="muted">The demo graph is a local fixture and is never represented as CodeGraph data.</p></aside><section className="canvas"><div ref={graphElement} className="graph"/>{!graph.nodes.length && <div className="empty"><h2>No graph snapshot yet</h2><p>Start with a CodeGraph bridge that supports complete snapshots, or load the labelled local demo.</p></div>}</section><aside className="inspector"><h2>Node inspector</h2>{selected ? <><h3>{selected.label}</h3><p>{selected.kind}</p><pre>{JSON.stringify(selected.properties,null,2)}</pre><h3>Evidence</h3><pre>{JSON.stringify(selected.evidence,null,2)}</pre></> : <p className="muted">Select a node to inspect its source properties and evidence.</p>}</aside></div>;
}
function App() {
  const [status, setStatus] = useState<any>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [view, setView] = useState(() => new URLSearchParams(location.search).get('view') === 'architecture' ? 'architecture' : 'overview');
  useEffect(() => { void Promise.all([fetch('/api/v1/status').then(r=>r.json()), fetch('/api/v1/workspaces').then(r=>r.json())]).then(([s,w]) => { setStatus(s); setWorkspaces(w.workspaces ?? []); }); }, []);
  useEffect(() => { const onPop = () => setView(new URLSearchParams(location.search).get('view') === 'architecture' ? 'architecture' : 'overview'); addEventListener('popstate', onPop); return () => removeEventListener('popstate', onPop); }, []);
  const selectView = (next: string) => { const params = new URLSearchParams(location.search); params.set('view', next); window.history.pushState({}, '', `${location.pathname}?${params}`); setView(next); };
  const syncDemo = async () => { const response = await fetch('/api/v1/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({demo:true,workspaces:['.']})}); if (!response.ok) alert((await response.json()).message); setRefreshKey(key => key + 1); };
  return <main><header><div><span className="mark">◈</span><strong>GraphLens</strong><small>Local architecture explorer</small></div><div className="header-actions"><nav aria-label="Main view"><button className={view === 'overview' ? 'nav-active' : ''} aria-current={view === 'overview' ? 'page' : undefined} onClick={() => selectView('overview')}>Overview</button><button className={view === 'architecture' ? 'nav-active' : ''} aria-current={view === 'architecture' ? 'page' : undefined} onClick={() => selectView('architecture')}>Architecture</button></nav>{view === 'overview' && <button onClick={syncDemo}>Load demo graph</button>}</div></header><section className="status"><span>{status?.codegraph?.connected ? 'CodeGraph connected' : 'CodeGraph not connected'}</span><span>{status?.codegraph?.detail ?? 'Checking CodeGraph capability…'}</span></section>{view === 'overview' ? <OverviewView status={status} refreshKey={refreshKey}/> : <ArchitectureView workspaces={workspaces}/>}</main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
