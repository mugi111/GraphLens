import React, { useEffect, useRef, useState } from 'react';
import './source-provenance.css';

type AnalyzerState = { analyzerId: string; activeGenerationId?: number; inputCodeGraphGenerationId?: number; mapping?: { contractVersion: string; input: { analyzerId: string; generationId: number }; counts: Record<string, number> }; latestRun?: { id: string; status: 'running' | 'succeeded' | 'failed'; errorCode?: string } };
type State = { workspaceId: string; activeSnapshotId: string; contract?: { identityVersion: number; provider: string; providerVersion: string; codegraphGenerationId: number }; reanalysisRequired: Array<{ analyzerId: string; requiredCodeGraphGenerationId: number; reason: string; createdAt: string }>; analyzers: AnalyzerState[] };
const ANALYZER_ORDER = ['builtin.codegraph', 'builtin.sqlalchemy', 'builtin.fastapi', 'builtin.frontend-http', 'builtin.architecture'];
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function parseState(value: unknown): State {
  if (!isRecord(value) || typeof value.workspaceId !== 'string' || typeof value.activeSnapshotId !== 'string' || !Array.isArray(value.analyzers) || !Array.isArray(value.reanalysisRequired)) throw new Error('Invalid workspace source state response.');
  return value as unknown as State;
}

/** Fetches reanalysis state independently of the selected graph query. */
export function useSourceState(workspaceId: string, graphSnapshotId?: string, refreshGraph?: () => void) {
  const [state, setState] = useState<State>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshFailed, setRefreshFailed] = useState(false);
  const request = useRef(0);
  const controller = useRef<AbortController>();
  const mismatchRefresh = useRef('');
  const load = async () => {
    const current = ++request.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/reanalysis`, { signal: abort.signal });
      const body: unknown = await response.json();
      if (current !== request.current) return;
      if (!response.ok) throw new Error(isRecord(body) && typeof body.error === 'string' ? body.error : 'Could not load source readiness.');
      const parsed = parseState(body);
      if (parsed.workspaceId !== workspaceId) throw new Error('The source state response belongs to another workspace.');
      setState(parsed);
    } catch (failure) {
      if (current === request.current && !abort.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load source readiness.');
    } finally { if (current === request.current) setLoading(false); }
  };
  useEffect(() => {
    request.current++; controller.current?.abort(); setState(undefined); setError(''); setRefreshFailed(false); mismatchRefresh.current = '';
    if (workspaceId) void load(); else setLoading(false);
    return () => { request.current++; controller.current?.abort(); };
  }, [workspaceId]);
  const mismatch = Boolean(state && graphSnapshotId && state.activeSnapshotId !== graphSnapshotId);
  useEffect(() => {
    if (!mismatch || !refreshGraph || !state) return;
    const key = `${workspaceId}:${state.activeSnapshotId}`;
    if (mismatchRefresh.current === key) return;
    mismatchRefresh.current = key;
    try { Promise.resolve(refreshGraph()).catch(() => setRefreshFailed(true)); } catch { setRefreshFailed(true); }
  }, [mismatch, workspaceId, graphSnapshotId, state?.activeSnapshotId, refreshGraph]);
  return { state, loading, error, mismatch, refreshFailed, reload: load };
}

export function SourceStatePanel({ workspaceId, graphSnapshotId, refreshGraph, mode = 'summary', architectureGeneration, codeGraphInput }: { workspaceId: string; graphSnapshotId?: string; refreshGraph?: () => void; mode?: 'summary' | 'architecture'; architectureGeneration?: number; codeGraphInput?: number }) {
  const { state, loading, error, mismatch, refreshFailed, reload } = useSourceState(workspaceId, graphSnapshotId, refreshGraph);
  const architectureState = state?.analyzers.find(entry => entry.analyzerId === 'builtin.architecture');
  const exactCodeGraphInput = codeGraphInput ?? architectureState?.inputCodeGraphGenerationId;
  if (!workspaceId) return <section className="source-state" aria-label="Source readiness"><h2>Source readiness</h2><p>Select a workspace to view source analysis readiness.</p></section>;
  return <section className="source-state" aria-label="Source readiness">
    <div className="source-state-heading"><h2>Source readiness</h2><button type="button" onClick={() => void reload()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh status'}</button></div>
    {loading && <p role="status">Loading workspace source status…</p>}
    {error && <p role="alert">Source status unavailable: {error}</p>}
    {refreshFailed && <p role="alert">Graph refresh could not be started. Refresh the graph view manually.</p>}
    {state && <>
      <p>{state.contract ? `${state.contract.provider} ${state.contract.providerVersion} · identity v${state.contract.identityVersion} · CodeGraph #${state.contract.codegraphGenerationId}` : 'No identity-v2 CodeGraph source contract is recorded.'}</p>
      {mismatch && <p className="source-state-mismatch" role="status">Graph and source status snapshots differ. The graph was refreshed once; this mismatch remains visible until both responses agree.</p>}
      {mode === 'architecture' ? <>
        <dl><dt>Active architecture generation</dt><dd>{architectureGeneration ?? architectureState?.activeGenerationId ?? 'Not active'}</dd><dt>Exact CodeGraph input</dt><dd>{exactCodeGraphInput === undefined ? 'Not recorded' : `builtin.codegraph #${exactCodeGraphInput}`}</dd><dt>Current CodeGraph generation</dt><dd>{state.contract ? `builtin.codegraph #${state.contract.codegraphGenerationId}` : 'Not recorded'}</dd></dl>
        <h3>Required analyzers</h3><ol>{ANALYZER_ORDER.slice(1).map(id => {
          const analyzer = state.analyzers.find(entry => entry.analyzerId === id);
          const required = state.reanalysisRequired.find(entry => entry.analyzerId === id);
          return <li key={id}><code>{id}</code> — {required ? `reanalysis required against CodeGraph #${required.requiredCodeGraphGenerationId}` : analyzer?.activeGenerationId ? `active generation #${analyzer.activeGenerationId}` : 'no active generation'}{analyzer?.inputCodeGraphGenerationId ? ` · input CodeGraph #${analyzer.inputCodeGraphGenerationId}` : ''}</li>;
        })}</ol>
        {state.analyzers.some(entry => entry.mapping) ? <><h3>Mapping summary</h3><ul>{state.analyzers.filter(entry => entry.mapping).map(entry => <li key={entry.analyzerId}><code>{entry.analyzerId}</code>: {Object.entries(entry.mapping!.counts).map(([key, count]) => `${key} ${count}`).join(' · ')}</li>)}</ul></> : <p>Source mapping summary: not recorded.</p>}
        <h3>Latest failed runs</h3>{state.analyzers.filter(entry => entry.latestRun?.status === 'failed').length ? <ul>{state.analyzers.filter(entry => entry.latestRun?.status === 'failed').map(entry => <li key={entry.analyzerId}><code>{entry.analyzerId}</code> · <code>{entry.latestRun!.id}</code>{entry.latestRun!.errorCode ? ` · ${entry.latestRun!.errorCode}` : ''}</li>)}</ul> : <p>No latest failed runs are recorded.</p>}
      </> : <ul className="source-state-compact">{state.analyzers.slice().sort((a, b) => ANALYZER_ORDER.indexOf(a.analyzerId) - ANALYZER_ORDER.indexOf(b.analyzerId)).map(entry => <li key={entry.analyzerId}><code>{entry.analyzerId}</code> · {entry.activeGenerationId ? `#${entry.activeGenerationId}` : 'inactive'}{state.reanalysisRequired.some(item => item.analyzerId === entry.analyzerId) ? ' · reanalysis required' : ''}</li>)}</ul>}
    </>}
  </section>;
}
