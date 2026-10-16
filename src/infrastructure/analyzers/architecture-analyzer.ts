import { createHash } from 'node:crypto';
import { AnalysisError, type AnalysisContext, type AnalysisDiagnostic, type Analyzer, type AnalysisResult, type ArchitectureInputGeneration } from '../../domain/analyzer.js';
import { architectureConfig, resolveArchitecture } from './architecture-resolver.js';

const INPUT_IDS = ['builtin.codegraph', 'builtin.fastapi', 'builtin.openapi', 'builtin.sqlalchemy', 'builtin.frontend-http'] as const;
const VERSION = 'architecture-v2';

export const architectureAnalyzer: Analyzer = {
  descriptor: { id: 'builtin.architecture', version: '1.0.0', apiVersion: '1', capabilities: ['graph', 'evidence', 'diagnostics'] },
  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    if (!context.architectureInputProvider) throw new AnalysisError('INPUT_GENERATION_UNAVAILABLE', 'Architecture input provider is unavailable.');
    let snapshot;
    try { snapshot = context.architectureInputProvider.snapshot(INPUT_IDS); }
    catch (error) {
      if (error instanceof AnalysisError) throw error;
      throw new AnalysisError('INPUT_GENERATION_UNAVAILABLE', error instanceof Error ? error.message : String(error));
    }
    const codeGraph = snapshot.generations.find(({ analyzerId }) => analyzerId === 'builtin.codegraph');
    const catalog = context.sourceCatalogReader?.snapshot();
    const diagnostics: AnalysisDiagnostic[] = snapshot.missingAnalyzerIds.map((analyzerId) => ({ code: 'ARCHITECTURE_INPUT_MISSING', severity: 'info', message: `No active generation is available for optional input '${analyzerId}'.`, detail: { analyzerId } }));
    const codeGraphIsCurrent = !!codeGraph && codeGraph.identityVersion === 2 && catalog?.identityVersion === 2 && catalog.input.generationId === codeGraph.generationId;
    if ((codeGraph?.identityVersion === 2 && !codeGraphIsCurrent) || (!codeGraph && catalog?.identityVersion === 2)) {
      throw new AnalysisError('INPUT_GENERATION_CHANGED', 'CodeGraph source catalog changed while Architecture inputs were being read. Retry the analysis.');
    }
    const accepted = snapshot.generations.filter((generation) => {
      if (generation.analyzerId === 'builtin.openapi') return true;
      if (generation.analyzerId === 'builtin.codegraph') return codeGraphIsCurrent;
      if (['builtin.fastapi', 'builtin.sqlalchemy', 'builtin.frontend-http'].includes(generation.analyzerId)) {
        return codeGraphIsCurrent && generation.identityVersion === 2 && generation.inputGenerations?.some((input) => input.analyzerId === 'builtin.codegraph' && input.generationId === codeGraph!.generationId) === true;
      }
      return false;
    });
    if (!codeGraphIsCurrent) diagnostics.push({ code: 'ARCHITECTURE_CODEGRAPH_SOURCE_UNAVAILABLE', severity: 'info', message: 'CodeGraph identity-v2 source data is unavailable or stale; source-dependent symbol traversal is omitted.' });
    if (!accepted.some(({ analyzerId }) => ['builtin.fastapi', 'builtin.openapi', 'builtin.frontend-http'].includes(analyzerId))) {
      throw new AnalysisError('INPUT_GENERATION_UNAVAILABLE', 'Architecture analysis requires an active FastAPI, OpenAPI, or frontend HTTP generation.');
    }
    const byId = new Map(accepted.map((generation) => [generation.analyzerId, generation]));
    const result = resolveArchitecture({
      workspaceId: context.workspace.id,
      codeGraph: byId.get('builtin.codegraph'),
      fastApi: byId.get('builtin.fastapi') as ArchitectureInputGeneration | undefined,
      openApi: byId.get('builtin.openapi') as ArchitectureInputGeneration | undefined,
      sqlAlchemy: byId.get('builtin.sqlalchemy') as ArchitectureInputGeneration | undefined,
      frontendHttp: byId.get('builtin.frontend-http') as ArchitectureInputGeneration | undefined,
    }, context.config);
    const sourceRevision = revision(architectureConfig(context.config), accepted);
    if (context.sourceRevision !== undefined && context.sourceRevision !== sourceRevision) throw new AnalysisError('INVALID_RESULT', 'Computed architecture source revision does not match the requested revision.', [{ code: 'SOURCE_REVISION_MISMATCH', severity: 'error', message: 'Computed architecture source revision does not match the requested revision.' }]);
    return { ...result, inputGenerations: accepted.map(({ analyzerId, generationId }) => ({ analyzerId, generationId })), diagnostics: [...diagnostics, ...result.diagnostics], sourceRevision };
  },
};

function revision(config: Record<string, unknown>, generations: readonly ArchitectureInputGeneration[]): string {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : value;
  const inputs = generations.map(({ analyzerId, generationId, sourceRevision }) => ({ analyzerId, generationId, sourceRevision: sourceRevision ?? null })).sort((a, b) => a.analyzerId.localeCompare(b.analyzerId));
  const hash = createHash('sha256').update(JSON.stringify([VERSION, sorted(config), inputs])).digest('hex');
  return `${VERSION}:${hash}`;
}
