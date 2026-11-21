// The scripted agent's "/refused" message (scripted.ts, dev only): steps as a real session shows
// them when Kestrel refused an edit (Claude or Codex), when a tool simply failed, and when Codex made
// an edit inside its sandbox that Kestrel would have refused, so the conversation's rows can be seen.
import { randomUUID } from 'node:crypto';
import { otherProjectRefusal } from '../shared/project-edits.ts';
import type { AgentEvent } from './types.ts';
import { appliedUnasked } from './codex/handle.ts';

const REFUSED = otherProjectRefusal('/Users/me/Code/epsilon/README.md', 'Epsilon', 'delegate');
const UNSTOPPED = appliedUnasked(otherProjectRefusal('/private/tmp/gamma/README.md', 'Gamma', 'delegate'));

export function scriptedRefusals(): AgentEvent[] {
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  return [
    { type: 'tool', id: a, name: 'Edit', summary: 'Edit ../epsilon/README.md', status: 'started' },
    { type: 'tool', id: a, name: 'Edit', summary: 'Edit ../epsilon/README.md', status: 'failed', detail: REFUSED, refusal: REFUSED },
    { type: 'tool', id: b, name: 'Bash', summary: 'Run pnpm lint', status: 'started', command: 'pnpm lint' },
    { type: 'tool', id: b, name: 'Bash', summary: 'Run pnpm lint', status: 'failed', detail: 'Exit code 1\n3 problems' },
    { type: 'tool', id: c, name: 'Write', summary: 'Write /private/tmp/gamma/README.md', status: 'started' },
    { type: 'tool', id: c, name: 'Write', summary: 'Write /private/tmp/gamma/README.md', status: 'finished', detail: UNSTOPPED, warning: UNSTOPPED },
  ];
}
