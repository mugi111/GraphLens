import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Node as YamlNode, type Pair } from 'yaml';
import type { AnalysisEvidence, AnalysisDiagnostic } from '../../domain/analyzer.js';
import type { OpenApiSourceFile } from './openapi-source.js';

export type OpenApiDocument = { file: OpenApiSourceFile; value: Record<string, unknown>; root: YamlNode; evidence(node: YamlNode | undefined, type: string): AnalysisEvidence | undefined };

export function parseOpenApiDocument(file: OpenApiSourceFile): OpenApiDocument {
  const lineCounter = new LineCounter();
  const document = parseDocument(file.source, { version: '1.2', schema: 'core', strict: true, uniqueKeys: true, merge: false, resolveKnownTags: false, customTags: [], lineCounter });
  if (document.errors.length) throw new Error(`Invalid document '${file.path}': ${document.errors[0]!.message}`);
  if (document.warnings.length) throw new Error(`Unsupported YAML feature in '${file.path}': ${document.warnings[0]!.message}`);
  if (!document.contents || !isMap(document.contents)) throw new Error(`OpenAPI document '${file.path}' must have a mapping at its root.`);
  let value: unknown;
  try { value = document.toJS({ maxAliasCount: 0, mapAsMap: false }); }
  catch (error) { throw new Error(`Invalid JSON/YAML value in '${file.path}': ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`OpenAPI document '${file.path}' must contain an object.`);
  if (file.path.toLowerCase().endsWith('.json')) {
    try { JSON.parse(file.source); } catch (error) { throw new Error(`Invalid JSON in '${file.path}': ${error instanceof Error ? error.message : String(error)}`); }
  }
  const root = document.contents;
  return { file, value: value as Record<string, unknown>, root, evidence: (node, type) => {
    const range = node?.range;
    if (!range) return undefined;
    const start = lineCounter.linePos(range[0]);
    const end = lineCounter.linePos(Math.max(range[0], range[1] - 1));
    return { id: '', subjectKind: 'node', subjectId: '', level: 'DIRECT', type, uri: file.path, line: start.line, column: start.col, endLine: end.line, endColumn: end.col, startOffset: range[0], endOffset: range[1] };
  } };
}

export function pairs(node: YamlNode | undefined): Array<[string, YamlNode]> {
  if (!node || !isMap(node)) return [];
  return node.items.flatMap((item: Pair) => isScalar(item.key) && typeof item.key.value === 'string' && item.value ? [[item.key.value, item.value as YamlNode] as [string, YamlNode]] : []);
}
export function seq(node: YamlNode | undefined): YamlNode[] { return node && isSeq(node) ? node.items.filter((item): item is YamlNode => !!item && typeof item === 'object') : []; }
export function property(node: YamlNode | undefined, name: string): YamlNode | undefined { return pairs(node).find(([key]) => key === name)?.[1]; }
export function scalar(node: YamlNode | undefined): unknown { return node && isScalar(node) ? node.value : undefined; }
export function objectValue(node: YamlNode | undefined): Record<string, unknown> | undefined { const value = node && isMap(node) ? node.toJSON() : undefined; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
export function diagnosticsForDocument(file: OpenApiSourceFile): AnalysisDiagnostic[] { return [{ code: 'OPENAPI_DOCUMENT_IGNORED', severity: 'info', message: `Document '${file.path}' does not declare a supported OpenAPI version.`, uri: file.path }]; }
