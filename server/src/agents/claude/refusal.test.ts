// A call Kestrel's own hook refused is told apart from a tool that simply failed: its failed step
// carries the reason as a refusal, which the conversation shows as text.
import { describe, expect, it } from 'vitest';
import { NO_TOOLS } from '../test-support.ts';
import type { AgentEvent } from '../types.ts';
import { claudeAdapter } from './index.ts';

const REASON = 'beta/README.md is in the project "Beta"; use delegate.';
const assistant = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, text: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] } });

function run(): Promise<AgentEvent[]> {
  const runQuery = ((args: any) => {
    const hook = args.options.hooks.PreToolUse[0].hooks[0];
    async function* messages() {
      yield assistant('t1', 'Edit', { file_path: '/w/beta/README.md', old_string: 'a', new_string: 'b' });
      await hook({ tool_name: 'Edit', tool_input: { file_path: '/w/beta/README.md' }, tool_use_id: 't1' });
      yield result('t1', REASON);
      yield assistant('t2', 'Bash', { command: 'false' });
      await hook({ tool_name: 'Bash', tool_input: { command: 'false' }, tool_use_id: 't2' });
      yield result('t2', 'Exit code 1');
      yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0 };
    }
    return Object.assign(messages(), { interrupt: async () => undefined });
  }) as any;
  const events: AgentEvent[] = [];
  const intercept = async (a: { tool: string }) => (a.tool === 'Edit' ? { allow: false as const, message: REASON } : { allow: true as const });
  return new Promise((resolve) => {
    claudeAdapter(runQuery).start({ directory: '/w/alpha', instruction: 'x', tools: NO_TOOLS, permission: 'auto', intercept }, 'go', (e) => {
      events.push(e);
      if (e.type === 'done' || e.type === 'failed') resolve(events);
    });
  });
}

describe('a refused call in a Claude session', () => {
  it('carries the reason as a refusal; a tool that failed on its own does not', async () => {
    const tools = (await run()).filter((e): e is Extract<AgentEvent, { type: 'tool' }> => e.type === 'tool' && e.status === 'failed');
    expect(tools.find((e) => e.id === 't1')).toMatchObject({ refusal: REASON });
    expect(tools.find((e) => e.id === 't2')?.refusal).toBeUndefined();
  });
});
