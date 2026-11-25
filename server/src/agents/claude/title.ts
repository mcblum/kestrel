// Kestrel's own short questions to Claude, each a one-shot side query: a new session's title (from
// a small fast model), and a pull request's title and summary ("Create PR → Generated", from the
// session's own model, or the SDK's default when the session has none). It never touches a
// session: no resume id, no tools, nothing saved to ~/.claude/projects. It reads the user's
// settings file only to reach their provider (side-query.ts). The caller cleans the reply (title.ts
// `cleanTitle`, pull-requests/generate.ts) and decides whether to use it.
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { PR_TEXT_INSTRUCTION, PR_TEXT_TIMEOUT_MS } from '../pr-text-request.ts';
import { sleep, TITLE_INSTRUCTION, TITLE_TIMEOUT_MS, titleRequest } from '../title-request.ts';
import { sideQueryOptions } from './side-query.ts';

export { TITLE_TIMEOUT_MS };

type Wait = (ms: number) => Promise<void>;

/** The small fast model session titles use. */
export const TITLE_MODEL = 'haiku';

/** The side query's options; `model` null leaves the choice to the SDK's default (what a session on the default uses). */
export const titleOptions = (systemPrompt: string = TITLE_INSTRUCTION, model: string | null = TITLE_MODEL): Options => ({
  ...sideQueryOptions(),
  ...(model ? { model } : {}),
  systemPrompt,
  tools: [],
  persistSession: false,
  maxTurns: 1,
});

/** The model's reply text, or null when the query ended without one. Throws on an error result. */
async function replyOf(q: AsyncIterable<{ type: string; subtype?: string; is_error?: boolean; result?: string }>): Promise<string | null> {
  for await (const m of q) {
    if (m.type !== 'result') continue;
    if (m.subtype !== 'success' || m.is_error) throw new Error(`side query ended with ${m.subtype ?? 'an error'}`);
    return m.result ?? null;
  }
  return null;
}

/** One side query: the raw reply, or null if none came within `timeoutMs`. The query is closed either way. */
async function ask(systemPrompt: string, prompt: string, timeoutMs: number, runQuery: typeof query, wait: Wait, model: string | null): Promise<string | null> {
  const q = runQuery({ prompt, options: titleOptions(systemPrompt, model) });
  try {
    return await Promise.race([replyOf(q as never), wait(timeoutMs).then(() => null)]);
  } finally {
    q.close();
  }
}

/**
 * The raw title reply for `prompt`, or null if none came within the timeout. Errors are thrown for
 * the caller to log. `wait` is the timeout's clock; tests pass one.
 */
export function claudeTitle(prompt: string, runQuery: typeof query = query, wait: Wait = sleep, existingTags: readonly string[] = []): Promise<string | null> {
  return ask(TITLE_INSTRUCTION, titleRequest(prompt, existingTags), TITLE_TIMEOUT_MS, runQuery, wait, TITLE_MODEL);
}

/**
 * The raw reply to a pull request text request (pr-text-request.ts `prTextRequest`), or null on
 * timeout. `model` is the session's; empty or absent omits it, so the SDK's default model answers.
 */
export function claudePullRequestText(request: string, model?: string, runQuery: typeof query = query, wait: Wait = sleep): Promise<string | null> {
  return ask(PR_TEXT_INSTRUCTION, request, PR_TEXT_TIMEOUT_MS, runQuery, wait, model || null);
}
