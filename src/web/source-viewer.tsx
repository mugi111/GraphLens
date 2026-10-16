import React, { useEffect, useRef, useState } from 'react';
import './source-viewer.css';

type Source = { workspaceId: string; analyzerId: string; generationId: number; evidenceId: string };
type Result = { workspace: { id: string; name: string }; analyzerId: string; generationId: number; evidenceId: string; path: string; focusLine: number; startLine: number; endLine: number; lines: Array<{ line: number; text: string }>; sha256: string; state: 'current-working-file' };
export function SourceEvidenceButton({ source, label = 'Open source' }: { source?: Source; label?: string }) {
  const dialog = useRef<HTMLDialogElement>(null); const trigger = useRef<HTMLButtonElement>(null); const request = useRef<AbortController>();
  const [result, setResult] = useState<Result>(); const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  useEffect(() => { request.current?.abort(); request.current = undefined; setResult(undefined); setError(''); setLoading(false); return () => request.current?.abort(); }, [source?.workspaceId, source?.analyzerId, source?.generationId, source?.evidenceId]);
  const open = async () => {
    if (!source) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setResult(undefined); setError(''); setLoading(true); dialog.current?.showModal();
    const params = new URLSearchParams({ workspace: source.workspaceId, analyzer: source.analyzerId, generation: String(source.generationId), evidence: source.evidenceId });
    try { const response = await fetch(`/api/v1/source?${params}`, { signal: controller.signal, cache: 'no-store' }); const body = await response.json(); if (request.current !== controller || controller.signal.aborted) return; if (!response.ok) throw new Error(body.error ?? 'Unable to open source.'); setResult(body as Result); }
    catch (cause) { if (request.current === controller && !controller.signal.aborted) setError((cause as Error).message); }
    finally { if (request.current === controller) setLoading(false); }
  };
  const close = () => { request.current?.abort(); request.current = undefined; dialog.current?.close(); trigger.current?.focus(); };
  return <><button ref={trigger} type="button" disabled={!source} onClick={() => void open()}>{source ? label : 'Source location unavailable'}</button><dialog className="source-viewer" ref={dialog} aria-label="Source evidence" onCancel={(event) => { event.preventDefault(); close(); }} onClose={() => { request.current?.abort(); trigger.current?.focus(); }}>
    <header><div><strong>Current working file</strong>{result && <p>{result.workspace.name} · {result.path}:{result.focusLine}</p>}</div><button type="button" onClick={close} aria-label="Close source viewer">Close</button></header>
    <p className="source-viewer-note">This is the current working file. It is not asserted to be identical to the analyzed snapshot.</p>
    {loading && <p role="status">Loading source…</p>}{error && <p role="alert">{error}</p>}
    {result && <><pre aria-label="Source code">{result.lines.map(({ line, text }) => <span key={line} className={line === result.focusLine ? 'source-focus' : ''}><b>{line}</b>{text}{'\n'}</span>)}</pre><small>SHA-256 of source file bytes: {result.sha256}</small></>}
  </dialog></>;
}
