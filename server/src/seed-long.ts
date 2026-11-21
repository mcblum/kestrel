// SAMPLE: one long fake conversation (about 1,000 messages) for measuring and checking how the
// conversation behaves when it is long: opening it, scrolling it, typing under it (issue 8,
// "Long conversations stay fast"). Deterministic, so two runs measure the same thing. Fake data
// only (seed.ts); never written into a real store.
import type { ChatActivity, ChatMessage, InputCard } from './model.ts';

/** Turns in the sample; each turn is four messages, so 250 turns make 1,000. */
export const LONG_SAMPLE_TURNS = 250;
const MESSAGES_PER_TURN = 4;
/** Every this many turns, the agent asked for an approval (folded with its tool lines). */
const APPROVAL_EVERY = 7;
/** Every this many turns, the agent's reply carries a code block. */
const CODE_EVERY = 3;
const TURN_SPACING_MS = 6 * 60_000;
const TURN_LENGTH_MS = 95_000;
/** When the sample's first turn started: a fixed date, so the sample never changes. */
const SAMPLE_START_MS = Date.UTC(2026, 10, 2, 9, 0, 0);

const AREAS = ['search index', 'checkout', 'session store', 'billing worker', 'sidebar', 'release script', 'pricing cache', 'auth flow'] as const;
const FILES = ['src/search/index.ts', 'src/checkout/totals.ts', 'src/store/sessions.ts', 'src/billing/worker.ts', 'ui/Sidebar.tsx', 'scripts/release.sh', 'src/pricing/cache.ts', 'src/auth/session.ts'] as const;

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);

function steps(turn: number, file: string): ChatActivity[] {
  const count = 3 + (turn % 4);
  return Array.from({ length: count }, (_, i): ChatActivity => {
    const id = `long-${turn}-step-${i}`;
    if (i === 0) return { id, icon: 'check', text: `Read ${file}`, status: 'done', detail: `export function handle(input) {\n  // ${turn}\n}` };
    if (i === count - 1) return { id, icon: 'file-diff', text: `Edit ${file}`, status: 'done', paths: [file] };
    return { id, icon: 'terminal', text: `pnpm test ${file.split('/').at(-1)} --run`, status: turn % 11 === 0 && i === 1 ? 'failed' : 'done', detail: `✓ ${10 + i} tests passed` };
  });
}

function replyText(turn: number, area: string, file: string): string {
  const intro = `Turn ${turn + 1}: I looked at the **${area}** and found where the time goes. The slow path re-reads \`${file}\` on every call, and the result is thrown away each time.`;
  const list = ['- Cache the parsed result per request.', '- Drop the second lookup in the hot loop.', `- Keep the old behaviour behind \`${area.replace(/\s/g, '_')}_legacy\` for a release.`].join('\n');
  const code = turn % CODE_EVERY === 0 ? `\n\n\`\`\`ts\nconst cached = cache.get(key);\nif (cached) return cached;\nconst fresh = await load(key); // turn ${turn + 1}\ncache.set(key, fresh);\nreturn fresh;\n\`\`\`` : '';
  return `${intro}\n\n${list}${code}`;
}

function approval(turn: number, file: string): InputCard {
  return {
    id: `long-${turn}-approval`,
    kind: 'approval',
    title: 'Run a command',
    detail: `Run the tests for ${file}\n\npnpm test ${file} --run`,
    tool: 'Bash',
    options: [
      { id: 'allow', label: 'Allow', role: 'allow' },
      { id: 'deny', label: 'Deny', role: 'deny' },
    ],
    resolved: 'Allow',
  };
}

/** One turn: the user's message, the agent's reply, its tool lines (or an answered approval), its summary. */
function turnMessages(turn: number): ChatMessage[] {
  const area = AREAS[turn % AREAS.length]!;
  const file = FILES[turn % FILES.length]!;
  const startedAt = SAMPLE_START_MS + turn * TURN_SPACING_MS;
  const endedAt = startedAt + TURN_LENGTH_MS;
  const id = (part: string) => `long-${turn}-${part}`;
  const withApproval = turn % APPROVAL_EVERY === APPROVAL_EVERY - 1;
  const middle: ChatMessage = withApproval
    ? { id: id('ask'), author: 'agent', time: clock(startedAt + 30_000), text: '', input: approval(turn, file) }
    : { id: id('tools'), author: 'agent', time: clock(startedAt + 30_000), text: '', activity: steps(turn, file) };
  return [
    { id: id('you'), author: 'you', time: clock(startedAt), text: `Look at the ${area} next (${turn + 1}/${LONG_SAMPLE_TURNS}). Why is it slow, and what would you change?`, sentAt: startedAt, turnEndedAt: endedAt },
    { id: id('reply'), author: 'agent', time: clock(startedAt + 10_000), text: replyText(turn, area, file), activity: steps(turn + 1, file).slice(0, 2) },
    middle,
    { id: id('done'), author: 'agent', time: clock(endedAt), text: `Done with the ${area}: the tests pass and \`${file}\` is the only file changed.` },
  ];
}

/** The whole sample: `LONG_SAMPLE_TURNS` turns, four messages each. */
export function longConversation(turns = LONG_SAMPLE_TURNS): ChatMessage[] {
  return Array.from({ length: turns }, (_, turn) => turnMessages(turn)).flat();
}

export const LONG_SAMPLE_MESSAGE_COUNT = LONG_SAMPLE_TURNS * MESSAGES_PER_TURN;
