import React from 'react';
import { SourceEvidenceButton } from './source-viewer.js';
import './source-provenance.css';

export type Owner = { analyzerId: string; generationId: number };
export type ProvenanceEvidence = {
  id?: string; type: string; level?: string; uri?: string; line?: number; column?: number;
  endLine?: number; endColumn?: number; startOffset?: number; endOffset?: number;
  analyzerId?: string; generationId?: number; provenance?: Record<string, unknown>; detail?: string;
};
export type ProvenanceItem = {
  workspaceId?: string; analyzerId?: string; generationId?: number; level?: string;
  contributors?: Owner[]; properties?: Record<string, unknown>;
  propertySources?: Record<string, Owner[]>;
  propertyConflicts?: Array<{ property: string; values: Array<{ value: unknown; owner: Owner }> }>;
  evidenceCount?: number; evidence?: ProvenanceEvidence[];
};

function sourceReference(evidence: ProvenanceEvidence, item: ProvenanceItem, owners: Owner[]): { owner: Owner; evidenceId: string } | undefined {
  if (evidence.analyzerId && Number.isSafeInteger(evidence.generationId)) return { owner: { analyzerId: evidence.analyzerId, generationId: evidence.generationId! }, evidenceId: evidence.id ?? '' };
  const provenance = evidence.provenance;
  if (provenance && typeof provenance.analyzerId === 'string' && Number.isSafeInteger(provenance.generationId)) return { owner: { analyzerId: provenance.analyzerId, generationId: provenance.generationId as number }, evidenceId: typeof provenance.sourceEvidenceId === 'string' ? provenance.sourceEvidenceId : evidence.id ?? '' };
  if (provenance && Array.isArray(provenance.sources)) {
    const first = provenance.sources.find(value => value && typeof value === 'object' && typeof (value as Record<string, unknown>).analyzerId === 'string') as Record<string, unknown> | undefined;
    if (first && typeof first.analyzerId === 'string') {
      const owner = typeof first.generationId === 'number' ? { analyzerId: first.analyzerId, generationId: first.generationId } : owners.find(candidate => candidate.analyzerId === first.analyzerId);
      if (owner) return { owner, evidenceId: typeof first.evidenceId === 'string' ? first.evidenceId : evidence.id ?? '' };
    }
  }
  if (item.analyzerId && Number.isSafeInteger(item.generationId)) return { owner: { analyzerId: item.analyzerId, generationId: item.generationId! }, evidenceId: evidence.id ?? '' };
  return undefined;
}

/** Common evidence and contribution view used by all graph inspectors. */
export function ProvenanceInspector({ item, compact = false }: { item: ProvenanceItem; compact?: boolean }) {
  const contributors = item.contributors?.length ? item.contributors : item.analyzerId && Number.isSafeInteger(item.generationId) ? [{ analyzerId: item.analyzerId, generationId: item.generationId! }] : [];
  const evidence = item.evidence ?? [];
  const conflicts = item.propertyConflicts ?? [];
  return <section className={`provenance-inspector${compact ? ' provenance-compact' : ''}`} aria-label="Provenance">
    <h3>Provenance</h3>
    <dl><dt>Representative analyzer</dt><dd>{item.analyzerId ?? contributors[0]?.analyzerId ?? 'Not recorded'}</dd>
      <dt>Generation</dt><dd>{item.generationId ?? contributors[0]?.generationId ?? 'Not recorded'}</dd>
      <dt>Evidence level</dt><dd>{item.level ?? (evidence.length ? evidence.map(value => value.level ?? 'Unknown').join(', ') : 'Not recorded')}</dd></dl>
    <h4>Contributors ({contributors.length})</h4>{contributors.length ? <ul>{contributors.map(owner => <li key={`${owner.analyzerId}:${owner.generationId}`}><code>{owner.analyzerId} #{owner.generationId}</code></li>)}</ul> : <p>Contributor ownership was not recorded.</p>}
    <h4>Property sources and conflicts</h4>
    {item.properties && Object.keys(item.properties).length ? <ul>{Object.entries(item.properties).map(([property, value]) => {
      const sources = item.propertySources?.[property] ?? [];
      return <li key={property}><strong>{property}</strong>: <code>{JSON.stringify(value)}</code>{sources.length ? <span> · from {sources.map(source => `${source.analyzerId} #${source.generationId}`).join(', ')}</span> : <span> · source not recorded</span>}
      </li>;
    })}</ul> : <p>Properties were not included.</p>}
    <h4>Property conflicts ({conflicts.length})</h4>{conflicts.length ? <ul>{conflicts.map(conflict => <li key={conflict.property}><strong>{conflict.property}</strong><ul>{conflict.values.map((entry, index) => <li key={`${entry.owner.analyzerId}:${entry.owner.generationId}:${index}`}><code>{JSON.stringify(entry.value)}</code> · {entry.owner.analyzerId} #{entry.owner.generationId}</li>)}</ul></li>)}</ul> : <p>No property conflicts were recorded.</p>}
    <h4>Evidence ({item.evidenceCount ?? evidence.length})</h4>{evidence.length ? <ul>{evidence.map((entry, index) => {
      const reference = sourceReference(entry, item, contributors);
      const owner = reference?.owner;
      const location = entry.uri ? `${entry.uri}${entry.line ? `:${entry.line}` : ''}${entry.column !== undefined ? `:${entry.column}` : ''}` : 'Source location not recorded';
      const exact = [entry.line !== undefined && `line ${entry.line}`, entry.column !== undefined && `column ${entry.column}`, entry.endLine !== undefined && `end line ${entry.endLine}`, entry.endColumn !== undefined && `end column ${entry.endColumn}`, entry.startOffset !== undefined && `start offset ${entry.startOffset}`, entry.endOffset !== undefined && `end offset ${entry.endOffset}`].filter(Boolean).join(' · ');
      const provenanceId = entry.id ?? `${entry.type}-${index}`;
      return <li key={provenanceId}><strong>{entry.level ?? 'Unknown'} · {entry.type}</strong><p><code>{location}</code></p>{exact && <p>{exact}</p>}{reference?.evidenceId && <p>Evidence ID: <code>{reference.evidenceId}</code>{owner ? ` · ${owner.analyzerId} #${owner.generationId}` : ''}</p>}{entry.detail && <p>{entry.detail}</p>}
        {owner && item.workspaceId && reference?.evidenceId && entry.uri ? <SourceEvidenceButton source={{ workspaceId: item.workspaceId, analyzerId: owner.analyzerId, generationId: owner.generationId, evidenceId: reference.evidenceId }}/> : <span>Original evidence owner or navigable source reference was not recorded.</span>}
      </li>;
    })}</ul> : <p>{item.evidenceCount ? 'Evidence details were not included.' : 'No evidence was recorded.'}</p>}
  </section>;
}
