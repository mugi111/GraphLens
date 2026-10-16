import React from 'react';
import type { ImpactEdge, ImpactNode, ImpactResult } from './impact-types.js';
import { useI18n } from './i18n.js';

export function ImpactInspector({ item, result }: { item?: ImpactNode | ImpactEdge; result: ImpactResult }) {
  const { t } = useI18n();
  const workspaceName = (id: string) => result.scope.workspaces.find((workspace) => workspace.id === id)?.name ?? id;
  const selectedNode = item && 'distance' in item ? item : undefined;
  const selectedEdge = item && 'sourceId' in item ? item : undefined;
  const generation = selectedNode?.scope === 'workspace' ? result.snapshot.generations.find((entry) => entry.workspaceId === selectedNode.workspaceId) : undefined;
  const evidence = result.evidence?.filter((entry) => entry.subjectId === item?.id);
  const findings = selectedNode ? result.findings.filter((finding) => [finding.properties.sourceEndpointId, finding.properties.fastApiEndpointId, finding.properties.openApiEndpointId].some((reference) => reference === selectedNode.id) || finding.id === selectedNode.id) : result.findings;
  return <aside className="impact-inspector" aria-label={t('Impact inspector')}>
    <h2>{t('Selection details')}</h2>
    {!item && <p className="impact-muted">{t('Choose a graph item, path, or keyboard node entry to inspect its provenance.')}</p>}
    {item && <>
      <h3>{'label' in item ? item.label : item.kind}</h3>
      <p>{'scope' in item ? item.scope : ''} · {'kind' in item ? item.kind : ''} · {'level' in item ? item.level : ''}</p>
      {selectedNode && <><p>{selectedNode.impactRole} · {t('distance')} {selectedNode.distance}</p>{generation && <section><h3>{t('Architecture generation')}</h3><dl><dt>{t('Workspace')}</dt><dd>{workspaceName(generation.workspaceId)}</dd><dt>{t('Analyzer')}</dt><dd>{generation.analyzerId}</dd><dt>{t('Generation')}</dt><dd>{generation.generationId}</dd><dt>{t('Run')}</dt><dd><code>{generation.runId}</code></dd><dt>{t('Completed')}</dt><dd>{generation.completedAt}</dd>{generation.sourceRevision && <><dt>{t('Revision')}</dt><dd>{generation.sourceRevision}</dd></>}</dl></section>}</>}
      {selectedEdge && <dl><dt>{t('Source')}</dt><dd><code>{selectedEdge.sourceId}</code></dd><dt>{t('Target')}</dt><dd><code>{selectedEdge.targetId}</code></dd><dt>{t('Relationship')}</dt><dd>{selectedEdge.kind}</dd><dt>{t('Scope')}</dt><dd>{t(selectedEdge.scope === 'cross-workspace' ? 'Cross-workspace transition' : 'Within workspace')}</dd></dl>}
      <details open><summary>{t('Properties')}</summary><pre>{JSON.stringify(item.properties, null, 2)}</pre></details>
      <section><h3>{t('Evidence')}</h3>{evidence?.length ? <ul>{evidence.map((entry) => <li key={entry.id}><strong>{entry.level} · {entry.type}</strong><ul>{entry.sources.map((source, index) => <li key={`${source.workspaceId}:${source.generationId}:${index}`}>{workspaceName(source.workspaceId)} · {source.analyzerId} {t('generation')} {source.generationId}<br/><code>{source.evidenceIds.join(', ') || t('No source evidence IDs')}</code></li>)}</ul></li>)}</ul> : selectedEdge?.evidence.length ? <ul>{selectedEdge.evidence.map((entry) => <li key={entry.id}><strong>{entry.level} · {entry.type}</strong><p>{entry.sources.map((source) => `${workspaceName(source.workspaceId)} · ${source.analyzerId} ${t('generation')} ${source.generationId}`).join(' / ')}</p></li>)}</ul> : <p className="impact-muted">{result.evidence === undefined ? t('Evidence was not requested.') : t('No evidence is attached to this item in the selected snapshot.')}</p>}</section>
    </>}
    <section><h3>{t('Findings')}</h3>{findings.length ? <ul>{findings.map((finding) => <li key={finding.id}><strong>{finding.label}</strong><p>{finding.kind}</p><pre>{JSON.stringify(finding.properties, null, 2)}</pre></li>)}</ul> : <p className="impact-muted">{t('No architecture findings are attached to the selected neighborhood.')}</p>}</section>
    {result.diagnostics && <details><summary>{t('Diagnostics')} · {result.diagnostics.length}</summary>{result.diagnostics.length ? <ul>{result.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}:${index}`}><strong>{diagnostic.severity} · {diagnostic.code ?? t('diagnostic')}</strong><p>{diagnostic.message}</p>{diagnostic.uri && <code>{diagnostic.uri}{diagnostic.line ? `:${diagnostic.line}` : ''}</code>}</li>)}</ul> : <p className="impact-muted">{t('No diagnostics in this snapshot.')}</p>}</details>}
    <section><h3>{t('Generation vector')}</h3><ul>{result.snapshot.generations.map((entry) => <li key={`${entry.workspaceId}:${entry.generationId}`}>{workspaceName(entry.workspaceId)} · {entry.analyzerId} #{entry.generationId}</li>)}</ul><h3>{t('Analyzer input generations')}</h3>{result.snapshot.inputGenerations.length ? <ul>{result.snapshot.inputGenerations.map((entry) => <li key={`${entry.workspaceId}:${entry.analyzerId}:${entry.generationId}`}>{workspaceName(entry.workspaceId)} · {entry.analyzerId} #{entry.generationId}</li>)}</ul> : <p className="impact-muted">{t('No upstream analyzer inputs recorded.')}</p>}<p className="impact-muted">Snapshot {result.snapshot.id}</p></section>
    {result.scope.missingArchitectureWorkspaceIds.length > 0 && <p className="impact-notice">No active architecture generation in: {result.scope.missingArchitectureWorkspaceIds.map(workspaceName).join(', ')}.</p>}
  </aside>;
}
