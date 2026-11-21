// The demo workspace (KESTREL_DEMO=1; `pnpm demo`): the fake workspace (seed.ts) with the rest of
// the app filled in, for screenshots and, later, a preview on the website. Everything here is
// SAMPLE data, made through the same Workspace operations real sessions use.
//
// What it adds to seed.ts: real folders for the four projects (so a project's Files pane and
// terminal have something in them), tags, pins, a group inside a project, an archived session, a
// second workstream that is complete, a wait between two sessions of the first, and saved actions.
// Review requests and a finished review come from index.ts (review-requests/fake.ts), and the
// scripted agent stands behind "Claude", so a new session answers.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SavedActionsPrefs } from './saved-actions/prefs.ts';
import type { Workspace } from './workspace.ts';

/** The sample projects' folders live here, under the demo's own data directory. */
export const demoProjectsDir = (dataDir: string): string => join(dataDir, 'projects');

const FILES: Record<string, Record<string, string>> = {
  bellbird: {
    'README.md': '# Bellbird\n\nThe storefront: search, cart and checkout.\n\n```bash\npnpm install\npnpm dev\n```\n',
    'package.json': '{\n  "name": "bellbird",\n  "private": true,\n  "scripts": { "dev": "vite", "test": "vitest run" }\n}\n',
    'src/search/cache.ts': 'const cache = new Map<string, Result[]>();\n\nexport async function search(query: string): Promise<Result[]> {\n  const cached = cache.get(query);\n  if (cached) return cached;\n  const result = await api.search(query);\n  cache.set(query, result);\n  return result;\n}\n',
    'src/cart/useCartTotals.ts': 'export function useCartTotals(lines: Line[]) {\n  const settled = useDebounced(lines, 250);\n  useEffect(() => {\n    recalculate(settled);\n  }, [settled]);\n}\n',
    'src/auth/session.ts': 'export async function onExpired() {\n  const draft = await saveDraft();\n  openRecoveryDialog({ draft, returnTo: location.pathname });\n}\n',
    'tests/search.test.ts': 'describe("search cache", () => {\n  it("discards stale responses", async () => {\n    expect(await race("a", "ab")).toEqual(resultsFor("ab"));\n  });\n});\n',
  },
  platform: {
    'README.md': '# Platform\n\nThe API, the workers and the search index.\n',
    'package.json': '{\n  "name": "platform",\n  "private": true,\n  "scripts": { "dev": "tsx watch src/server.ts", "test": "vitest run" }\n}\n',
    'src/pricing/lookup.ts': 'export async function priceFor(sku: string, list: string) {\n  return requestCache.remember(`${list}:${sku}`, () => db.prices.find({ sku, list }));\n}\n',
    'src/worker/retry.ts': 'export async function runJob(job: Job) {\n  await retry(() => run(job), { attempts: 3, backoff: "exponential" });\n}\n',
    'src/index/writer.ts': 'export async function writeBatch(docs: Doc[]) {\n  const staging = await segment.stage();\n  for (const doc of docs) await staging.put(doc);\n  await segment.swap(staging);\n}\n',
    'migrations/021_billing.sql': "CREATE TABLE billing_accounts (\n  id uuid PRIMARY KEY,\n  account_id uuid NOT NULL,\n  status text DEFAULT 'pending'\n);\n",
  },
  docs: {
    'README.md': '# Docs\n\nThe public documentation and the API reference.\n',
    'api/accounts.md': '## Create an account\n\nPOST /v2/accounts\n\nReturns the account and billing status.\n\n```json\n{ "id": "acct_123", "status": "active" }\n```\n',
    'api/pricing.md': '## Pricing\n\nResponses carry `X-Price-Cache` when the price came from the per-request cache.\n',
    'examples/account.json': '{\n  "id": "acct_123",\n  "status": "active"\n}\n',
  },
  'field-notes': {
    'november-release.md': '# November release\n\n- Search answers as you type\n- Expired sessions keep your draft\n- Switch sessions from the keyboard\n',
    'interviews/2026-11-03.md': '# Interview notes\n\nThree of five people looked for search before anything else.\n',
  },
};

/** The projects that are git repositories; the fourth is a plain folder. */
const GIT_PROJECTS = ['bellbird', 'platform', 'docs'];

type GitRunner = (...args: string[]) => void;

/** Write one sample project's folder, once: its files and, for a git project, one commit by a made-up author (never the user's identity, never signed). */
function makeFolder(dir: string, files: Readonly<Record<string, string>>, isGit: boolean): void {
  if (existsSync(dir)) return;
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  if (!isGit) return;
  const git: GitRunner = (...args) => execFileSync('git', ['-c', 'user.name=Kestrel Demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, stdio: 'ignore' });
  git('init');
  git('add', '-A');
  git('commit', '-m', 'Sample project for the Kestrel demo');
}

/** Make the sample projects' folders, once: a few files each. Returns each project's path. */
export function makeDemoProjects(dataDir: string): Record<string, string> {
  const root = demoProjectsDir(dataDir);
  const paths: Record<string, string> = {};
  for (const [project, files] of Object.entries(FILES)) {
    paths[project] = join(root, project);
    makeFolder(paths[project], files, GIT_PROJECTS.includes(project));
  }
  return paths;
}

/** The story scene's three projects (seed-story.ts), each with the files of one of the demo's. */
const STORY_PROJECTS: Readonly<Record<string, string>> = { app: 'bellbird', api: 'platform', docs: 'docs' };

/** Make the story scene's project folders, once. Returns each project's path. */
export function makeStoryProjects(dataDir: string): Record<string, string> {
  const root = demoProjectsDir(dataDir);
  const paths: Record<string, string> = {};
  for (const [project, source] of Object.entries(STORY_PROJECTS)) {
    paths[project] = join(root, project);
    makeFolder(paths[project], FILES[source]!, true);
  }
  return paths;
}

/** What the demo adds once the fake workspace is seeded (seed.ts `seedFakeWorkspace`). */
export async function seedDemoExtras(ws: Workspace, savedActions: SavedActionsPrefs): Promise<void> {
  // ---- tags: a ticket, a release and a feature, some on more than one session ----------------
  await ws.tagSession('search', 'perf');
  await ws.tagSession('queue', 'PROJ-482');
  await ws.tagSession('billing', 'PROJ-482');
  await ws.tagSession('auth', 'v2.3');
  await ws.tagSession('docs', 'v2.3');
  await ws.tagSession('shortcuts', 'v2.3');

  // ---- a group inside a project --------------------------------------------------------------
  const billing = await ws.addGroup('Billing v2', { projectId: 'platform' });
  await ws.moveSession('billing', billing.id);

  // ---- pins: a session and a project (a pinned review request is the user's to add) ----------
  await ws.setPinned('session', 'auth', true);
  await ws.setPinned('project', 'docs', true);

  // ---- an archived session -------------------------------------------------------------------
  await ws.addSession({ id: 'old-spike', title: 'Spike: server-side rendering for search', agent: 'codex', startedIn: 'bellbird', landedIn: 'bellbird', state: 'done', note: 'Finished · not pursued', branch: 'spike/ssr-search' });
  await ws.setDetail('old-spike', {
    messages: [
      { author: 'you', time: '14:02', text: 'Try rendering search results on the server and tell me if it is worth it.' },
      { author: 'agent', time: '14:31', text: 'It works, but first paint is only 40 ms faster and the cache gets harder to reason about. I would not pursue it.' },
    ],
    files: [],
    agentOutput: '',
  });
  await ws.setArchived('session', 'old-spike', true);

  // ---- a second workstream, finished ---------------------------------------------------------
  await ws.addSession({ id: 'onboarding', title: 'Ship the new onboarding', agent: 'claude', startedIn: null, landedIn: null, state: 'done', note: 'Finished' });
  await ws.setDetail('onboarding', {
    messages: [
      { author: 'you', time: '09:10', text: 'Ship the guided first task we settled on: the app change and the docs page for it.' },
      { author: 'agent', time: '09:12', text: 'That is one change in Bellbird and one page in Docs, so I split it. Both are done and their pull requests are open.', activity: [{ icon: 'split', text: 'Delegated to 2 sessions: Bellbird, Docs' }] },
    ],
    files: [],
    agentOutput: '',
  });
  const rollout = await ws.delegate(
    'onboarding',
    [
      { projectId: 'bellbird', brief: 'Build the guided first task' },
      { projectId: 'docs', brief: 'Write the getting-started page', agent: 'opencode' },
    ],
    { name: 'New onboarding', objective: 'Ship the guided first task: the app change and the docs page for it.' },
  );
  for (const child of rollout.children) {
    await ws.setLandedIn(child.id, child.startedIn);
    await ws.setState(child.id, 'done', 'Finished · pull request open');
    await ws.setDetail(child.id, {
      messages: [
        { author: 'you', time: '09:12', text: `From “Ship the new onboarding”: ${child.title}.` },
        { author: 'agent', time: '09:48', text: 'Done, with tests. The pull request is open and ready for review.', activity: [{ icon: 'check', text: 'Read project instructions' }, { icon: 'file-diff', text: 'Updated 4 files in this worktree' }] },
      ],
      files: [],
      agentOutput: '',
    });
  }
  if (rollout.workstream) await ws.setWorkstreamStatus(rollout.workstream.id, 'complete');

  // ---- a wait: in the first workstream, the docs session waits on Platform's ------------------
  const state = await ws.state();
  const checkout = state.workstreams.find((w) => w.name === 'Checkout latency');
  const pricing = state.sessions.find((s) => s.title === 'Cache the pricing lookup');
  const header = state.sessions.find((s) => s.title === 'Document the pricing cache header');
  if (checkout && pricing && header) await ws.putWait({ workstreamId: checkout.id, waiterId: header.id, targetId: pricing.id, reason: 'The name of the cache header' });

  // ---- saved actions, for the ▶ button of the Terminal pane ----------------------------------
  await savedActions.set('bellbird', [
    { id: 'dev', name: 'Dev server', command: 'pnpm dev', folder: '', previewUrl: 'http://localhost:5173' },
    { id: 'test', name: 'Tests', command: 'pnpm test', folder: '', previewUrl: '' },
  ]);
  await savedActions.set('platform', [
    { id: 'api', name: 'API', command: 'pnpm dev', folder: '', previewUrl: '' },
    { id: 'migrate', name: 'Validate migrations', command: 'pnpm migration:validate', folder: '', previewUrl: '' },
  ]);
}
