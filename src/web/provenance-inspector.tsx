import React from 'react';
import { SourceEvidenceButton } from './source-viewer.js';
import './source-provenance.css';

export type Owner = { analyzerId: string; generationId: number };
export type ProvenanceEvidence = {
  id?: string; type: string; level?: string; uri?: string; line?: number; column?: number;
  endLine?: number; endColumn?: number; startOffset?: number; endOffset?: number;
  workspaceId?: string; analyzerId?: string; generationId?: number; provenance?: Record<string, unknown>; detail?: string;
};
export type ProvenanceItem = {
  workspaceId?: string; analyzerId?: string; generationId?: number; level?: string;
  contributors?: Owner[]; properties?: Record<string, unknown>;
  propertySources?: Record<string, Owner[]>;
  propertyConflicts?: Array<{ property: string; values: Array<{ value: unknown; owner: Owner }> }>;
  evidenceCount?: number; evidence?: ProvenanceEvidence[];
};

type SourceReference = { workspaceId: string; analyzerId: string; generationId: number; evidenceId: string };
type SourceReferences = { references: SourceReference[]; incomplete: boolean };
function sourceReferences(evidence: ProvenanceEvidence, item: ProvenanceItem, inputGenerations: Owner[]): SourceReferences {
  const provenance = evidence.provenance;
  const workspaceId = evidence.workspaceId ?? item.workspaceId;
  if (provenance && Array.isArray(provenance.sources)) {
    const references: SourceReference[] = [];
    let incomplete = false;
    for (const value of provenance.sources) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { incomplete = true; continue; }
      const source = value as Record<string, unknown>;
      if (typeof source.analyzerId !== 'string' || !source.analyzerId || typeof source.evidenceId !== 'string' || !source.evidenceId) { incomplete = true; continue; }
      const matches = inputGenerations.filter(input => input.analyzerId === source.analyzerId);
      const hasGeneration = Object.hasOwn(source, 'generationId') && source.generationId !== null && source.generationId !== undefined;
      const generationId = hasGeneration ? Number.isSafeInteger(source.generationId) && Number(source.generationId) > 0 ? Number(source.generationId) : undefined : matches.length === 1 ? matches[0]!.generationId : undefined;
      const sourceWorkspaceId = typeof source.workspaceId === 'string' && source.workspaceId ? source.workspaceId : undefined;
      if (typeof sourceWorkspaceId !== 'string' || !sourceWorkspaceId || generationId === undefined) { incomplete = true; continue; }
      references.push({ workspaceId: sourceWorkspaceId, analyzerId: source.analyzerId, generationId, evidenceId: source.evidenceId });
    }
    return { references: dedupeReferences(references), incomplete: incomplete || references.length === 0 };
  }
  if (provenance && ['analyzerId', 'generationId', 'sourceEvidenceId', 'sources'].some(key => Object.hasOwn(provenance, key))) {
    if (typeof provenance.analyzerId !== 'string' || !provenance.analyzerId || !Number.isSafeInteger(provenance.generationId) || Number(provenance.generationId) < 1 || typeof provenance.sourceEvidenceId !== 'string' || !provenance.sourceEvidenceId) return { references: [], incomplete: true };
    const sourceWorkspaceId = Object.hasOwn(provenance, 'workspaceId') ? typeof provenance.workspaceId === 'string' && provenance.workspaceId ? provenance.workspaceId : undefined : workspaceId;
    return typeof sourceWorkspaceId === 'string' && sourceWorkspaceId ? { references: [{ workspaceId: sourceWorkspaceId, analyzerId: provenance.analyzerId, generationId: provenance.generationId as number, evidenceId: provenance.sourceEvidenceId }], incomplete: false } : { references: [], incomplete: true };
  }
  if (evidence.analyzerId && Number.isSafeInteger(evidence.generationId) && Number(evidence.generationId) > 0 && evidence.id) {
    return workspaceId ? { references: [{ workspaceId, analyzerId: evidence.analyzerId, generationId: evidence.generationId!, evidenceId: evidence.id }], incomplete: false } : { references: [], incomplete: true };
  }
  return { references: [], incomplete: true };
}

function dedupeReferences(references: SourceReference[]): SourceReference[] {
  const seen = new Set<string>();
  return references.filter(reference => {
    const key = JSON.stringify([reference.workspaceId, reference.analyzerId, reference.generationId, reference.evidenceId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Common evidence and contribution view used by all graph inspectors. */
export function ProvenanceInspector({ item, compact = false, inputGenerations = [] }: { item: ProvenanceItem; compact?: boolean; inputGenerations?: Owner[] }) {
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
      const refs = sourceReferences(entry, item, inputGenerations);
      const location = entry.uri ? `${entry.uri}${entry.line ? `:${entry.line}` : ''}${entry.column !== undefined ? `:${entry.column}` : ''}` : 'Source location not recorded';
      const exact = [entry.line !== undefined && `line ${entry.line}`, entry.column !== undefined && `column ${entry.column}`, entry.endLine !== undefined && `end line ${entry.endLine}`, entry.endColumn !== undefined && `end column ${entry.endColumn}`, entry.startOffset !== undefined && `start offset ${entry.startOffset}`, entry.endOffset !== undefined && `end offset ${entry.endOffset}`].filter(Boolean).join(' · ');
      const provenanceId = entry.id ?? `${entry.type}-${index}`;
      return <li key={provenanceId}><strong>{entry.level ?? 'Unknown'} · {entry.type}</strong><p><code>{location}</code></p>{exact && <p>{exact}</p>}{refs.references.length > 0 && <ul aria-label="Exact source references">{refs.references.map(reference => <li key={`${reference.workspaceId}:${reference.analyzerId}:${reference.generationId}:${reference.evidenceId}`}><code>{reference.workspaceId} · {reference.analyzerId} #{reference.generationId} · {reference.evidenceId}</code><SourceEvidenceButton source={reference}/></li>)}</ul>}{refs.incomplete && <p role="note">Some original source references are incomplete or unavailable; no owner was inferred.</p>}{entry.detail && <p>{entry.detail}</p>}
        {refs.references.length === 0 && !refs.incomplete && <span>Original evidence reference was not recorded.</span>}
      </li>;
    })}</ul> : <p>{item.evidenceCount ? 'Evidence details were not included.' : 'No evidence was recorded.'}</p>}
  </section>;
}
