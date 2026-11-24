// A step of Kestrel's own that waits on the user's answer to a card (design doc, "Kestrel's own cards
// survive a restart"): handoff, delegate, spawn, ask_session, move_to_project, start_review,
// add_project, and a role's fallback preset. Stored with the card in the stored detail of the session
// the card shows in, so it can be taken up again after a restart by making the same call again. Pure.

/** The Kestrel tools whose call waits on one of Kestrel's own cards. */
export const STEP_TOOLS = ['handoff', 'delegate', 'spawn', 'ask_session', 'move_to_project', 'start_review', 'add_project'] as const;
export type StepTool = (typeof STEP_TOOLS)[number];

export const isStepTool = (tool: string): tool is StepTool => (STEP_TOOLS as readonly string[]).includes(tool);

/** The call that raised the card, made again to take the step up: a tool and the arguments the agent gave it, or a role's fallback. */
export type StepCall = { kind: 'tool'; tool: StepTool; args: unknown } | { kind: 'fallback'; childId: string; reason: string };

/** What the card asked, to be compared with what the call would ask now. */
export interface StepCard {
  tool: string;
  title: string;
  detail: string;
}

export interface WaitingStep {
  requestId: string;
  call: StepCall;
  card: StepCard;
  /** ms since 1970. */
  raisedAt: number;
  /** `taking`: the answer is being carried out. Found so after a restart, it was cut off part way and is never run again. */
  status: 'waiting' | 'taking';
}

export const sameCard = (a: StepCard, b: StepCard): boolean => a.tool === b.tool && a.title === b.title && a.detail === b.detail;

/** The steps, with this one's status changed. */
export const withStatus = (steps: readonly WaitingStep[], requestId: string, status: WaitingStep['status']): WaitingStep[] => steps.map((s) => (s.requestId === requestId ? { ...s, status } : s));

/** Whether a stored step will take this card up after a restart. */
export const survives = (steps: readonly WaitingStep[] | undefined, requestId: string): boolean => (steps ?? []).some((s) => s.requestId === requestId && s.status === 'waiting');

/** The card's closing words when a restart cut its step off part way. */
export const CUT_OFF_STEP = 'Kestrel restarted while doing this: check whether it was done';

/** Why a step is not carried out: what the call would ask now differs from what was approved. */
export const changedRefusal = (now: StepCard): string => `What this would do has changed since you were asked, so nothing was done. It would now ask: "${now.title}"${now.detail ? `\n${now.detail}` : ''}`;

/** A second answer to a step already being carried out. */
export const ALREADY_TAKING = 'This is already being done.';

/** What the agent is told when its step is taken up after a restart, with its next turn. */
export function stepNews(card: StepCard, outcome: { approved: boolean; refusal: string | null; result: string | null }): string {
  const asked = `Before Kestrel restarted you asked: "${card.title}" (${card.tool}).`;
  if (!outcome.approved) return `[Kestrel] ${asked} The user declined it after the restart. Nothing was done.`;
  if (outcome.refusal) return `[Kestrel] ${asked} The user approved it after the restart, but it was not done: ${outcome.refusal}`;
  return `[Kestrel] ${asked} The user approved it after the restart, and Kestrel did it. What the call answered: ${outcome.result ?? 'done.'}`;
}

/** What the agent is told when a restart cut its approved step off part way. */
export const cutOffNews = (card: StepCard): string => `[Kestrel] The user approved "${card.title}" (${card.tool}), but Kestrel restarted while doing it. It may be done in part or not at all: check before you do anything that depends on it, and do not simply call it again.`;
