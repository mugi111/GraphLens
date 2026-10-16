import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import type { CodeGraphStatus, GraphSnapshot, Workspace } from '../../domain/graph.js';

type CommandConfig = { command?: string; args: string[] };

/**
 * Read-only MCP stdio capability probe. No search or traversal result is represented as
 * a complete graph, because public CodeGraph MCP behavior does not document an export.
 */
export class CodeGraphAdapter {
  constructor(private config: CommandConfig) {}
  async status(): Promise<CodeGraphStatus> {
    if (!this.config.command) return unsupported('No CodeGraph MCP server command was configured.');
    try {
      const tools = await listMcpTools(this.config.command, this.config.args);
      const names = tools.map((tool) => tool.name).join(', ') || 'none';
      return { configured: true, connected: true, fullEnumeration: { supported: false, detail: 'No documented complete graph snapshot/export capability is available through the verified MCP tool list.' }, detail: `MCP initialize and tools/list succeeded. Tools: ${names}.` };
    } catch (error) {
      return { configured: true, connected: false, fullEnumeration: { supported: false, detail: 'Could not verify full graph enumeration.' }, detail: `CodeGraph MCP probe failed: ${message(error)}` };
    }
  }
  async snapshot(path: string): Promise<GraphSnapshot> {
    const state = await this.status();
    throw new Error(`${state.detail} GraphLens will preserve the active snapshot; full CodeGraph snapshot import is not available for ${path}.`);
  }
}
export function workspaceFor(path: string, id?: string): Workspace { const absolute = resolve(path); return { id: id ?? stable('workspace', absolute), path: absolute, name: basename(absolute) || absolute }; }
function stable(scope: string, value: string) { return createHash('sha256').update(`${scope}:${value}`).digest('hex').slice(0, 24); }
function unsupported(detail: string): CodeGraphStatus { return { configured: false, connected: false, fullEnumeration: { supported: false, detail }, detail }; }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }

type McpTool = { name: string };
function listMcpTools(command: string, args: string[]): Promise<McpTool[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }); let buffer = ''; let stderr = ''; let initialized = false; let done = false;
    const timer = setTimeout(() => finish(new Error('Timed out waiting for the MCP server.')), 12_000);
    const finish = (error?: Error, tools?: McpTool[]) => {
      if (done) return;
      done = true; clearTimeout(timer); if (!child.killed) child.kill(); error ? reject(error) : resolve(tools ?? []);
    };
    const send = (value: object) => child.stdin.write(`${JSON.stringify(value)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'GraphLens', version: '0.1.0' } } });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => { if (!done) finish(new Error(`MCP server exited before responding (code ${code ?? 'none'}, signal ${signal ?? 'none'})${stderr ? `: ${stderr}` : ''}`)); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-2048).trim(); });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString(); let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (!line) continue;
        let response: any; try { response = JSON.parse(line); } catch { continue; }
        if (response.id === 1) {
          if (response.error) return finish(new Error(response.error.message ?? 'MCP initialize failed.'));
          initialized = true; send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        } else if (initialized && response.id === 2) {
          if (response.error) return finish(new Error(response.error.message ?? 'MCP tools/list failed.'));
          return finish(undefined, Array.isArray(response.result?.tools) ? response.result.tools : []);
        }
      }
    });
  });
}
