// How full a Claude session's context window is. The SDK answers `getContextUsage()` on a live
// query (SDK 0.3.322): Kestrel asks it as each turn ends, while that turn's query is still open
// (index.ts), and, for a session that has not run a turn since the server started, on a short
// resumed query that sends nothing (`claudeContextUsage`). Both use `detail: 'summary'`: the last
// response's usage and local estimates, with no token-counting calls to the API.
import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import type { ContextRow, ContextUsage } from '../../shared/context-usage.ts';
import type { StartOptions } from '../types.ts';
import { baseOptions } from './options.ts';

type SdkContextUsage = Awaited<ReturnType<Query['getContextUsage']>>;

const KINDS = new Set<ContextRow['kind']>(['used', 'free', 'buffer', 'deferred']);
const TIMEOUT_MS = 20_000;

/** The SDK's report as Kestrel's. */
export function toContextUsage(u: SdkContextUsage, at = Date.now()): ContextUsage {
  const rows = u.categories.filter((c) => KINDS.has(c.kind)).map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind }));
  return { model: u.model, usedTokens: u.totalTokens, windowTokens: u.rawMaxTokens || u.maxTokens, rows, at };
}

/** Ask a live query, giving up after `ms`; null when it cannot say (an older CLI, a closed query, a test double). */
export async function askContextUsage(q: Pick<Query, 'getContextUsage'> | null, ms = TIMEOUT_MS): Promise<ContextUsage | null> {
  if (!q || typeof q.getContextUsage !== 'function') return null;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref();
  });
  try {
    const answer = await Promise.race([q.getContextUsage({ detail: 'summary' }), late]);
    return answer ? toContextUsage(answer) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A prompt stream that never yields: the resumed process starts and answers, and no turn runs. */
async function* idle(): AsyncGenerator<never> {
  await new Promise<never>(() => undefined);
}

/**
 * The usage of an idle session, from a resumed query that sends nothing. No tools, no MCP servers
 * and no hooks are started for it: only the conversation is read.
 */
export async function claudeContextUsage(agentSessionId: string, opts: StartOptions, runQuery: typeof query = query): Promise<ContextUsage | null> {
  const base = baseOptions(opts);
  const options: Options = { ...base, resume: agentSessionId, mcpServers: {}, settings: { ...(typeof base.settings === 'object' ? base.settings : {}), disableAllHooks: true } };
  const q = runQuery({ prompt: idle() as never, options });
  try {
    return await askContextUsage(q);
  } finally {
    q.close();
  }
}
