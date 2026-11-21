// Fake workspace for building the UI. Mirrors the prototype's sample sessions and adds the
// cases the design doc introduces: a delegate split (automatic folder, orchestrator, one child
// per repo), a handoff trail, a child moved out of its folder, and a plain-folder project.
// It goes through the same Workspace operations real sessions will use.
import type { SessionCommand } from './shared/commands.ts';
import type { ChangedFile, ChatMessage } from './model.ts';
import { SAMPLE_EARLIER_LINKS, SAMPLE_LINKED_SESSION, SAMPLE_SHARED_LINKS, SAMPLE_SHARED_SESSION, sampleLinksOn } from './pull-requests/fake.ts';
import type { LiveBackgroundTask } from './shared/background-tasks.ts';
import { SHOWCASE_MESSAGES } from './seed-showcase.ts';
import { longConversation } from './seed-long.ts';
import type { Workspace } from './workspace.ts';

export type Line = [' ' | '+' | '-', string];

export function diff(path: string, lines: Line[], start = 18): ChangedFile {
  const before = lines.filter(([k]) => k !== '+').length;
  const after = lines.filter(([k]) => k !== '-').length;
  const isNew = before === 0;
  const head = isNew
    ? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${after} @@\n`
    : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${start},${before} +${start},${after} @@\n`;
  return { path, status: isNew ? 'A' : 'M', diff: head + lines.map(([k, t]) => k + t).join('\n') + '\n' };
}

const MINUTE_MS = 60_000;

/**
 * SAMPLE: background work left running in "Update API docs", so the strip at the foot of a session
 * can be seen without a real agent: a dev server the agent named, a watcher named from its command
 * alone, and a watcher described in words. Live only (never stored); `now` is when the server started.
 */
/** SAMPLE: a short list of slash commands, shaped like what Claude Code reports. */
/** SAMPLE: what the scripted agent says "/" offers; also stored with the sample sessions. */
export const SAMPLE_SLASH_COMMANDS = [
  { name: 'compact', description: 'Clear conversation history but keep a summary in context', argumentHint: '<optional instructions>' },
  { name: 'context', description: 'Show what is using the context window' },
  { name: 'code-review', description: 'Review the current diff for correctness bugs', argumentHint: '[low|medium|high] [target]' },
  { name: 'simplify', description: 'Review the changed code for reuse and simplification, then apply the fixes' },
  { name: 'security-review', description: 'Complete a security review of the pending changes on the current branch' },
  { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation' },
  { name: 'ship', description: 'Run tests, review the diff, bump the version and open a pull request' },
];

export function sampleBackgroundTasks(now: number): { sessionId: string; tasks: LiveBackgroundTask[] } {
  const devServer = 'cd services/api && PORT=4000 pnpm --filter @docs/api dev 2>&1 | tee /tmp/api-dev.log';
  const siteWatch = 'pnpm --filter @docs/site exec astro build --watch > /tmp/site-watch.log 2>&1';
  return {
    sessionId: 'docs',
    tasks: [
      { id: 'sample-api-dev', kind: 'command', description: devServer, label: 'Start the API dev server', command: devServer, since: now - 4 * MINUTE_MS },
      { id: 'sample-site-watch', kind: 'command', description: siteWatch, since: now - 12 * MINUTE_MS },
      { id: 'sample-ci-watch', kind: 'watcher', description: 'Watch the docs preview deploy until it goes green', since: now - 37 * MINUTE_MS },
    ],
  };
}

/**
 * SAMPLE: the Commands pane for the same session: the background work above as running commands
 * (with what each has printed), and three that ended (completed, failed, stopped). Live only.
 */
export function sampleCommands(now: number): { sessionId: string; commands: SessionCommand[]; outputs: Record<string, string> } {
  const { sessionId, tasks } = sampleBackgroundTasks(now);
  const running: SessionCommand[] = tasks.map((t) => ({ ...t, id: `tool-${t.id}`, taskId: t.id, status: 'running' }));
  const ended: SessionCommand[] = [
    { id: 'tool-sample-test', kind: 'command', description: 'pnpm --filter @docs/api test', command: 'pnpm --filter @docs/api test', label: 'Run the API tests', status: 'completed', since: now - 9 * MINUTE_MS, endedAt: now - 8 * MINUTE_MS },
    { id: 'tool-sample-lint', kind: 'command', description: 'pnpm lint', command: 'pnpm lint', status: 'failed', since: now - 15 * MINUTE_MS, endedAt: now - 15 * MINUTE_MS + 20_000 },
    { id: 'tool-sample-old-dev', kind: 'command', description: 'pnpm --filter @docs/api dev', command: 'pnpm --filter @docs/api dev', label: 'Start the API dev server', status: 'stopped', since: now - 30 * MINUTE_MS, endedAt: now - 5 * MINUTE_MS },
  ];
  const outputs: Record<string, string> = {
    'tool-sample-api-dev': '\u001b[32m✓\u001b[39m Compiled in 812ms\nServer listening on http://localhost:4000\nGET /v1/pages 200 14ms\nGET /v1/pages/intro 200 6ms\nGET /v1/search?q=webhooks 200 31ms\n',
    'tool-sample-site-watch': 'watching for file changes...\n12:04:51 [build] 38 page(s) built in 2.41s\n12:07:13 [build] 38 page(s) built in 1.12s\n',
    // Long enough that the output has to scroll.
    'tool-sample-test': ` RUN  v3.2.4 /services/api\n\n${Array.from({ length: 23 }, (_, i) => ` ✓ src/${i < 14 ? 'pages' : 'search'}.test.ts > case ${i + 1} ${3 + ((i * 7) % 11)}ms\n`).join('')}\n ✓ src/pages.test.ts (14 tests) 41ms\n ✓ src/search.test.ts (9 tests) 88ms\n\n Test Files  2 passed (2)\n      Tests  23 passed (23)\n`,
    'tool-sample-lint': 'services/api/src/search.ts\n  42:7  error  \'unused\' is assigned a value but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)\n',
  };
  return { sessionId, commands: [...running, ...ended], outputs };
}

function talk(task: string, agentText: string, opts: { repo: boolean; files: number; question?: { text: string; choices: string[] }; extra?: ChatMessage['activity'] }): ChatMessage[] {
  const activity: NonNullable<ChatMessage['activity']> = opts.repo
    ? [
        { icon: 'check', text: 'Read project instructions' },
        { icon: 'check', text: 'Inspected relevant files' },
        ...(opts.files > 0 ? [{ icon: 'file-diff' as const, text: `Updated ${opts.files} ${opts.files === 1 ? 'file' : 'files'} in this worktree` }] : []),
      ]
    : [
        { icon: 'check', text: 'Reviewed the task and constraints' },
        { icon: 'check', text: 'Searched the registered projects (read only)' },
      ];
  return [
    { author: 'you', time: '10:24', text: task },
    { author: 'agent', time: '10:26', text: agentText, activity: [...activity, ...(opts.extra ?? [])], question: opts.question },
  ];
}

/** `paths`: where each project's folder really is, by project id (the demo makes them, seed-demo.ts); the made-up paths otherwise. */
export async function seedFakeWorkspace(ws: Workspace, paths: Readonly<Record<string, string>> = {}): Promise<void> {
  await ws.addProject({ id: 'bellbird', name: 'Bellbird', path: paths.bellbird ?? '~/Code/bellbird', isGit: true });
  await ws.addProject({ id: 'platform', name: 'Platform', path: paths.platform ?? '~/Code/platform', isGit: true });
  await ws.addProject({ id: 'docs', name: 'Docs', path: paths.docs ?? '~/Code/docs', isGit: true });
  await ws.addProject({ id: 'field-notes', name: 'Field notes', path: paths['field-notes'] ?? '~/Documents/field-notes', isGit: false });

  const launch = await ws.addGroup('November launch', { id: 'november-launch' });
  const explorations = await ws.addGroup('Explorations', { id: 'explorations' });

  const wt = (project: string, id: string) => `~/.kestrel/worktrees/${project}/${id}`;
  const add = async (
    s: { id: string; title: string; agent: 'claude' | 'codex' | 'opencode'; project: string | null; landed?: boolean; group?: string; state: 'running' | 'attention' | 'done'; note: string; branch?: string },
    detail: { messages: ChatMessage[]; files?: ChangedFile[]; output?: string },
  ) => {
    await ws.addSession({
      id: s.id,
      title: s.title,
      agent: s.agent,
      startedIn: s.project,
      landedIn: s.landed === false ? null : s.project,
      groupId: s.group ?? null,
      state: s.state,
      note: s.note,
      branch: s.branch ?? null,
      worktreePath: s.project && s.branch ? wt(s.project, s.id) : null,
    });
    // SAMPLE: the slash commands a real agent would list, so the message box's "/" menu shows in fake mode.
    await ws.setDetail(s.id, { messages: detail.messages, files: detail.files ?? [], agentOutput: detail.output ?? '', slashCommands: SAMPLE_SLASH_COMMANDS });
  };

  await add({ id: 'showcase', title: 'Everything a conversation can show', agent: 'claude', project: 'platform', state: 'attention', note: 'Needs you · Plan ready', branch: 'feat/showcase' }, { messages: SHOWCASE_MESSAGES });
  // SAMPLE: about 1,000 messages with tool lines and folded approvals, for checking that a long conversation stays fast (seed-long.ts).
  await add({ id: 'long-conversation', title: 'A long conversation (1,000 messages)', agent: 'claude', project: 'platform', state: 'done', note: 'Finished', branch: 'perf/long-conversation' }, { messages: longConversation() });

  // ---- the prototype's sessions ------------------------------------------------
  await add(
    { id: 'search', title: 'Make search feel instant', agent: 'codex', project: 'bellbird', group: explorations.id, state: 'running', note: 'Optimizing query cache and optimistic results', branch: 'feat/instant-search' },
    {
      messages: talk('Speed up global search. Keep results stable while typing and preserve keyboard navigation.', 'The query cache is implemented. I’m checking stale responses and keyboard navigation before the final test run.', { repo: true, files: 3 }),
      files: [
        diff('src/search/cache.ts', [[' ', 'export async function search(query) {'], ['-', '  return api.search(query);'], ['+', '  const cached = cache.get(query);'], ['+', '  if (cached) return cached;'], ['+', '  const result = await api.search(query);'], ['+', '  cache.set(query, result);'], ['+', '  return result;'], [' ', '}']]),
        diff('src/search/useSearch.ts', [[' ', 'export function useSearch(query: string) {'], ['-', '  const [results, setResults] = useState([]);'], ['+', '  const [results, setResults] = useState<Result[]>([]);'], ['+', '  const latest = useRef(0);'], [' ', '  useEffect(() => {']], 6),
        diff('tests/search.test.ts', [['+', 'describe("search cache", () => {'], ['+', '  it("discards stale responses", async () => {'], ['+', '    expect(await race("a", "ab")).toEqual(resultsFor("ab"));'], ['+', '  });'], ['+', '});']]),
      ],
      output: '$ pnpm test search\n\n✓ deduplicates identical requests\n✓ discards stale responses\n\nRunning keyboard navigation tests…',
    },
  );
  await add(
    { id: 'docs', title: 'Update API docs', agent: 'claude', project: 'docs', group: launch.id, state: 'running', note: 'Writing examples for the new endpoints', branch: 'docs/api-refresh' },
    {
      messages: talk('Update the API reference for the November launch. Include real request and response examples.', 'The endpoint examples are updated. I’m checking response shapes against the Platform schema.', { repo: true, files: 2 }),
      files: [
        diff('api/accounts.md', [[' ', '## Create an account'], [' ', 'POST /v2/accounts'], ['-', 'Returns the account ID.'], ['+', 'Returns the account and billing status.'], ['+', ''], ['+', '```json'], ['+', '{ "id": "acct_123", "status": "active" }'], ['+', '```']], 40),
        diff('examples/account.json', [['+', '{'], ['+', '  "id": "acct_123",'], ['+', '  "status": "active"'], ['+', '}']]),
      ],
      output: '$ pnpm docs:check\n\n✓ Account examples validated\n✓ Billing examples validated\n\nChecking internal links…',
    },
  );
  await add(
    { id: 'queue', title: 'Background job retries', agent: 'codex', project: 'platform', group: launch.id, state: 'running', note: 'Running integration tests', branch: 'fix/job-retries' },
    {
      messages: talk('Add bounded retries and exponential backoff to the worker.', 'Backoff is implemented. I’m validating the worker and dead-letter queue behavior.', { repo: true, files: 1 }),
      files: [diff('src/worker/retry.ts', [['-', 'await run(job);'], ['+', 'await retry(() => run(job), {'], ['+', '  attempts: 3,'], ['+', '  backoff: "exponential",'], ['+', '});']], 52)],
      output: '$ pnpm test worker\n\n✓ Applies exponential backoff\n✓ Moves exhausted jobs to dead-letter queue',
    },
  );
  await add(
    { id: 'research', title: 'Explore onboarding patterns', agent: 'claude', project: null, group: explorations.id, state: 'running', note: 'Comparing three directions' },
    {
      messages: talk('Explore three onboarding approaches that get people to their first useful result quickly.', 'I’m comparing a guided first task, progressive onboarding, and a lightweight checklist. A guided first task looks promising because it teaches through actual work.', { repo: false, files: 0 }),
      output: 'No terminal attached.\n\nThis session is not scoped to a project.',
    },
  );
  await add(
    { id: 'auth', title: 'Auth flow polish', agent: 'claude', project: 'bellbird', group: launch.id, state: 'attention', note: 'Waiting for your decision', branch: 'feat/auth-polish' },
    {
      messages: talk('Polish the expired-session experience. Keep people’s work safe and make recovery feel effortless.', 'The recovery flow is in place. Drafts are preserved locally, and signing back in brings you right back to where you left off.', {
        repo: true,
        files: 3,
        question: { text: 'When a session expires, should we show a recovery dialog or immediately redirect to sign-in?', choices: ['Recovery dialog', 'Redirect to sign-in'] },
      }),
      files: [
        diff('src/auth/session.ts', [[' ', 'export async function onExpired() {'], ['-', '  navigate("/sign-in");'], ['+', '  const draft = await saveDraft();'], ['+', '  openRecoveryDialog({'], ['+', '    draft,'], ['+', '    returnTo: location.pathname,'], ['+', '  });'], [' ', '}']]),
        diff('src/components/RecoveryDialog.tsx', [['+', 'export function RecoveryDialog() {'], ['+', '  return ('], ['+', '    <Dialog title="Welcome back">'], ['+', '      <p>Your work is right where you left it.</p>'], ['+', '      <SignInButton />'], ['+', '    </Dialog>'], ['+', '  );'], ['+', '}']]),
        diff('tests/session.test.ts', [['+', 'describe("session recovery", () => {'], ['+', '  it("preserves the draft", async () => {'], ['+', '    await expireSession();'], ['+', '    expect(await readDraft()).toBeDefined();'], ['+', '  });'], ['+', '});']]),
      ],
      output: '$ pnpm test session\n\n✓ preserves an unsaved draft\n✓ restores the previous route\n✓ retries after authentication\n\nTest Files  1 passed (1)\n     Tests  8 passed (8)',
    },
  );
  await add(
    { id: 'billing', title: 'Billing migration', agent: 'codex', project: 'platform', group: launch.id, state: 'attention', note: 'Waiting for plan approval', branch: 'feat/billing-v2' },
    {
      messages: talk('Prepare a reversible migration for billing v2. Show me the rollout plan before applying changes.', 'The plan adds billing tables, backfills accounts, and switches reads behind a feature flag. The schema changes have not been applied.', {
        repo: true,
        files: 1,
        question: { text: 'The migration plan is ready. Review the staged rollout before approving execution.', choices: ['Keep in planning', 'Review rollback plan'] },
      }),
      files: [diff('migrations/021_billing.sql', [['+', 'CREATE TABLE billing_accounts ('], ['+', '  id uuid PRIMARY KEY,'], ['+', '  account_id uuid NOT NULL,'], ['+', "  status text DEFAULT 'pending'"], ['+', ');'], ['+', 'CREATE INDEX billing_account_idx'], ['+', '  ON billing_accounts(account_id);']])],
      output: '$ pnpm migration:validate\n\n✓ Schema validation passed\n✓ Rollback validation passed\n\nAwaiting approval. No migration applied.',
    },
  );
  // Requests it opened on branches it was on before: still listed with the one on its branch now (fake.ts).
  await ws.recordRequests(SAMPLE_LINKED_SESSION, SAMPLE_EARLIER_LINKS);
  await add(
    { id: 'shortcuts', title: 'Keyboard shortcuts', agent: 'codex', project: 'bellbird', state: 'done', note: '12 files changed · Tests passed', branch: 'feat/shortcuts' },
    {
      messages: talk('Add session switching and command palette shortcuts.', 'Shortcuts are implemented and all 24 tests pass. The changes are ready for review.', { repo: true, files: 1 }),
      files: [diff('src/shortcuts.ts', [[' ', 'export function registerAll() {'], ['+', '  register("mod+k", openSwitcher);'], ['+', '  register("mod+n", newSession);'], [' ', '}']], 3)],
      output: '$ pnpm test shortcuts\n\nTest Files  1 passed (1)\n     Tests  24 passed (24)',
    },
  );
  await add(
    { id: 'release', title: 'Draft release notes', agent: 'opencode', project: 'field-notes', state: 'done', note: 'Draft ready for a final read' },
    {
      messages: talk('Draft release notes for the November launch.', 'The draft covers faster search, improved authentication, and keyboard navigation. It is ready for your final read.', { repo: true, files: 1 }),
      files: [diff('november-release.md', [['+', '# November release'], ['+', ''], ['+', '- Search answers as you type'], ['+', '- Expired sessions keep your draft'], ['+', '- Switch sessions from the keyboard']])],
      output: 'Plain folder · changes tracked in Kestrel’s shadow history, nothing written into the folder’s own metadata.',
    },
  );

  // ---- a delegate split: one task, three repos --------------------------------------
  await add(
    { id: 'checkout', title: 'Checkout is slow in production', agent: 'claude', project: null, state: 'running', note: 'Coordinating 3 sessions' },
    {
      messages: talk(
        'Checkout takes four seconds for some customers since Tuesday. Find out why and fix it. I don’t know which repo it’s in.',
        'The delay is the pricing lookup, called once per cart line with no cache, and the cart recalculates on every keystroke. That is two fixes in two repos, plus a docs note for the new cache header, so I split the work.',
        { repo: false, files: 0, extra: [{ icon: 'split', text: 'Delegated to 3 sessions: Platform, Bellbird, Docs' }] },
      ),
      output: 'No terminal attached.\n\nThis session has no project. It reads the registered projects and delegates changes.',
    },
  );
  // The orchestrator was filed in a group by hand; its children begin there, and the split, which
  // reaches three projects, has a workstream.
  const checkoutGroup = await ws.addGroup('Checkout latency');
  await ws.moveSession('checkout', checkoutGroup.id);
  const { children } = await ws.delegate(
    'checkout',
    [
      { projectId: 'platform', brief: 'Cache the pricing lookup', agent: 'codex' },
      { projectId: 'bellbird', brief: 'Debounce cart recalculation' },
      { projectId: 'docs', brief: 'Document the pricing cache header', agent: 'opencode' },
    ],
    { name: 'Checkout latency', objective: 'Checkout takes four seconds for some customers since Tuesday: find out why and fix it.' },
  );
  const [pricing, cart, cacheDocs] = children as [typeof children[number], typeof children[number], typeof children[number]];
  await ws.attachWorktree(pricing.id, { path: wt('platform', 'pricing-cache'), branch: 'kestrel/pricing-cache' });
  await ws.attachWorktree(cart.id, { path: wt('bellbird', 'cart-debounce'), branch: 'kestrel/cart-debounce' });
  await ws.attachWorktree(cacheDocs.id, { path: wt('docs', 'pricing-cache-header'), branch: 'kestrel/pricing-cache-header' });
  await ws.setLandedIn(pricing.id, 'platform');
  await ws.setState(pricing.id, 'running', 'Adding a per-request cache');
  await ws.setDetail(pricing.id, {
    messages: talk('From “Checkout is slow in production”: cache the pricing lookup so it runs once per cart, not once per line.', 'The lookup is now cached per request and keyed by price list. I’m running the pricing suite.', { repo: true, files: 1 }),
    files: [diff('src/pricing/lookup.ts', [[' ', 'export async function priceFor(sku: string, list: string) {'], ['-', '  return db.prices.find({ sku, list });'], ['+', '  return requestCache.remember(`${list}:${sku}`, () =>'], ['+', '    db.prices.find({ sku, list }),'], ['+', '  );'], [' ', '}']], 11)],
    agentOutput: '$ pnpm test pricing\n\n✓ looks a price up once per request\n\nRunning 41 more…',
  });
  await ws.setLandedIn(cart.id, 'bellbird');
  await ws.setState(cart.id, 'attention', 'Waiting for your decision');
  await ws.setDetail(cart.id, {
    messages: talk('From “Checkout is slow in production”: stop the cart recalculating on every keystroke in the quantity field.', 'Recalculation is debounced. One choice is yours.', {
      repo: true,
      files: 1,
      question: { text: 'Debounce by 250 ms, or recalculate only when the field loses focus?', choices: ['250 ms debounce', 'On blur only'] },
    }),
    files: [diff('src/cart/useCartTotals.ts', [[' ', 'export function useCartTotals(lines: Line[]) {'], ['-', '  useEffect(() => { recalculate(lines); }, [lines]);'], ['+', '  const settled = useDebounced(lines, 250);'], ['+', '  useEffect(() => { recalculate(settled); }, [settled]);'], [' ', '}']], 8)],
    agentOutput: '$ pnpm test cart\n\n✓ recalculates once after rapid edits',
  });
  await ws.setState(cacheDocs.id, 'running', 'Reading the API reference');
  await ws.setDetail(cacheDocs.id, {
    messages: talk('From “Checkout is slow in production”: document the new pricing cache header once Platform has named it.', 'I’m reading the API reference to find where response headers are described. Nothing changed yet.', { repo: true, files: 0 }),
    agentOutput: 'Waiting on the header name from the Platform session.',
  });

  // ---- a handoff: started in the wrong repo, fix landed in another ------------------
  await add(
    { id: 'flicker', title: 'Search results flicker', agent: 'claude', project: 'bellbird', landed: false, state: 'running', note: 'Investigating' },
    {
      messages: talk('Search results flicker when I type quickly. Fix it.', 'The UI is rendering what it is given. The flicker comes from the index returning partially written documents, which is in Platform, so I handed this off there.', {
        repo: true,
        files: 0,
        extra: [{ icon: 'arrow-right', text: 'Handed off to Platform: Fix partial writes in the search index' }],
      }),
      output: '$ git status\n\nnothing to commit, working tree clean',
    },
  );
  const indexFix = await ws.handoff('flicker', { projectId: 'platform', summary: 'Fix partial writes in the search index' });
  await ws.attachWorktree(indexFix.id, { path: wt('platform', 'index-atomic-writes'), branch: 'kestrel/index-atomic-writes' });
  await ws.setLandedIn(indexFix.id, 'platform');
  await ws.setState(indexFix.id, 'done', '2 files changed · Tests passed');
  await ws.setDetail(indexFix.id, {
    messages: talk('Handed off from “Search results flicker” (Bellbird): the index returns partially written documents while a batch is in flight. Make batch writes atomic.', 'Batch writes now go to a staging segment and swap in when complete. The flicker no longer reproduces. Ready for review.', { repo: true, files: 2 }),
    files: [
      diff('src/index/writer.ts', [[' ', 'export async function writeBatch(docs: Doc[]) {'], ['-', '  for (const doc of docs) await segment.put(doc);'], ['+', '  const staging = await segment.stage();'], ['+', '  for (const doc of docs) await staging.put(doc);'], ['+', '  await segment.swap(staging);'], [' ', '}']], 30),
      diff('tests/index/writer.test.ts', [['+', 'it("never exposes a half-written batch", async () => {'], ['+', '  const read = readDuring(() => writeBatch(batch));'], ['+', '  expect(await read).toEqual(before);'], ['+', '});']]),
    ],
    agentOutput: '$ pnpm test index\n\nTest Files  3 passed (3)\n     Tests  19 passed (19)',
  });

  // ---- a branch name too long for the Details pane (cut in the middle there), a clean worktree and a cost --
  await add(
    { id: 'rereview', title: 'Re-review the lambda cleanup', agent: 'claude', project: 'platform', state: 'done', note: 'Review posted', branch: 'kestrel/please-re-review-this-pr-https-g-ab07f9cf' },
    { messages: talk('Please re-review this pull request after the latest push.', 'I re-read the whole diff against the earlier review. The two comments are addressed; nothing to change.', { repo: true, files: 0 }) },
  );
  await ws.setDetail('rereview', { usage: { costUsd: 11.36, turns: 5 } });

  // ---- a child dragged out of its folder: shows at the top level with a "from" mark --
  await ws.moveSession(cacheDocs.id, launch.id);
  void checkoutGroup;

  await linkSampleRequests(ws);
}

/**
 * Every seeded session's requests on its branch, linked in the state they are in (fake.ts), as the
 * first lookup would: so "Fix partial writes in the search index" reads Ready to review (open) and
 * "Keyboard shortcuts" Done (its newest is a draft) from the start; "Draft release notes" has none.
 */
async function linkSampleRequests(ws: Workspace): Promise<void> {
  for (const s of (await ws.state()).sessions) if (s.branch) await ws.recordRequests(s.id, sampleLinksOn(s.branch));
  // One request linked to two sessions, so the Pull requests page's de-duplication can be seen.
  await ws.recordRequests(SAMPLE_SHARED_SESSION, SAMPLE_SHARED_LINKS);
}
