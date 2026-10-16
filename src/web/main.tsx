import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import cytoscape, { type Core } from 'cytoscape';
import { ArchitectureView } from './architecture-view.js';
import { ImpactView } from './impact-view.js';
import { I18nProvider, useI18n } from './i18n.js';
import './style.css';

type Node = { id: string; label: string; kind: string; properties: Record<string, unknown>; evidence?: unknown[] };
type Graph = { nodes: Node[]; edges: { id: string; sourceId: string; targetId: string; kind: string }[] };
type Workspace = { id: string; name: string; path: string };

function cssToken(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function OverviewView({ status, refreshKey }: { status: any; refreshKey: number }) {
  const { locale, t } = useI18n();
  const graphElement = useRef<HTMLDivElement>(null);
  const cy = useRef<Core>();
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const [selected, setSelected] = useState<Node>();
  const [selectedId, setSelectedId] = useState('');
  const load = async () => {
    const response = await fetch('/api/v1/graph');
    if (response.ok) setGraph(await response.json());
  };

  useEffect(() => { void load(); }, [refreshKey]);
  useEffect(() => {
    if (!graphElement.current) return;
    cy.current?.destroy();
    cy.current = cytoscape({
      container: graphElement.current,
      elements: [
        ...graph.nodes.map(node => ({ data: { id: node.id, label: node.label, kind: node.kind } })),
        ...graph.edges.map(edge => ({ data: { id: edge.id, source: edge.sourceId, target: edge.targetId, label: edge.kind } })),
      ],
      style: [
        { selector: 'node', style: { shape: 'round-rectangle', 'background-color': cssToken('--color-graph-node'), 'border-width': 1, 'border-color': cssToken('--color-rule'), label: 'data(label)', color: cssToken('--color-ink'), 'font-size': 12, 'text-wrap': 'wrap', 'text-max-width': 150, width: 'label', height: 38, padding: '10px', 'text-valign': 'center', 'text-halign': 'center' } },
        { selector: 'node:selected', style: { 'border-width': 3, 'border-color': cssToken('--color-accent'), 'underlay-color': cssToken('--color-accent'), 'underlay-opacity': 0.12, 'underlay-padding': 5 } },
        { selector: 'edge', style: { width: 1.5, 'line-color': cssToken('--color-graph-edge'), 'target-arrow-color': cssToken('--color-graph-edge'), 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', label: 'data(label)', color: cssToken('--color-muted'), 'font-size': 10, 'text-background-color': cssToken('--color-paper'), 'text-background-opacity': 1, 'text-background-padding': '2px' } },
      ],
      minZoom: 0.45,
      maxZoom: 2,
      layout: { name: 'breadthfirst', directed: true, spacingFactor: 1.3, animate: false, padding: 56 },
    });
    cy.current.one('layoutstop', () => cy.current?.fit(undefined, 40));
    cy.current.on('tap', 'node', event => {
      const id = event.target.id();
      setSelectedId(id);
      void fetch(`/api/v1/nodes/${id}`).then(response => response.json()).then(setSelected);
    });
    return () => { cy.current?.destroy(); cy.current = undefined; };
  }, [graph]);
  useEffect(() => {
    const container = graphElement.current;
    if (!container) return;
    const observer = new ResizeObserver(() => { cy.current?.resize(); if (graph.nodes.length) cy.current?.fit(undefined, 40); });
    observer.observe(container);
    return () => observer.disconnect();
  }, [graph.nodes.length]);

  const selectNode = (id: string) => {
    setSelectedId(id);
    if (!id) { setSelected(undefined); return; }
    cy.current?.nodes().unselect();
    cy.current?.getElementById(id).select();
    void fetch(`/api/v1/nodes/${id}`).then(response => response.json()).then(setSelected);
  };

  return <section className="overview-view" aria-label={t('Overview')}>
    <div className="overview-heading">
      <div><p className="eyebrow">{t('Workspace map')}</p><h1>{t('Overview')}</h1></div>
      <p className="overview-count">{locale === 'ja' ? `${status?.workspaces ?? 0} 件のワークスペース` : `${status?.workspaces ?? 0} workspaces`}</p>
    </div>
    <div className="workspace">
      <section className="canvas" aria-label={t('Architecture graph')}>
        <div ref={graphElement} className="graph" aria-hidden="true" />
        <div className="canvas-tools"><button type="button" className="button button-quiet" onClick={() => cy.current?.fit(undefined, 40)}>{t('Fit graph')}</button></div>
        {!graph.nodes.length && <div className="empty"><h2>{t('No graph snapshot yet')}</h2><p>{t('Start with a CodeGraph bridge that supports complete snapshots, or load the labelled local demo.')}</p></div>}
        {!!graph.nodes.length && <label className="graph-jump">{t('Node selector')}<select name="overviewNode" autoComplete="off" value={selectedId} onChange={event => selectNode(event.target.value)}><option value="">{t('Choose a node')}</option>{graph.nodes.map(node => <option key={node.id} value={node.id}>{node.label} · {node.kind}</option>)}</select></label>}
      </section>
      <aside className="inspector" aria-label={t('Node inspector')}>
        <h2>{t('Node inspector')}</h2>
        {selected ? <><p className="inspector-kind">{selected.kind}</p><h3>{selected.label}</h3><pre>{JSON.stringify(selected.properties, null, 2)}</pre><h3>{t('Evidence')}</h3><pre>{JSON.stringify(selected.evidence, null, 2)}</pre></> : <p className="muted">{t('Select a node to inspect its source properties and evidence.')}</p>}
      </aside>
    </div>
  </section>;
}

function App() {
  const { locale, setLocale, t } = useI18n();
  const [status, setStatus] = useState<any>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [view, setView] = useState(() => ['architecture', 'impact'].includes(new URLSearchParams(location.search).get('view') ?? '') ? new URLSearchParams(location.search).get('view')! : 'overview');
  useEffect(() => { void Promise.all([fetch('/api/v1/status').then(response => response.json()), fetch('/api/v1/workspaces').then(response => response.json())]).then(([nextStatus, nextWorkspaces]) => { setStatus(nextStatus); setWorkspaces(nextWorkspaces.workspaces ?? []); }); }, []);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  useEffect(() => {
    const onPop = () => { const next = new URLSearchParams(location.search).get('view'); setView(next === 'architecture' || next === 'impact' ? next : 'overview'); };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  const selectView = (next: string) => {
    const params = new URLSearchParams(location.search);
    params.set('view', next);
    window.history.pushState({}, '', `${location.pathname}?${params}`);
    setView(next);
  };
  const viewHref = (next: string) => { const params = new URLSearchParams(location.search); params.set('view', next); return `${location.pathname}?${params}`; };
  const syncDemo = async () => {
    const response = await fetch('/api/v1/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ demo: true, workspaces: ['.'] }) });
    if (!response.ok) alert((await response.json()).message);
    setRefreshKey(key => key + 1);
  };

  return <div className="app-shell">
    <a className="skip-link" href="#app-content">{t('Skip to analysis')}</a>
    <aside className="app-rail">
      <a className="brand" href={viewHref('overview')} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); selectView('overview'); }} aria-label="GraphLens">
        <span className="brand-mark" aria-hidden="true">GL</span><span className="brand-name">GraphLens</span>
      </a>
      <nav className="view-nav" aria-label={t('Main view')}>
        {(['overview', 'architecture', 'impact'] as const).map(key => <a key={key} href={viewHref(key)} className={view === key ? 'view-nav-item is-active' : 'view-nav-item'} aria-label={t(key === 'overview' ? 'Overview' : key === 'architecture' ? 'Architecture' : 'Impact')} aria-current={view === key ? 'page' : undefined} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); selectView(key); }}>
          <span className={`nav-glyph nav-glyph-${key}`} aria-hidden="true" /><span className="nav-label">{t(key === 'overview' ? 'Overview' : key === 'architecture' ? 'Architecture' : 'Impact')}</span>
        </a>)}
      </nav>
    </aside>
    <main className="app-content" id="app-content" tabIndex={-1}>
      <header className="app-toolbar">
        <div className="connection-state" role="status"><span className={status?.codegraph?.connected ? 'connection-mark is-connected' : 'connection-mark'} aria-hidden="true" /><span>{status?.codegraph?.connected ? t('CodeGraph connected') : t('CodeGraph not connected')}</span><span className="connection-detail">{t(status?.codegraph?.detail ?? 'Checking CodeGraph capability…')}</span></div>
        <div className="toolbar-actions">
          {view === 'overview' && <button type="button" className="button button-primary" onClick={syncDemo}>{t('Load demo graph')}</button>}
          <label className="locale-control"><span>{t('Language')}</span><select aria-label={t('Language')} value={locale} onChange={event => setLocale(event.target.value as 'en' | 'ja')}><option value="en">{t('English')}</option><option value="ja">{t('Japanese')}</option></select></label>
        </div>
      </header>
      <div className="view-content">
        {view === 'overview' ? <OverviewView status={status} refreshKey={refreshKey}/> : view === 'architecture' ? <ArchitectureView workspaces={workspaces}/> : <ImpactView workspaces={workspaces}/>}
      </div>
      <footer className="app-footer"><span>GraphLens</span></footer>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<I18nProvider><App/></I18nProvider>);
