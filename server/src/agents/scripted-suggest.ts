// SCRIPTED BEHAVIOUR ONLY (the stand-in agent of agents/scripted.ts, fake data): a message that names
// a ticket-looking id (PROJ-482) makes the stand-in call the `suggest` tool with kind "tag", as a real
// agent is asked to, so the optional-action card can be tried by hand; "/note" suggests the test-only
// `note` kind. A real agent decides this itself from the standing instruction.
import { randomUUID } from 'node:crypto';
import type { AgentEvent, KestrelToolHost } from './types.ts';

const TICKET = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/;

/** The suggestion a scripted turn makes for `text`, if any. */
export function scriptedSuggestion(text: string): Record<string, unknown> & { kind: string } | null {
  if (text.includes('/note')) return { kind: 'note', text: 'Scripted note: this is the test-only kind.' };
  const ticket = TICKET.exec(text)?.[0];
  return ticket ? { kind: 'tag', tag: ticket, category: 'ticket', source: 'Jira', reason: `The task names ${ticket}.` } : null;
}

/** Calls `suggest` like a real agent would, with a tool line around it. Never blocks the turn. */
export async function runScriptedSuggestion(text: string, tools: KestrelToolHost, emit: (event: AgentEvent) => void): Promise<void> {
  const args = scriptedSuggestion(text);
  if (!args) return;
  const id = `suggest-${randomUUID()}`;
  const summary = `Suggest ${args.kind === 'tag' ? `tag ${String(args.tag)}` : args.kind}`;
  emit({ type: 'tool', id, name: 'mcp__kestrel__suggest', summary, status: 'started' });
  const result = await tools.suggest(args);
  emit({ type: 'tool', id, name: 'mcp__kestrel__suggest', summary, status: result.isError ? 'failed' : 'finished', detail: result.text });
}
