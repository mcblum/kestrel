// Kestrel's own MCP servers in a Codex session, from Codex's own report (`mcpServerStatus/list`), for
// the session header. A server Codex cannot reach (SSE: Codex speaks only streamable HTTP, checked on
// codex-cli 0.167.2) was never handed to it, and says so (shared/mcp-servers.ts `codexCannot`). Pure.
import { serverStates, type AgentServerReport, type HandedServer, type McpServerState } from '../../shared/mcp-servers.ts';

type Obj = Record<string, unknown>;

/** Codex's `McpServerConnectionStatus`, as Kestrel's words. */
const CODEX_STATE: Record<string, AgentServerReport['state']> = {
  connected: 'connected',
  starting: 'starting',
  notStarted: 'starting',
  authenticationRequired: 'needs-sign-in',
  failed: 'failed',
  cancelled: 'failed',
  disabled: 'failed',
};

export function codexServerStates(listed: readonly Obj[], handed: readonly HandedServer[]): McpServerState[] {
  const reports = new Map<string, AgentServerReport>();
  for (const s of listed) {
    if (typeof s.name !== 'string') continue;
    const status = typeof s.runtimeStatus === 'string' ? s.runtimeStatus : '';
    const toolsError = typeof s.toolsError === 'string' && s.toolsError ? s.toolsError : '';
    const state = CODEX_STATE[status] ?? (toolsError ? 'failed' : 'unknown');
    const reason = toolsError || (status === 'disabled' ? 'Codex has it switched off.' : '');
    reports.set(s.name, { state, ...(reason ? { reason } : {}) });
  }
  return serverStates(handed, 'codex', reports);
}
