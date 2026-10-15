import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArchitectureView } from './architecture-view.js';
import { ImpactView } from './impact-view.js';
import { DatabaseView } from './database-view.js';
import { WorkspaceView } from './workspace-view.js';
import './style.css';

type Workspace = { id:string; name:string; path:string };
function App() {
  const [status, setStatus] = useState<any>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [view, setView] = useState(() => ['architecture', 'impact', 'database'].includes(new URLSearchParams(location.search).get('view') ?? '') ? new URLSearchParams(location.search).get('view')! : 'overview');
  useEffect(() => { void Promise.all([fetch('/api/v1/status').then(r=>r.json()), fetch('/api/v1/workspaces').then(r=>r.json())]).then(([s,w]) => { setStatus(s); setWorkspaces(w.workspaces ?? []); }); }, []);
  useEffect(() => { const onPop = () => { const next = new URLSearchParams(location.search).get('view'); setView(next === 'architecture' || next === 'impact' || next === 'database' ? next : 'overview'); }; addEventListener('popstate', onPop); return () => removeEventListener('popstate', onPop); }, []);
  const selectView = (next: string) => { const params = new URLSearchParams(location.search); params.set('view', next); window.history.pushState({}, '', `${location.pathname}?${params}`); setView(next); };
  const syncDemo = async () => { const response = await fetch('/api/v1/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({demo:true,workspaces:['.']})}); if (!response.ok) alert((await response.json()).message); setRefreshKey(key => key + 1); };
  return <main><header><div><span className="mark">◈</span><strong>GraphLens</strong><small>Local architecture explorer</small></div><div className="header-actions"><nav aria-label="Main view"><button className={view === 'overview' ? 'nav-active' : ''} aria-current={view === 'overview' ? 'page' : undefined} onClick={() => selectView('overview')}>Workspace</button><button className={view === 'architecture' ? 'nav-active' : ''} aria-current={view === 'architecture' ? 'page' : undefined} onClick={() => selectView('architecture')}>Architecture</button><button className={view === 'database' ? 'nav-active' : ''} aria-current={view === 'database' ? 'page' : undefined} onClick={() => selectView('database')}>Database</button><button className={view === 'impact' ? 'nav-active' : ''} aria-current={view === 'impact' ? 'page' : undefined} onClick={() => selectView('impact')}>Impact</button></nav>{view === 'overview' && <button onClick={syncDemo}>Load demo graph</button>}</div></header><section className="status"><span>{status?.codegraph?.connected ? 'CodeGraph connected' : 'CodeGraph not connected'}</span><span>{status?.codegraph?.detail ?? 'Checking CodeGraph capability…'}</span></section>{view === 'overview' ? <WorkspaceView workspaces={workspaces} refreshKey={refreshKey}/> : view === 'architecture' ? <ArchitectureView workspaces={workspaces}/> : view === 'database' ? <DatabaseView workspaces={workspaces}/> : <ImpactView workspaces={workspaces}/>}</main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
