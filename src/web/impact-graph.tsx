import React, { useEffect, useMemo, useRef } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import type { ImpactEdge, ImpactNode, ImpactPath } from './impact-types.js';
import { useI18n } from './i18n.js';

function cssToken(name: string) {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

export function ImpactGraph({ nodes, edges, paths, workspaceNames, selectedId, pathId, onSelect }: { nodes: ImpactNode[]; edges: ImpactEdge[]; paths: ImpactPath[]; workspaceNames: Map<string, string>; selectedId?: string; pathId?: string; onSelect: (item: ImpactNode | ImpactEdge) => void }) {
  const { t } = useI18n();
  const element = useRef<HTMLDivElement>(null);
  const cy = useRef<Core>();
  const path = useMemo(() => paths.find((item) => item.nodeId === pathId), [paths, pathId]);
  const nodeLabels = useMemo(() => new Map(nodes.map((node) => [node.id, node.label])), [nodes]);
  useEffect(() => {
    if (!element.current) return;
    cy.current?.destroy();
    const workspaceIds = [...new Set(nodes.flatMap((node) => node.scope === 'workspace' && node.workspaceId ? [node.workspaceId] : []))].sort();
    const parents = workspaceIds.map((id) => ({ data: { id: `workspace-group:${id}`, label: workspaceNames.get(id) ?? id }, classes: 'workspace-group' }));
    const positioned = nodes.map((node, index) => ({
      data: { id: node.id, parent: node.scope === 'workspace' ? `workspace-group:${node.workspaceId}` : undefined, label: node.label, role: node.impactRole, kind: node.kind, level: node.level },
      classes: [node.impactRole, node.scope === 'global' ? 'global-hub' : ''].filter(Boolean).join(' '),
      position: { x: 90 + (node.distance % 4) * 210 + (node.scope === 'global' ? 80 : 0), y: 90 + index * 48 },
    }));
    const edgeData = edges.map((edge) => ({
      data: { id: edge.id, source: edge.sourceId, target: edge.targetId, label: `${edge.kind}${edge.scope === 'cross-workspace' ? ' · workspace transition' : ''}`, level: edge.level, scope: edge.scope },
      classes: edge.scope === 'cross-workspace' ? 'workspace-transition' : '',
    }));
    cy.current = cytoscape({ container: element.current, elements: [...parents, ...positioned, ...edgeData], style: [
      { selector: 'node', style: { 'background-color': cssToken('--color-graph-node'), label: 'data(label)', color: cssToken('--color-ink'), 'font-size': 10, 'text-wrap': 'wrap', 'text-max-width': 130, width: 24, height: 24, 'text-valign': 'bottom', 'text-margin-y': 5, 'border-width': 2, 'border-color': cssToken('--color-ink-2') } },
      { selector: 'node.target', style: { shape: 'round-rectangle', width: 34, height: 34, 'border-width': 4, 'border-color': cssToken('--color-accent') } },
      { selector: 'node.dependent', style: { shape: 'ellipse' } },
      { selector: 'node.dependency', style: { shape: 'hexagon' } },
      { selector: 'node.global-hub', style: { shape: 'diamond', width: 38, height: 38, 'border-style': 'double' } },
      { selector: 'node[level = "DIRECT"]', style: { 'border-style': 'solid', 'border-color': cssToken('--color-ink-2'), 'border-width': 3 } },
      { selector: 'node[level = "DERIVED"]', style: { 'border-style': 'dotted', 'border-color': cssToken('--color-ink-2'), 'border-width': 3 } },
      { selector: 'node[level = "INFERRED"]', style: { 'border-style': 'dashed', 'border-color': cssToken('--color-ink-2'), 'border-width': 3 } },
      { selector: 'node.workspace-group', style: { shape: 'round-rectangle', 'background-opacity': 1, 'background-color': cssToken('--color-paper-2'), 'border-color': cssToken('--color-rule'), 'border-style': 'dashed', 'border-width': 1, label: 'data(label)', color: cssToken('--color-ink-2'), 'font-size': 12, 'text-valign': 'top', 'text-halign': 'center', padding: 24 } },
      { selector: 'edge', style: { width: 2, 'line-color': cssToken('--color-graph-edge'), 'target-arrow-color': cssToken('--color-graph-edge'), 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', label: 'data(label)', color: cssToken('--color-ink-2'), 'font-size': 8, 'text-background-color': cssToken('--color-paper'), 'text-background-opacity': 1 } },
      { selector: 'edge[level = "DERIVED"]', style: { 'line-style': 'dotted' } },
      { selector: 'edge[level = "INFERRED"]', style: { 'line-style': 'dashed' } },
      { selector: 'edge.workspace-transition', style: { width: 3, 'target-arrow-shape': 'triangle-tee' } },
      { selector: '.selected-item', style: { 'underlay-color': cssToken('--color-accent'), 'underlay-opacity': 0.24, 'underlay-padding': 6 } },
      { selector: 'edge.path-item', style: { 'underlay-color': cssToken('--color-accent'), 'underlay-opacity': 0.2, 'underlay-padding': 5, width: 3 } },
      { selector: 'node.path-item', style: { 'underlay-color': cssToken('--color-accent'), 'underlay-opacity': 0.2, 'underlay-padding': 5 } },
    ], layout: { name: 'cose', animate: false, padding: 36, nodeRepulsion: () => 5000, idealEdgeLength: () => 120 } });
    cy.current.on('tap', 'node, edge', (event) => {
      const id = event.target.id();
      const selected = nodes.find((node) => node.id === id) ?? edges.find((edge) => edge.id === id);
      if (selected) onSelect(selected);
    });
    return () => { cy.current?.destroy(); cy.current = undefined; };
  }, [nodes, edges, onSelect, workspaceNames]);
  useEffect(() => {
    if (!cy.current) return;
    cy.current.elements().removeClass('selected-item path-item');
    if (selectedId) cy.current.getElementById(selectedId).addClass('selected-item');
    if (path) {
      for (const nodeId of path.nodeIds) cy.current.getElementById(nodeId).addClass('path-item');
      for (const edgeId of path.edgeIds) cy.current.getElementById(edgeId).addClass('path-item');
    }
  }, [selectedId, path]);
  const groups = useMemo(() => {
    const result = new Map<string, ImpactNode[]>();
    for (const node of nodes) { const key = node.scope === 'global' ? 'Global API contracts' : node.workspaceId ?? 'Workspace'; result.set(key, [...(result.get(key) ?? []), node]); }
    return [...result.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [nodes]);
  return <section className="impact-graph-panel" aria-label={t('Impact graph and keyboard node index')}>
    <div className="impact-legend" aria-label={t('Graph legend')}><span><i className="legend-target"/>{t('Target · double outline')}</span><span><i className="legend-dependent"/>{t('Dependent · circle')}</span><span><i className="legend-dependency"/>{t('Dependency · hexagon')}</span><span><i className="legend-global"/>{t('Global contract · diamond')}</span><span>{t('Solid DIRECT · dotted DERIVED · dashed INFERRED')}</span><span>{t('Wider arrow with tee: workspace transition')}</span></div>
    <div ref={element} className="impact-canvas" aria-hidden="true" />
    <div className="impact-node-index" aria-label={t('Keyboard-accessible graph index')}>
      {groups.map(([label, items]) => <section key={label}><h3>{label}</h3><ul>{items.map((node) => <li key={node.id}><button type="button" className="impact-index-item" aria-pressed={selectedId === node.id} onClick={() => onSelect(node)}>
        <strong>{node.impactRole}: {node.label}</strong><small>{node.kind} · distance {node.distance} · {node.level}{node.impactRole === 'dependent' ? ' · depends on selected target' : node.impactRole === 'dependency' ? ' · required by selected target' : ''}</small>
      </button></li>)}</ul></section>)}
    </div>
    <details className="impact-edge-index"><summary>{t('Keyboard-accessible relationships')} · {edges.length}</summary><ul>{edges.map((edge) => <li key={edge.id}><button type="button" className="impact-index-item" aria-pressed={selectedId === edge.id} onClick={() => onSelect(edge)}><strong>{nodeLabels.get(edge.sourceId) ?? edge.sourceId} → {nodeLabels.get(edge.targetId) ?? edge.targetId}</strong><small>{edge.kind} · {edge.level} · {t(edge.scope === 'cross-workspace' ? 'workspace transition' : 'within workspace')}</small></button></li>)}</ul></details>
  </section>;
}
