// Helpers an agent starts inside its own process (Claude's Agent tool). They are not Kestrel
// sessions: nobody can message them. Kestrel lists them at the foot of the conversation and
// keeps what they said and did, so the user can open one and read it. Pure.

export interface SubAgent {
  /** The tool call that started it. */
  id: string;
  title: string;
  status: 'running' | 'done' | 'failed';
  /** What it said and did, and what it handed back, as plain text. */
  output: string;
}

/** The names Claude has used for its sub-agent tool. */
export const isSubagentTool = (name: string): boolean => name === 'Agent' || name === 'Task';

const MAX_LISTED = 12;
const MAX_OUTPUT_CHARS = 20_000;
const add = (output: string, text: string) => (output ? `${output}\n${text}` : text).slice(-MAX_OUTPUT_CHARS);

/** The list after a sub-agent tool call starts or ends. An end for a call never seen is ignored. */
export function applySubagent(list: readonly SubAgent[], event: { id: string; summary: string; status: 'started' | 'finished' | 'failed'; detail?: string }): SubAgent[] {
  if (event.status === 'started') {
    if (list.some((a) => a.id === event.id)) return [...list];
    return [...list, { id: event.id, title: event.summary, status: 'running' as const, output: '' }].slice(-MAX_LISTED);
  }
  const status = event.status === 'failed' ? ('failed' as const) : ('done' as const);
  // What the call handed back to the agent closes the helper's output.
  return list.map((a) => (a.id === event.id ? { ...a, status, output: event.detail ? add(a.output, `\n${status === 'failed' ? 'Failed' : 'Returned'}:\n${event.detail}`) : a.output } : a));
}

/** Something the helper said or did while it ran. Unknown helpers are ignored. */
export function appendSubagentOutput(list: readonly SubAgent[], id: string, text: string): SubAgent[] {
  return list.map((a) => (a.id === id ? { ...a, output: add(a.output, text) } : a));
}

/** Whether any helper is still working. */
export const anyRunning = (list: readonly SubAgent[]): boolean => list.some((a) => a.status === 'running');
