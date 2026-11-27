// Bring another computer's model presets and Who does what here (docs/designs/onboarding.md, 19). Run is
// the person's click on the line or its section: the merge (shared/who-does-what-merge.ts) adds what this
// computer lacks and replaces nothing, and is stored through the same checks and listeners as Settings →
// Models & roles. Undo stores what was here before.
import { randomUUID } from 'node:crypto';
import type { SetupAction } from '../shared/setup-list.ts';
import { mergeChanges, mergeSaidText, mergeWhoDoesWhat } from '../shared/who-does-what-merge.ts';
import { whoDoesWhatProblem, type WhoDoesWhat } from '../shared/who-does-what.ts';
import { failed, type ExecuteDeps } from './execute.ts';
import type { StepContext, StepResult } from './steps.ts';

/** Settings → Models & roles, through its own store (`WhoDoesWhatPrefs`). */
export interface ModelsTarget {
  current(): Promise<WhoDoesWhat>;
  set(value: unknown): Promise<WhoDoesWhat>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const NOTE_LEFT = ' The note on who does what was not brought: something in it looks like a key.';

export async function modelsStep(deps: ExecuteDeps, _ctx: StepContext, action: Extract<SetupAction, { kind: 'models' }>): Promise<StepResult> {
  const target = deps.models;
  if (!target) return failed('This copy of Kestrel cannot change Models & roles from here. Use Settings → Models & roles.');
  try {
    const before = await target.current();
    const merge = mergeWhoDoesWhat(before, action.who, () => randomUUID().slice(0, 8));
    const note = action.instructionLeftOut ? NOTE_LEFT : '';
    if (!mergeChanges(merge)) return { state: 'done', said: `${mergeSaidText(merge)}${note}` };
    const problem = whoDoesWhatProblem(merge.who);
    if (problem) return failed(problem);
    await target.set(merge.who);
    return { state: 'done', said: `${mergeSaidText(merge)}${note}`, undo: async () => void (await target.set(before)) };
  } catch (error) {
    return failed(message(error));
  }
}
