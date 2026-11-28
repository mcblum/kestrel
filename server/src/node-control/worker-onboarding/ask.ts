// What a question is, said by the flow beside its typed prompt, so the interactive screen can draw it as a choice
// (docs/designs/worker-terminal-handoff.md). The flows keep parsing typed text: the plain transcript ignores the hint,
// and the screen turns the person's choice back into the very text the flow already understands (`answerText`).
import type { WorkerAnswer, WorkerChoice, WorkerDetail, WorkerPrompt } from './model.ts';

export type TrustDetail = Omit<Extract<WorkerDetail, { kind: 'trust' }>, 'kind'>;

/** One choice; `answer` is the text typed in the plain transcript that means it. */
export interface HintChoice {
  answer: string;
  label: string;
  note?: string;
  shortcut?: string;
}

export type AskHint =
  /** A yes or no: Enter takes `byDefault`. */
  | { kind: 'confirm'; yes?: string; no?: string; byDefault: boolean; label?: string; trust?: TrustDetail }
  /** One of a short list. */
  | { kind: 'choose'; choices: readonly HintChoice[]; initial?: string; label?: string; trust?: TrustDetail }
  /** Any number of a list; `answer` turns the chosen answers into the text that means them (an empty list too). */
  | { kind: 'pick'; choices: readonly HintChoice[]; initial?: readonly string[]; answer(chosen: readonly string[]): string; label?: string; trust?: TrustDetail }
  /** Something typed: a name, an address, a code. */
  | { kind: 'text'; initial?: string; placeholder?: string; maxLength?: number; label?: string };

export const confirm = (byDefault: boolean, extra: Partial<Extract<AskHint, { kind: 'confirm' }>> = {}): AskHint => ({ kind: 'confirm', byDefault, ...extra });

/** A typed prompt without its transcript-only parts: a trailing `[Y/n]`, `[default]`, colon and spaces. */
export function promptLabel(prompt: string): string {
  return prompt
    .replace(/\s*\[[^\]]*\]\s*:?\s*$/, '')
    .replace(/\s*:\s*$/, '')
    .trim();
}

/** The screen's prompt for a question: typed text when the flow gave no hint. */
export function workerPromptOf(id: string, prompt: string, hint?: AskHint): WorkerPrompt {
  const label = hint?.label ?? promptLabel(prompt);
  if (!hint || hint.kind === 'text') {
    return { id, kind: 'input', label, ...(hint?.initial ? { initial: hint.initial } : {}), ...(hint?.placeholder ? { placeholder: hint.placeholder } : {}), ...(hint?.maxLength ? { maxLength: hint.maxLength } : {}) };
  }
  if (hint.kind === 'confirm') {
    const choices: WorkerChoice[] = [
      { value: 'y', label: hint.yes ?? 'Yes', shortcut: 'y' },
      { value: 'n', label: hint.no ?? 'No', shortcut: 'n' },
    ];
    return { id, kind: 'select', label, choices, initial: hint.byDefault ? 'y' : 'n' };
  }
  const choices = hint.choices.map((c): WorkerChoice => ({ value: c.answer, label: c.label, ...(c.note ? { note: c.note } : {}), ...(c.shortcut ? { shortcut: c.shortcut } : {}) }));
  if (hint.kind === 'choose') return { id, kind: 'select', label, choices, ...(hint.initial !== undefined ? { initial: hint.initial } : {}) };
  return { id, kind: 'multi', label, choices, ...(hint.initial ? { initial: hint.initial } : {}) };
}

/** The text the flow reads for the screen's answer; null stays null (canceled or closed). */
export function answerText(answer: WorkerAnswer, hint?: AskHint): string | null {
  if (answer === null) return null;
  if (Array.isArray(answer)) return hint?.kind === 'pick' ? hint.answer(answer) : answer.join(' ');
  return answer;
}

/** The trust detail a question draws above its choices, when it has one. */
export function trustOf(hint?: AskHint): WorkerDetail | null {
  return hint && hint.kind !== 'text' && hint.trust ? { kind: 'trust', ...hint.trust } : null;
}
