// A picture a tool returned, as the runtime puts it into the conversation: stored under the
// session's media folder (display.ts) and added to that tool result's card, or, when it could not
// be kept, a line for the agent output log saying why.
import type { AgentEvent } from '../agents/types.ts';
import type { Display } from '../display.ts';
import type { ChatMessage } from '../model.ts';
import type { TranscriptAction } from '../transcript.ts';

type Card = Extract<TranscriptAction, { type: 'card' }>;

export function imageCard(display: Display, sessionId: string, messages: readonly ChatMessage[], event: Extract<AgentEvent, { type: 'image' }>): { card: Card } | { output: string } {
  let saved: ReturnType<Display['saveImage']>;
  try {
    saved = display.saveImage(sessionId, event);
  } catch (error) {
    saved = { reason: `a picture could not be stored: ${error instanceof Error ? error.message : String(error)}` };
  }
  if ('reason' in saved) return { output: `[image] ${saved.reason}` };
  // Pictures from one tool result share a card; the mapper numbers them `<tool id>-<n>`.
  const cardId = `images-${event.id.replace(/-\d+$/, '')}`;
  const before = messages.find((m) => m.id === cardId)?.images ?? [];
  return { card: { type: 'card', id: cardId, images: [...before, saved.name], at: Date.now() } };
}
