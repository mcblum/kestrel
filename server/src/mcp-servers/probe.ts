// Settings' Test button: start or reach one server once, with the MCP SDK's own client (borrowed, not
// built), list its tools, and close. Its values are put only into that connection. A failure's words
// are said with every value of the server blanked out, so no secret reaches the page or a log.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { homedir } from 'node:os';
import type { McpConfig } from '../shared/setup.ts';

export interface ProbeTool {
  name: string;
  description?: string;
}

export type ProbeResult = { ok: true; tools: ProbeTool[] } | { ok: false; error: string };

/** How long Test waits for a server to answer. */
export const PROBE_TIMEOUT_MS = 20_000;
const STDERR_KEPT = 2000;

/** `text` with every one of `values` blanked out. Pure. */
export function blankValues(text: string, values: readonly string[]): string {
  return values.filter((v) => v.length >= 4).reduce((out, v) => out.split(v).join('••••'), text);
}

/** Every value a server's configuration carries (environment and headers), to blank out of what is said. */
export function valuesOf(config: McpConfig): string[] {
  const table = (v: unknown): string[] => (typeof v === 'object' && v !== null ? Object.values(v).filter((x): x is string => typeof x === 'string') : []);
  return [...table(config.env), ...table(config.headers)];
}

function transportFor(config: McpConfig, stderr: { text: string }): Transport {
  const headers = (config.headers ?? {}) as Record<string, string>;
  if (typeof config.url === 'string') {
    const url = new URL(config.url);
    return config.type === 'sse' ? new SSEClientTransport(url, { requestInit: { headers }, eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }) } }) : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  }
  const transport = new StdioClientTransport({
    command: String(config.command),
    args: Array.isArray(config.args) ? (config.args as string[]) : [],
    env: { ...getDefaultEnvironment(), ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...((config.env ?? {}) as Record<string, string>) },
    cwd: homedir(),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr.text = (stderr.text + chunk.toString('utf8')).slice(-STDERR_KEPT);
  });
  return transport;
}

/** Start or reach the server, list its tools, close. Never throws. */
export async function probeServer(config: McpConfig, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const stderr = { text: '' };
  const client = new Client({ name: 'kestrel-test', version: '1' });
  let timer: NodeJS.Timeout | undefined;
  try {
    const transport = transportFor(config, stderr);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`It did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
    });
    await Promise.race([client.connect(transport), timeout]);
    const listed = await Promise.race([client.listTools(), timeout]);
    return { ok: true, tools: listed.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) })) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const output = stderr.text.trim() ? `\n\nIts last output:\n${stderr.text.trim()}` : '';
    return { ok: false, error: blankValues(`${message}${output}`, valuesOf(config)) };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}
