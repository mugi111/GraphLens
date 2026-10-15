import { AnalysisError, type AnalysisDiagnostic, type AnalysisEvidence, type AnalysisResult, type AnalyzerDescriptor, type JsonValue } from '../domain/analyzer.js';
import type { GraphEdge, GraphNode } from '../domain/graph.js';

const MAX_ITEMS = 10_000;
const MAX_TEXT = 10_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/;
const ANALYZER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Validates untrusted analyzer output before it is allowed into an immutable generation. */
export function validateAnalysisResult(result: AnalysisResult, descriptor: AnalyzerDescriptor, workspaceId: string, activeIds: { nodes: ReadonlySet<string>; edges: ReadonlySet<string> }): void {
  const errors: AnalysisDiagnostic[] = [];
  if (!result || !Array.isArray(result.nodes) || !Array.isArray(result.edges) || !Array.isArray(result.evidence) || !Array.isArray(result.diagnostics)) {
    fail(['Analysis result must contain nodes, edges, evidence, and diagnostics arrays.']);
  }
  if (result.sourceRevision !== undefined && (typeof result.sourceRevision !== 'string' || result.sourceRevision.length < 1 || result.sourceRevision.length > 255)) errors.push(diagnostic('INVALID_SOURCE_REVISION', 'Analysis source revision must contain 1 to 255 characters.'));
  const inputKeys = validateInputGenerations(result.inputGenerations, descriptor.id, errors);
  if (result.nodes.length > MAX_ITEMS || result.edges.length > MAX_ITEMS || result.evidence.length > MAX_ITEMS || result.diagnostics.length > MAX_ITEMS) fail(['Analysis result exceeds the item limit.']);
  if ((result.nodes.length || result.edges.length) && !descriptor.capabilities.includes('graph')) errors.push(diagnostic('CAPABILITY_GRAPH_REQUIRED', 'Analyzer emitted graph contributions without the graph capability.'));
  if (result.evidence.length && !descriptor.capabilities.includes('evidence')) errors.push(diagnostic('CAPABILITY_EVIDENCE_REQUIRED', 'Analyzer emitted evidence without the evidence capability.'));
  if (result.diagnostics.length && !descriptor.capabilities.includes('diagnostics')) errors.push(diagnostic('CAPABILITY_DIAGNOSTICS_REQUIRED', 'Analyzer emitted diagnostics without the diagnostics capability.'));
  const nodes = unique(result.nodes, 'node', errors, (node) => validateNode(node, workspaceId, errors));
  const edges = unique(result.edges, 'edge', errors, (edge) => validateEdge(edge, workspaceId, errors));
  for (const edge of result.edges) if (!nodes.has(edge.sourceId) && !activeIds.nodes.has(edge.sourceId)) errors.push(diagnostic('EDGE_SOURCE_MISSING', `Edge '${edge.id}' source '${edge.sourceId}' is unavailable.`));
  for (const edge of result.edges) if (!nodes.has(edge.targetId) && !activeIds.nodes.has(edge.targetId)) errors.push(diagnostic('EDGE_TARGET_MISSING', `Edge '${edge.id}' target '${edge.targetId}' is unavailable.`));
  const evidenceIds = new Set<string>();
  const attached = new Set<string>();
  for (const evidence of result.evidence) validateEvidence(evidence, nodes, edges, evidenceIds, attached, errors, inputKeys);
  for (const node of result.nodes) if (!attached.has(`node:${node.id}`)) errors.push(diagnostic('NODE_EVIDENCE_REQUIRED', `Node '${node.id}' has no evidence.`));
  for (const edge of result.edges) if (!attached.has(`edge:${edge.id}`)) errors.push(diagnostic('EDGE_EVIDENCE_REQUIRED', `Edge '${edge.id}' has no evidence.`));
  for (const item of result.diagnostics) {
    if (!validDiagnostic(item)) errors.push(diagnostic('INVALID_DIAGNOSTIC', 'Analyzer emitted an invalid diagnostic.'));
    else if (item.severity === 'error') errors.push(diagnostic(item.code ?? 'ANALYZER_ERROR_DIAGNOSTIC', item.message));
  }
  if (errors.length) throw new AnalysisError('INVALID_RESULT', errors[0].message, errors);
}

function unique<T extends { id: string }>(items: T[], kind: string, errors: AnalysisDiagnostic[], validate: (item: T) => void) { const ids = new Set<string>(); for (const item of items) { if (!ID.test(item.id)) errors.push(diagnostic('INVALID_ID', `${kind} has an invalid stable id.`)); else if (ids.has(item.id)) errors.push(diagnostic('DUPLICATE_ID', `Duplicate ${kind} id '${item.id}'.`)); ids.add(item.id); validate(item); } return ids; }
function validateNode(node: GraphNode, workspaceId: string, errors: AnalysisDiagnostic[]) { if (node.workspaceId !== workspaceId) errors.push(diagnostic('WORKSPACE_MISMATCH', `Node '${node.id}' belongs to another workspace.`)); if (!text(node.kind) || !text(node.label) || !json(node.properties)) errors.push(diagnostic('INVALID_NODE', `Node '${node.id}' is not JSON-shaped.`)); }
function validateEdge(edge: GraphEdge, workspaceId: string, errors: AnalysisDiagnostic[]) { if (edge.workspaceId !== workspaceId) errors.push(diagnostic('WORKSPACE_MISMATCH', `Edge '${edge.id}' belongs to another workspace.`)); if (!ID.test(edge.sourceId) || !ID.test(edge.targetId) || !text(edge.kind) || !json(edge.properties)) errors.push(diagnostic('INVALID_EDGE', `Edge '${edge.id}' is not JSON-shaped.`)); }
function validateEvidence(e: AnalysisEvidence, nodes: Set<string>, edges: Set<string>, ids: Set<string>, attached: Set<string>, errors: AnalysisDiagnostic[], declaredInputs: ReadonlySet<string>) { const exists = e.subjectKind === 'node' ? nodes.has(e.subjectId) : e.subjectKind === 'edge' ? edges.has(e.subjectId) : false; if (!ID.test(e.id) || ids.has(e.id)) errors.push(diagnostic('DUPLICATE_EVIDENCE_ID', `Evidence '${e.id}' lacks a unique stable id.`)); ids.add(e.id); if (!exists) errors.push(diagnostic('EVIDENCE_SUBJECT_MISSING', `Evidence '${e.id}' refers to a missing subject.`)); else attached.add(`${e.subjectKind}:${e.subjectId}`); if (!['DIRECT', 'DERIVED', 'INFERRED'].includes(e.level) || !text(e.type) || (e.provenance !== undefined && !jsonRecord(e.provenance))) errors.push(diagnostic('INVALID_EVIDENCE', `Evidence '${e.id}' is invalid.`)); if (e.inputGenerations !== undefined) { if (!Array.isArray(e.inputGenerations) || e.inputGenerations.length > 32) errors.push(diagnostic('INVALID_EVIDENCE_INPUTS', `Evidence '${e.id}' has invalid input generations.`)); else { const uniqueKeys = new Set<string>(); for (const key of e.inputGenerations) { if (typeof key !== 'string' || !canonicalInputKey(key) || uniqueKeys.has(key) || !declaredInputs.has(key)) errors.push(diagnostic('INVALID_EVIDENCE_INPUTS', `Evidence '${e.id}' references an undeclared or noncanonical input generation.`)); uniqueKeys.add(key); } } } if (e.confidence !== undefined && (e.level !== 'INFERRED' || typeof e.confidence !== 'number' || e.confidence < 0 || e.confidence > 1)) errors.push(diagnostic('INVALID_CONFIDENCE', `Evidence '${e.id}' has an invalid confidence.`)); if ((e.uri !== undefined && !text(e.uri)) || (e.line !== undefined && (!Number.isInteger(e.line) || e.line < 1)) || !validRange(e) || (e.detail !== undefined && !text(e.detail))) errors.push(diagnostic('INVALID_EVIDENCE_LOCATION', `Evidence '${e.id}' has an invalid location.`)); }
function validateInputGenerations(value: unknown, analyzerId: string, errors: AnalysisDiagnostic[]): Set<string> {
  const keys = new Set<string>();
  if (value === undefined) return keys;
  if (!Array.isArray(value) || value.length > 32) { errors.push(diagnostic('INVALID_INPUT_GENERATIONS', 'Analysis inputGenerations must contain at most 32 entries.')); return keys; }
  const analyzers = new Set<string>(), generations = new Set<number>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'analyzerId,generationId') { errors.push(diagnostic('INVALID_INPUT_GENERATION', 'Each input generation must contain exactly analyzerId and generationId.')); continue; }
    const input = item as { analyzerId?: unknown; generationId?: unknown };
    if (typeof input.analyzerId !== 'string' || !ANALYZER_ID.test(input.analyzerId) || typeof input.generationId !== 'number' || !Number.isSafeInteger(input.generationId) || input.generationId < 1) { errors.push(diagnostic('INVALID_INPUT_GENERATION', 'Input generation identity is invalid.')); continue; }
    if (input.analyzerId === analyzerId) errors.push(diagnostic('SELF_INPUT_GENERATION', 'An analyzer cannot depend on its own active generation.'));
    if (analyzers.has(input.analyzerId) || generations.has(input.generationId)) errors.push(diagnostic('DUPLICATE_INPUT_GENERATION', 'Input generations must be unique by analyzer and generation.'));
    analyzers.add(input.analyzerId); generations.add(input.generationId); keys.add(`${input.analyzerId}:${input.generationId}`);
  }
  return keys;
}
function canonicalInputKey(value: string): boolean { const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([1-9][0-9]*)$/.exec(value); if (!match) return false; const generationId = Number(match[2]); return Number.isSafeInteger(generationId) && generationId > 0 && value === `${match[1]}:${generationId}`; }
function validRange(e: AnalysisEvidence) { const ints = [e.column, e.endLine, e.endColumn, e.startOffset, e.endOffset]; if (ints.some((value) => value !== undefined && (!Number.isInteger(value) || value < 0))) return false; if (e.column !== undefined && e.column < 1 || e.endLine !== undefined && e.endLine < 1 || e.endColumn !== undefined && e.endColumn < 1) return false; if (e.endLine !== undefined && (e.line === undefined || e.endLine < e.line)) return false; if (e.endLine === e.line && e.endColumn !== undefined && e.column !== undefined && e.endColumn < e.column) return false; if (e.endOffset !== undefined && (e.startOffset === undefined || e.endOffset < e.startOffset)) return false; return true; }
function validDiagnostic(value: AnalysisDiagnostic) { return ['info', 'warning', 'error'].includes(value.severity) && text(value.message) && (value.code === undefined || text(value.code)) && (value.uri === undefined || text(value.uri)) && (value.line === undefined || (Number.isInteger(value.line) && value.line > 0)) && (value.detail === undefined || json(value.detail)); }
function json(value: unknown, depth = 0): value is JsonValue { if (depth > 16) return false; if (value === null || typeof value === 'boolean') return true; if (typeof value === 'number') return Number.isFinite(value); if (typeof value === 'string') return value.length <= MAX_TEXT; if (Array.isArray(value)) return value.length <= MAX_ITEMS && value.every((item) => json(item, depth + 1)); return typeof value === 'object' && value !== null && Object.keys(value).length <= MAX_ITEMS && Object.values(value as Record<string, unknown>).every((item) => json(item, depth + 1)); }
function jsonRecord(value: unknown): value is Record<string, JsonValue> { return typeof value === 'object' && value !== null && !Array.isArray(value) && json(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT; }
function diagnostic(code: string, message: string): AnalysisDiagnostic { return { code, severity: 'error', message }; }
function fail(messages: string[]): never { throw new AnalysisError('INVALID_RESULT', messages[0], messages.map((message) => diagnostic('INVALID_RESULT_SHAPE', message))); }
