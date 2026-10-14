import { AnalysisError, type Analyzer, type AnalyzerCapability, type AnalyzerDescriptor } from '../domain/analyzer.js';

const API_VERSION = '1';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const capabilities = new Set<AnalyzerCapability>(['graph', 'evidence', 'diagnostics']);

/** In-memory registry for analyzers composed by the host process. */
export class AnalyzerRegistry {
  private readonly analyzers = new Map<string, Analyzer>();

  register(analyzer: Analyzer): void {
    validateDescriptor(analyzer.descriptor);
    if (this.analyzers.has(analyzer.descriptor.id)) {
      throw new AnalysisError('DUPLICATE_ANALYZER', `Analyzer '${analyzer.descriptor.id}' is already registered.`);
    }
    this.analyzers.set(analyzer.descriptor.id, analyzer);
  }

  get(id: string): Analyzer | undefined { return this.analyzers.get(id); }
  unregister(id: string): void { this.analyzers.delete(id); }
  list(): AnalyzerDescriptor[] { return [...this.analyzers.values()].map(({ descriptor }) => ({ ...descriptor, capabilities: [...descriptor.capabilities] })); }
}

export function validateDescriptor(descriptor: AnalyzerDescriptor): void {
  if (!descriptor || !ID.test(descriptor.id) || !nonEmpty(descriptor.version) || descriptor.apiVersion !== API_VERSION || !Array.isArray(descriptor.capabilities) || descriptor.capabilities.length === 0 || new Set(descriptor.capabilities).size !== descriptor.capabilities.length || descriptor.capabilities.some((capability) => !capabilities.has(capability))) {
    const code = descriptor?.apiVersion !== API_VERSION ? 'API_VERSION_UNSUPPORTED' : 'INVALID_DESCRIPTOR';
    throw new AnalysisError(code, `Analyzer descriptor for '${descriptor?.id ?? 'unknown'}' is invalid or incompatible with host API version ${API_VERSION}.`);
  }
}
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 128; }
