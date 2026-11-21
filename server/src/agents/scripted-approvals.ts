// The scripted agent's "/approvals N" and "/approvals N shots": a turn that asks for approval N
// times in a row, the way an agent in Manual mode does, so folded approvals can be seen with
// realistic data. Each step is a tool line, an approval card, then (once answered) the tool's
// result; with "shots", each approved simulator tap is followed by a screenshot, the real
// approve → tool line → screenshot stretch. A denial is reported and the run goes on. Fake data only.
import { randomUUID } from 'node:crypto';
import type { AgentEvent, InputRequest } from './types.ts';
import { drawnPicture } from './scripted-shots.ts';

const STEP_MS = 400;
const MAX_STEPS = 40;
const OPTIONS: InputRequest['options'] = [
  { id: 'allow', label: 'Allow', role: 'allow' },
  { id: 'deny', label: 'Deny', role: 'deny' },
];
const PACKAGES = ['server', 'ui', 'app', 'docs', 'spike'];

export interface ApprovalsContext {
  emit: (event: AgentEvent) => void;
  /** Raise a card and call `then` with the option id once it is answered. */
  ask: (request: InputRequest, then: (optionId: string) => void) => void;
  later: (ms: number, fn: () => void) => void;
  finish: (event: AgentEvent) => void;
}

function stepOf(i: number, shots: boolean): { tool: string; summary: string; title: string; detail: string } {
  if (shots) {
    const [x, y] = [120 + i * 9, 320 + i * 13];
    return { tool: 'mcp__kestrel__sim_tap', summary: `Tap (${x}, ${y}) in the simulator`, title: `Tap (${x}, ${y}) in the simulator`, detail: 'Device points on the simulator screen as shown in the Simulator view, origin top-left.' };
  }
  const pkg = PACKAGES[i % PACKAGES.length]!;
  const command = i % 4 === 3 ? `pnpm --filter @kestrel/${pkg} exec vitest run --reporter=verbose --coverage --coverage.reporter=text-summary src/${pkg}-integration.test.ts` : `pnpm --filter @kestrel/${pkg} test`;
  return { tool: 'Bash', summary: `Run ${command}`, title: 'Run a command', detail: `Run the ${pkg} tests\n\n${command}` };
}

/** Runs the whole stretch through `ctx`; it ends the turn itself. */
export function runApprovals(count: number, shots: boolean, ctx: ApprovalsContext): void {
  const n = Math.max(1, Math.min(MAX_STEPS, count));
  ctx.emit({ type: 'message', id: `m-${randomUUID()}`, text: shots ? `Testing the app: ${n} taps, a screenshot after each.` : `Running ${n} checks.`, delta: '', done: true });
  const step = (i: number) => {
    if (i >= n) {
      ctx.emit({ type: 'message', id: `m-${randomUUID()}`, text: 'All done.', delta: '', done: true });
      return ctx.finish({ type: 'done', reason: 'complete' });
    }
    const s = stepOf(i, shots);
    const id = `tool-${randomUUID()}`;
    ctx.emit({ type: 'tool', id, name: s.tool, summary: s.summary, status: 'started' });
    ctx.ask({ id: `req-${randomUUID()}`, kind: 'approval', tool: s.tool, title: s.title, detail: s.detail, options: OPTIONS }, (optionId) => {
      const denied = optionId === 'deny';
      ctx.emit({ type: 'tool', id, name: s.tool, summary: s.summary, status: denied ? 'failed' : 'finished', ...(denied ? { detail: 'The user denied this.' } : {}) });
      if (!denied && shots) {
        const shot = `shot-${randomUUID()}`;
        ctx.emit({ type: 'tool', id: shot, name: 'mcp__kestrel__sim_screenshot', summary: 'Screenshot of the simulator', status: 'started' });
        ctx.emit({ type: 'image', id: `${shot}-0`, ...drawnPicture(i) });
        ctx.emit({ type: 'tool', id: shot, name: 'mcp__kestrel__sim_screenshot', summary: 'Screenshot of the simulator', status: 'finished' });
      }
      ctx.later(STEP_MS, () => step(i + 1));
    });
  };
  ctx.later(STEP_MS, () => step(0));
}
