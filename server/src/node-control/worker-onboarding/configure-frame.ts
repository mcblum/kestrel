// Configure's progress line and closing outcomes on the screen, both from the node's own status every time
// (`setupStepsOf`), never from a flag kept by the run.
import { adminCommandHere, SETUP_SECTIONS, setupActionText, setupStepsOf, type AdminRunner, type SandboxHere } from '../../shared/node-configure.ts';
import type { NodeStatus } from '../../shared/node-status.ts';
import type { WorkerDetail, WorkerStep } from './model.ts';

const SECTIONS = [1, 2, 3, 4] as const;

/** System, Account, Agents and Git: ready when the node says so; the one under way; left once passed or finished. */
export function configureSteps(status: NodeStatus | null, sandbox: SandboxHere, current: number | null, finished: boolean): WorkerStep[] {
  const steps = status ? setupStepsOf(status, sandbox) : [];
  return SECTIONS.map((n): WorkerStep => {
    const label = SETUP_SECTIONS[n]!;
    const mine = steps.filter((s) => s.number === n);
    if (status && mine.every((s) => s.done)) return { label, state: 'ready' };
    if (!finished && n === current) return { label, state: 'active' };
    if (finished || (current !== null && n < current)) return { label, state: 'left' };
    return { label, state: 'pending' };
  });
}

/** One outcome per step: done, or what is left and the one command that does it. */
export function configureOutcomes(status: NodeStatus, sandbox: SandboxHere, runner: AdminRunner): WorkerDetail[] {
  return setupStepsOf(status, sandbox).map((s): WorkerDetail =>
    s.done || !s.action
      ? { kind: 'outcome', label: s.title, state: 'ready' }
      : { kind: 'outcome', label: s.title, state: 'left', detail: s.left, command: adminCommandHere(setupActionText(s.action), runner) },
  );
}
