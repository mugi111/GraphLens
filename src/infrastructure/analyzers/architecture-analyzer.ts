import { createHash } from 'node:crypto';
import { AnalysisError, type AnalysisContext, type AnalysisDiagnostic, type Analyzer, type AnalysisResult, type ArchitectureInputGeneration } from '../../domain/analyzer.js';
import { resolveArchitecture } from './architecture-resolver.js';

const INPUT_IDS = ['builtin.fastapi', 'builtin.openapi', 'builtin.sqlalchemy'] as const;
const VERSION = 'architecture-v1';

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
    if (!snapshot.generations.some(({ analyzerId }) => analyzerId === 'builtin.fastapi' || analyzerId === 'builtin.openapi')) {
      throw new AnalysisError('INPUT_GENERATION_UNAVAILABLE', 'Architecture analysis requires an active FastAPI or OpenAPI generation.');
    }
    const byId = new Map(snapshot.generations.map((generation) => [generation.analyzerId, generation]));
    const diagnostics: AnalysisDiagnostic[] = snapshot.missingAnalyzerIds.map((analyzerId) => ({ code: 'ARCHITECTURE_INPUT_MISSING', severity: 'info', message: `No active generation is available for optional input '${analyzerId}'.`, detail: { analyzerId } }));
    const result = resolveArchitecture({
      workspaceId: context.workspace.id,
      fastApi: byId.get('builtin.fastapi') as ArchitectureInputGeneration | undefined,
      openApi: byId.get('builtin.openapi') as ArchitectureInputGeneration | undefined,
      sqlAlchemy: byId.get('builtin.sqlalchemy') as ArchitectureInputGeneration | undefined,
    }, context.config);
    const sourceRevision = revision(context.config, snapshot.generations);
    if (context.sourceRevision !== undefined && context.sourceRevision !== sourceRevision) throw new AnalysisError('INVALID_RESULT', 'Computed architecture source revision does not match the requested revision.', [{ code: 'SOURCE_REVISION_MISMATCH', severity: 'error', message: 'Computed architecture source revision does not match the requested revision.' }]);
    return { ...result, diagnostics: [...diagnostics, ...result.diagnostics], sourceRevision };
  },
};

function revision(config: Record<string, unknown>, generations: readonly ArchitectureInputGeneration[]): string {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : value;
  const inputs = generations.map(({ analyzerId, generationId, sourceRevision }) => ({ analyzerId, generationId, sourceRevision: sourceRevision ?? null })).sort((a, b) => a.analyzerId.localeCompare(b.analyzerId));
  const hash = createHash('sha256').update(JSON.stringify([VERSION, sorted(config), inputs])).digest('hex');
  return `${VERSION}:${hash}`;
}
