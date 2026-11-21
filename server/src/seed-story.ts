// The story scene (KESTREL_DEMO=1 KESTREL_DEMO_SCENE=story; `pnpm demo --story`): the demo cut down
// to one moment, for a screenshot on the website. One task, asked once in App and split across
// App, API and Docs: three sessions, one of them with a question for the user; everything unrelated is folded
// away. Where seed-demo.ts shows every part of the app, this shows one thing clearly. SAMPLE data,
// made through the same Workspace operations real sessions use.
import type { ChatMessage } from './model.ts';
import { diff, SAMPLE_SLASH_COMMANDS } from './seed.ts';
import { sanitizeSidebar } from './shared/sidebar.ts';
import type { Tab } from './shared/tabs.ts';
import type { Workspace } from './workspace.ts';

/** The task, in the user's words: the lead session's first message and the workstream's objective. */
const TASK = 'Checkout takes four seconds for some customers since Tuesday. Find out why and fix it. I don’t know which repo it’s in.';
const LEAD_TITLE = 'Checkout is slow in production';

/** The one question waiting on the user. The session that asks it is the one the scene opens on. */
export const STORY_QUESTION = {
  text: 'How should the cart wait before it recalculates? A 250 ms debounce updates the total while you type, a little late. Recalculating only when the field loses focus is one request per edit, but the total is stale until you click away.',
  choices: ['250 ms debounce', 'When the field loses focus'],
};

const READ: NonNullable<ChatMessage['activity']> = [
  { icon: 'check', text: 'Read project instructions' },
  { icon: 'check', text: 'Inspected relevant files' },
];

const fromLead = (brief: string): string => `From “${LEAD_TITLE}”: ${brief}`;

/** A finished session nobody needs to look at, for the folded folders. */
async function quiet(ws: Workspace, s: { id: string; title: string; project: string; groupId: string; ask: string; answer: string }): Promise<void> {
  await ws.addSession({ id: s.id, title: s.title, agent: 'claude', startedIn: s.project, landedIn: s.project, groupId: s.groupId, state: 'done', note: 'Finished' });
  await ws.setDetail(s.id, {
    messages: [
      { author: 'you', time: '09:12', text: s.ask },
      { author: 'agent', time: '09:40', text: s.answer, activity: READ },
    ],
    files: [],
    agentOutput: '',
    slashCommands: SAMPLE_SLASH_COMMANDS,
  });
}

/** `paths`: each project's real folder, by project id (seed-demo.ts `makeStoryProjects`). */
export async function seedStory(ws: Workspace, paths: Readonly<Record<string, string>> = {}): Promise<void> {
  await ws.addProject({ id: 'app', name: 'App', path: paths.app ?? '~/Code/app', isGit: true });
  await ws.addProject({ id: 'api', name: 'API', path: paths.api ?? '~/Code/api', isGit: true });
  await ws.addProject({ id: 'docs', name: 'Docs', path: paths.docs ?? '~/Code/docs', isGit: true });

  // ---- the unrelated work: two folders of finished sessions, folded in the sidebar ------------
  const launch = await ws.addGroup('November launch', { id: 'november-launch' });
  const explorations = await ws.addGroup('Explorations', { id: 'explorations' });
  await quiet(ws, { id: 'shortcuts', title: 'Add keyboard shortcuts', project: 'app', groupId: launch.id, ask: 'Add shortcuts for switching sessions and starting a new one.', answer: 'Both shortcuts are in, with tests.' });
  await quiet(ws, { id: 'release', title: 'Draft the release notes', project: 'docs', groupId: launch.id, ask: 'Draft release notes for the November launch.', answer: 'The draft is ready for a final read.' });
  await quiet(ws, { id: 'ssr', title: 'Try server-side rendering for search', project: 'app', groupId: explorations.id, ask: 'Is rendering search on the server worth it?', answer: 'First paint is only 40 ms faster. I would not pursue it.' });

  // ---- the task: asked once, in App, where its own part of the fix is ---------------------------
  await ws.addSession({ id: 'checkout', title: LEAD_TITLE, agent: 'claude', startedIn: 'app', landedIn: 'app', state: 'attention', note: 'Waiting for your decision', branch: 'kestrel/cart-debounce' });
  await ws.setDetail('checkout', {
    messages: [
      { author: 'you', time: '10:24', text: TASK },
      {
        author: 'agent',
        time: '10:26',
        text: 'The delay is the pricing lookup, called once per cart line with no cache, and the cart recalculates on every keystroke. The cart is here in App, so I am fixing that myself. The lookup is in API and the new cache header needs a note in Docs, so I started a session in each.',
        activity: [...READ, { icon: 'split', text: 'Delegated to 2 sessions: API, Docs' }],
      },
      {
        author: 'agent',
        time: '10:31',
        text: 'The cart no longer recalculates on every keystroke, and the test for rapid edits passes. API and Docs are still working. One choice is yours before I finish here.',
        activity: [{ icon: 'file-diff', text: 'Updated 1 file in this worktree' }],
        question: STORY_QUESTION,
      },
    ],
    files: [diff('src/cart/useCartTotals.ts', [[' ', 'export function useCartTotals(lines: Line[]) {'], ['-', '  useEffect(() => { recalculate(lines); }, [lines]);'], ['+', '  const settled = useDebounced(lines, 250);'], ['+', '  useEffect(() => { recalculate(settled); }, [settled]);'], [' ', '}']], 8)],
    agentOutput: '$ pnpm test cart\n\n✓ recalculates once after rapid edits',
    slashCommands: SAMPLE_SLASH_COMMANDS,
  });

  // ---- the other two sessions, one per project, in one workstream with the first ----------------
  const { children, workstream } = await ws.delegate(
    'checkout',
    [
      { projectId: 'api', brief: 'Cache the pricing lookup', agent: 'codex' },
      { projectId: 'docs', brief: 'Document the pricing cache header', agent: 'opencode' },
    ],
    { name: 'Checkout latency', objective: TASK },
  );
  const [pricing, header] = children as [(typeof children)[number], (typeof children)[number]];

  await ws.setLandedIn(pricing.id, 'api');
  await ws.setState(pricing.id, 'running', 'Running the pricing tests');
  await ws.setDetail(pricing.id, {
    messages: [
      { author: 'you', time: '10:26', text: fromLead('cache the pricing lookup so it runs once per cart, not once per line.') },
      { author: 'agent', time: '10:30', text: 'The lookup is now cached per request and keyed by price list. I’m running the pricing tests.', activity: [...READ, { icon: 'file-diff', text: 'Updated 1 file in this worktree' }] },
    ],
    files: [diff('src/pricing/lookup.ts', [[' ', 'export async function priceFor(sku: string, list: string) {'], ['-', '  return db.prices.find({ sku, list });'], ['+', '  return requestCache.remember(`${list}:${sku}`, () =>'], ['+', '    db.prices.find({ sku, list }),'], ['+', '  );'], [' ', '}']], 11)],
    agentOutput: '$ pnpm test pricing\n\n✓ looks a price up once per request\n\nRunning 41 more…',
    slashCommands: SAMPLE_SLASH_COMMANDS,
  });

  await ws.setState(header.id, 'running', 'Reading the API reference');
  await ws.setDetail(header.id, {
    messages: [
      { author: 'you', time: '10:26', text: fromLead('document the new pricing cache header once API has named it.') },
      { author: 'agent', time: '10:29', text: 'I’m reading the API reference to find where response headers are described. Nothing is changed yet.', activity: READ },
    ],
    files: [],
    agentOutput: '',
    slashCommands: SAMPLE_SLASH_COMMANDS,
  });
  if (workstream) await ws.putWait({ workstreamId: workstream.id, waiterId: header.id, targetId: pricing.id, reason: 'The name of the cache header' });

  // ---- how the window opens: on the question, with the unrelated folders folded ----------------
  const tabs: Tab[] = [{ id: 'story', kind: 'session', sessionId: 'checkout' }];
  await ws.setUiState(JSON.stringify({ tabs: { tabs, activeId: 'story' }, remembered: null, sidebar: sanitizeSidebar({ collapsed: [launch.id, explorations.id] }) }));
}
