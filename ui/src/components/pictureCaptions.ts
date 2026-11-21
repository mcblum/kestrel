// What the picture viewer says about a picture a tool returned: the tool line that took it and
// when, instead of its stored file name (shot-<uuid>-0.jpg means nothing to anyone).
import type { ChatMessage } from '@kestrel/server/model';
import { FOLD_LOOK_BACK } from '@kestrel/server/conversation-rows';

/** How far back to look for the tool line that took a picture (an approval may sit between them). A fold's row carries this many messages before it. */
const LOOK_BACK = FOLD_LOOK_BACK;

function timeOf(m: ChatMessage): string {
  if (m.at === undefined) return m.time;
  return new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** The latest tool line before the picture, while only tool lines, cards and pictures sit between. */
function sourceOf(messages: readonly ChatMessage[], index: number): string | null {
  for (let i = index - 1; i >= Math.max(0, index - LOOK_BACK); i--) {
    const m = messages[i]!;
    if (m.author !== 'agent' || m.text.trim() || m.notice) return null;
    const line = m.activity?.at(-1)?.text;
    if (line) return line;
  }
  return null;
}

/** "Screenshot of the simulator · 14:03:22", or just the time. */
export function pictureCaption(messages: readonly ChatMessage[], index: number): string {
  const m = messages[index];
  if (!m) return '';
  const source = sourceOf(messages, index);
  const time = timeOf(m);
  return [source, time].filter(Boolean).join(' · ');
}
