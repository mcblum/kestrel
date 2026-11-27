// Puts a pretend second computer's sessions into a checkout's replica, so the page of a session that runs on another
// computer can be looked at without two Macs (account-sessions.md, section 19). Development only: it writes through
// the replica (`AccountReplica`) into the store `KESTREL_DATA_DIR` names, which must be set, and it refuses the
// installed app's store. Not part of the app.
//
//   KESTREL_DATA_DIR=/tmp/kestrel-remote pnpm --filter @kestrel/server exec tsx scripts/seed-remote-sessions.ts
//   KESTREL_DATA_DIR=/tmp/kestrel-remote KESTREL_PORT=4318 pnpm dev:server
//
// Four sessions on "Studio Laptop": a short finished one; a long one of several hundred messages, with attachments and
// a tool's picture; one running; and one whose kept copy is behind its head (so the page asks the laptop, which
// cannot be reached here, and says it did not answer). Run it with the server stopped; it replaces what it wrote
// before.
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { CHUNK_MESSAGES } from '../src/connect/link/held.ts';
import { INSTALLED_DIR } from '../src/data-dir.ts';
import type { ChatMessage } from '../src/model.ts';
import { sqlitePersistence } from '../src/persistence/sqlite.ts';
import { conversationStamp, type AccountHead, type Machine } from '../src/shared/machines.ts';
import { Workspace } from '../src/workspace.ts';

const dir = process.env.KESTREL_DATA_DIR;
if (!dir) throw new Error('Set KESTREL_DATA_DIR to the store to seed (a folder of its own, not your everyday one).');
if (dir === join(homedir(), INSTALLED_DIR) || basename(dir) === INSTALLED_DIR) throw new Error('That is the installed app’s store. Use a folder of its own.');
mkdirSync(dir, { recursive: true });

const LAPTOP: Machine = { id: 'seed-studio-laptop', name: 'Studio Laptop' };
const now = Date.now();
const MIN = 60_000;

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** A conversation of `turns` question-and-answer pairs, the answers long enough to scroll, starting `start` ms ago. */
function conversation(prefix: string, turns: number, start: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let n = 1; n <= turns; n++) {
    const at = now - start + n * 20_000;
    messages.push({ id: `${prefix}-q${n}`, author: 'you', time: time(at), at, text: n === 1 ? `Turn ${n}: look at the checkout flow and tell me what is slow.` : `Turn ${n}: carry on with the next part.` });
    messages.push({
      id: `${prefix}-a${n}`,
      author: 'agent',
      time: time(at + 10_000),
      at: at + 10_000,
      text: `Answer ${n}. I read \`cart/total.ts\` and the request log.\n\n- The total is worked out twice per render.\n- The tax table is fetched on every keystroke.\n\n\`\`\`ts\nconst total = useMemo(() => sum(lines), [lines]);\n\`\`\`\n\nNext I will move the tax table into the store so it is read once.`,
      activity: [
        { id: `${prefix}-t${n}a`, icon: 'terminal', text: 'pnpm test cart', status: 'done', detail: '12 passed' },
        { id: `${prefix}-t${n}b`, icon: 'file-diff', text: 'Edited cart/total.ts', status: 'done', paths: ['cart/total.ts'] },
      ],
    });
  }
  return messages;
}

function head(id: string, title: string, messages: ChatMessage[], state: AccountHead['state'], lastActivityAt: number): AccountHead {
  return {
    id,
    runsOn: LAPTOP.id,
    title,
    agent: 'claude',
    state,
    note: '',
    project: { id: 'seed-shop', name: 'Shop' },
    repos: [],
    filing: 'landed',
    branch: 'checkout-speed',
    request: null,
    createdAt: lastActivityAt - 60 * MIN,
    updatedAt: lastActivityAt,
    lastActivityAt,
    messages: messages.length,
    chunks: Math.ceil(messages.length / CHUNK_MESSAGES),
  };
}

const chunksOf = (messages: ChatMessage[]) => Array.from({ length: Math.ceil(messages.length / CHUNK_MESSAGES) }, (_, n) => ({ n, messages: messages.slice(n * CHUNK_MESSAGES, (n + 1) * CHUNK_MESSAGES) }));

const short = conversation('short', 2, 30 * MIN);
const long = conversation('long', 160, 300 * MIN);
// A picture the user attached and one a tool returned: their files are on the laptop.
long[2] = { ...long[2]!, attachments: [{ id: 'att-1', name: 'checkout-before.png', mediaType: 'image/png', size: 182_000, kind: 'image' }, { id: 'att-2', name: 'trace.json', mediaType: 'application/json', size: 41_000, kind: 'file' }] };
long[5] = { ...long[5]!, images: ['screenshot-checkout.png'] };
const running = [...conversation('running', 3, 10 * MIN), { id: 'running-a4', author: 'agent' as const, time: time(now), at: now, text: 'Reading the payment form now…', streaming: true }];
const behind = conversation('behind', 4, 60 * MIN);

const sessions = [
  { head: head('seed-short', 'Short: why is checkout slow', short, 'done', now - 25 * MIN), kept: short, current: true },
  { head: head('seed-long', 'Long: speed up the cart, 320 messages', long, 'done', now - 5 * MIN), kept: long, current: true },
  { head: head('seed-running', 'Running: payment form', running, 'running', now), kept: running, current: true },
  // The head says six more messages than are kept: the upload of the last turns has not been read here.
  { head: head('seed-behind', 'Behind: copy older than its head', behind, 'done', now - 2 * MIN), kept: behind.slice(0, behind.length - 2), current: false },
];

const db = sqlitePersistence(join(dir, process.env.KESTREL_FAKE === '1' ? 'kestrel-fake.sqlite' : 'kestrel.sqlite'));
const workspace = new Workspace(db);
await workspace.account.apply({ heads: sessions.map((s) => ({ machine: LAPTOP, head: s.head })), gone: [], members: [LAPTOP.id], whole: true, mark: null });
for (const s of sessions) {
  const chunks = chunksOf(s.kept);
  await workspace.account.putChunks(s.head.id, chunks, s.current ? s.head.chunks : chunks.length, s.current ? conversationStamp(s.head) : `${conversationStamp(s.head)}|behind`, now - 3 * MIN);
}
for (const s of sessions) console.log(`${s.head.id}: ${s.head.title} (${s.kept.length} of ${s.head.messages} messages kept)`);
console.log(`Seeded ${sessions.length} sessions from ${LAPTOP.name} into ${dir}.`);
