import type { ContributionOwner, GraphEdge, GraphNode, PropertyConflict } from '../domain/graph.js';
import type { Evidence } from '../domain/graph.js';

export class GraphProjectionError extends Error {
  constructor(public readonly code: 'STRUCTURAL_CONFLICT', message: string) { super(message); }
}

export function projectNodeContributions(contributions: readonly GraphNode[]): GraphNode {
  if (!contributions.length) throw new Error('Cannot project an empty node contribution set.');
  const ordered = [...contributions].sort(compareContribution);
  const base = ordered[0];
  if (ordered.some((item) => item.workspaceId !== base.workspaceId || item.id !== base.id || item.kind !== base.kind)) {
    throw new GraphProjectionError('STRUCTURAL_CONFLICT', `Node identity '${base.workspaceId}:${base.id}' has incompatible structural contributions.`);
  }
  const merged = mergeProperties(ordered.map((item) => ({ properties: item.properties, owner: owner(item) })));
  const labelValues = new Map<string, { value: string; owner: ContributionOwner }>();
  for (const item of ordered) labelValues.set(stable(item.label), { value: item.label, owner: owner(item) });
  if (labelValues.size > 1) merged.conflicts.push({ property: '$label', values: [...labelValues.values()] });
  const evidence = mergeEvidence(ordered.flatMap((item) => item.evidence ?? []));
  const contributors = uniqueOwners(ordered.map(owner));
  return {
    ...base,
    label: base.label,
    properties: merged.properties,
    contributors,
    propertySources: merged.sources,
    propertyConflicts: merged.conflicts,
    evidence,
    evidenceCount: evidence.length,
  };
}

export function projectEdgeContributions(contributions: readonly GraphEdge[]): GraphEdge {
  if (!contributions.length) throw new Error('Cannot project an empty edge contribution set.');
  const ordered = [...contributions].sort(compareContribution);
  const base = ordered[0];
  if (ordered.some((item) => item.workspaceId !== base.workspaceId || item.id !== base.id || item.kind !== base.kind || item.sourceId !== base.sourceId || item.targetId !== base.targetId)) {
    throw new GraphProjectionError('STRUCTURAL_CONFLICT', `Relationship identity '${base.workspaceId}:${base.id}' has incompatible endpoints or kinds.`);
  }
  const merged = mergeProperties(ordered.map((item) => ({ properties: item.properties, owner: owner(item) })));
  const evidence = mergeEvidence(ordered.flatMap((item) => item.evidence ?? []));
  return {
    ...base,
    properties: merged.properties,
    contributors: uniqueOwners(ordered.map(owner)),
    propertySources: merged.sources,
    propertyConflicts: merged.conflicts,
    evidence,
    evidenceCount: evidence.length,
  };
}

function mergeProperties(inputs: Array<{ properties: Record<string, unknown>; owner: ContributionOwner }>) {
  const properties: Record<string, unknown> = {};
  const sources: Record<string, ContributionOwner[]> = {};
  const conflicts: PropertyConflict[] = [];
  const keys = [...new Set(inputs.flatMap((input) => Object.keys(input.properties)))].sort();
  for (const key of keys) {
    const values = inputs.flatMap((input) => Object.prototype.hasOwnProperty.call(input.properties, key) ? [{ value: input.properties[key], owner: input.owner }] : []);
    if (!values.length) continue;
    properties[key] = values[0].value;
    sources[key] = uniqueOwners(values.map((item) => item.owner));
    const distinct = new Map<string, { value: unknown; owner: ContributionOwner }>();
    for (const item of values) if (!distinct.has(stable(item.value))) distinct.set(stable(item.value), item);
    if (distinct.size > 1) conflicts.push({ property: key, values: [...distinct.values()] });
  }
  return { properties, sources, conflicts };
}

function mergeEvidence(items: Evidence[]): Evidence[] {
  const unique = new Map<string, Evidence>();
  for (const item of items) {
    const ownerKey = `${item.analyzerId ?? ''}:${item.generationId ?? ''}:${item.id ?? stable(item)}`;
    if (!unique.has(ownerKey)) unique.set(ownerKey, item);
  }
  return [...unique.values()].sort((a, b) => `${a.analyzerId}:${a.generationId}:${a.id}`.localeCompare(`${b.analyzerId}:${b.generationId}:${b.id}`));
}

function owner(item: { analyzerId?: string; generationId?: number }): ContributionOwner {
  if (!item.analyzerId || !Number.isSafeInteger(item.generationId)) throw new Error('Graph contribution is missing its analyzer/generation owner.');
  return { analyzerId: item.analyzerId, generationId: item.generationId! };
}
function uniqueOwners(items: ContributionOwner[]): ContributionOwner[] {
  const values = new Map(items.map((item) => [`${item.analyzerId}:${item.generationId}`, item]));
  return [...values.values()].sort((a, b) => ownerRank(a) - ownerRank(b) || a.analyzerId.localeCompare(b.analyzerId) || a.generationId - b.generationId);
}
function compareContribution(a: { analyzerId?: string; generationId?: number; level?: 'DIRECT' | 'DERIVED' | 'INFERRED' }, b: { analyzerId?: string; generationId?: number; level?: 'DIRECT' | 'DERIVED' | 'INFERRED' }) {
  const left = owner(a), right = owner(b);
  return ownerRank(left) - ownerRank(right) || evidenceRank(a.level) - evidenceRank(b.level) || left.analyzerId.localeCompare(right.analyzerId) || left.generationId - right.generationId;
}
function evidenceRank(level: 'DIRECT' | 'DERIVED' | 'INFERRED' | undefined) { return level === 'DIRECT' ? 0 : level === 'DERIVED' ? 1 : 2; }
function ownerRank(item: ContributionOwner) { return item.analyzerId === 'builtin.codegraph' ? 0 : 1; }
function stable(value: unknown): string { return JSON.stringify(canonical(value)) ?? String(value); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
