// Kestrel server entry point.
import { fileURLToPath } from 'node:url';
import { notesSource } from './whats-new/notes.ts';
import { WhatsNew } from './whats-new/store.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { reviewingComments } from './review-requests/reviewing.ts';
import { join } from 'node:path';
import { claudeAdapter } from './agents/claude/index.ts';
import { codexAdapter } from './agents/codex/index.ts';
import { opencodeAdapter } from './agents/opencode/index.ts';
import { scriptedAdapter } from './agents/scripted.ts';
import { titleProviders } from './agents/title-providers.ts';
import { dataDir as resolveDataDir } from './data-dir.ts';
import { createKestrelServer } from './http.ts';
import { startConnect } from './connect/link/start.ts';
import { startCrashReporter } from './crash-reports/start.ts';
import { crashReportSetup } from './shared/crash-reports.ts';
import { detailsSources } from './details-api.ts';
import { syncPullRequests } from './pull-request-sync.ts';
import { originUrl } from './git.ts';
import { sharedGlabSignIn } from './pull-requests/glab.ts';
import { sampleReviewCount, sampleReviewRequests, sampleUnreadCount, storyReviewRequests } from './review-requests/fake.ts';
import { asReviewArrivals } from './review-requests/arrivals.ts';
import { githubReviewRequests } from './review-requests/github.ts';
import { gitlabReviewRequests } from './review-requests/gitlab.ts';
import { ReviewRequestStore } from './review-requests/store.ts';
import { REVIEW_CHECK_MS, syncReviewRequests } from './review-requests/sync.ts';
import { reviewStarter } from './review-requests/auto.ts';
import { asDismissedKeys, asReviewOrder, reviewSessionTitle } from './shared/review-requests.ts';
import { ready } from './shared/sourced.ts';
import { asClosedTickets, asStoredTickets, asTicketLinks, asTicketSettings } from './shared/tickets.ts';
import { TicketStore } from './tickets/store.ts';
import { syncTickets } from './tickets/sync.ts';
import { sessionTickets } from './tickets/session.ts';
import { ticketSources } from './tickets/sources/index.ts';
import { sampleSeenKeys, sampleTicketLinks } from './tickets/sources/fake.ts';
import { plainCredentials, sealedCredentials } from './tickets/credentials.ts';
import { PROTECTED_FILES } from './shared/protected-files.ts';
import { McpServerStore } from './mcp-servers/store.ts';
import { plainSecrets, sealedSecrets } from './mcp-servers/secrets.ts';
import { JiraConnection, SAMPLE_TRACKERS_REASON } from './tickets/jira-connection.ts';
import { LinearConnection } from './tickets/linear-connection.ts';
import { readVaultKey } from './connect/link/vault.ts';
import { SHUTDOWN_DEADLINE_MS, timedSteps } from './shared/shutdown.ts';
import { SessionRuntime } from './runtime.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { sqlitePersistence } from './persistence/sqlite.ts';
import type { Persistence } from './persistence/types.ts';
import { sampleBackgroundTasks, sampleCommands, seedFakeWorkspace } from './seed.ts';
import { makeDemoProjects, makeStoryProjects, seedDemoExtras } from './seed-demo.ts';
import { seedStory } from './seed-story.ts';
import { seedSidebar } from './seed-sidebar.ts';
import { LOOPBACK_HOST, newLaunchToken, sessionToken } from './security.ts';
import { mcpUrl } from './kestrel-mcp.ts';
import { Workspace } from './workspace.ts';
import { githubLoginLookup, sampleUsername } from './git-settings/github-login.ts';

// Outside any repository, so worktrees never sit inside another project's tree.
const dataDir = resolveDataDir();
const port = Number(process.env.KESTREL_PORT ?? 4317);
const uiOrigins = (process.env.KESTREL_UI_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((s) => s.trim());
// KESTREL_DEMO=1 (`pnpm demo`) is the demo workspace: fake data with the rest of the app filled in
// and the scripted agent, in a store of its own (seed-demo.ts).
const demo = process.env.KESTREL_DEMO === '1';
// KESTREL_DEMO_SCENE=story (`pnpm demo --story`) is the demo cut down to one moment: one task across
// three projects, one question waiting, nothing else asking for the eye (seed-story.ts).
// KESTREL_DEMO_SCENE=story-reviews is the same moment with two review requests waiting in CODE REVIEWS.
// KESTREL_DEMO_SCENE=tickets (`pnpm demo --tickets`) is the demo in a store of its own, for showing
// tickets: the sample tracker's sprint (tickets/sources/fake.ts), which every fake run but the story
// and sidebar scenes lists once tickets are turned on. This scene starts with them on.
const sidebarDemo = demo && process.env.KESTREL_DEMO_SCENE === 'sidebar';
const storyReviews = demo && process.env.KESTREL_DEMO_SCENE === 'story-reviews';
const story = storyReviews || (demo && process.env.KESTREL_DEMO_SCENE === 'story');
const ticketsDemo = demo && process.env.KESTREL_DEMO_SCENE === 'tickets';
// KESTREL_FAKE=1 opens the separate seeded fake store. Real sessions work in both.
const fake = demo || process.env.KESTREL_FAKE === '1';

mkdirSync(dataDir, { recursive: true });

// The one place a provider is chosen. Everything else sees only `Persistence`.
function openPersistence(): Persistence {
  if (process.env.KESTREL_PERSISTENCE === 'memory') return memoryPersistence();
  return sqlitePersistence(join(dataDir, demo ? 'kestrel-demo.sqlite' : fake ? 'kestrel-fake.sqlite' : 'kestrel.sqlite'));
}

const db = openPersistence();
const workspace = new Workspace(db);
const seeded = fake && (await db.isEmpty());
if (seeded && sidebarDemo) await seedSidebar(db, dataDir);
else if (seeded && story) await seedStory(workspace, makeStoryProjects(dataDir));
else if (seeded) await seedFakeWorkspace(workspace, demo ? makeDemoProjects(dataDir) : {});
// KESTREL_SCRIPTED_AGENT=1 (with fake data only) puts a scripted stand-in behind "Claude", for
// trying the UI by hand: turns that last, approvals, failures (agents/scripted.ts).
const scripted = demo || (fake && process.env.KESTREL_SCRIPTED_AGENT === '1');
// Titles come from the real CLIs (Claude, then Codex), the scripted stand-in, or, with fake data
// alone, nobody: no real calls.
const titles = titleProviders(scripted ? 'scripted' : fake ? 'none' : 'real');
// Tag rules and Settings → Git live in the store's settings; with fake data a sample GitHub login stands in for gh. The test-only `note` suggestion kind is offered to the scripted stand-in alone.
// Codex is the user's own `codex app-server` (agents/codex/), OpenCode the user's own `opencode serve`
// (agents/opencode/); the scripted stand-in replaces Claude only.
// The app's key for the sealed store, read once from its private pipe (connect/link/vault.ts).
const vaultKey = readVaultKey();
// Kestrel's own MCP servers: definitions in the database, secret values sealed like the tracker keys (mcp-servers/).
const mcpServers = new McpServerStore(db, vaultKey ? sealedSecrets(join(dataDir, PROTECTED_FILES.mcpSealed), vaultKey) : plainSecrets(join(dataDir, PROTECTED_FILES.mcpPlain)));
const runtime = new SessionRuntime(workspace, scripted ? { claude: scriptedAdapter() } : { claude: claudeAdapter(), codex: codexAdapter(), opencode: opencodeAdapter() }, dataDir, { titleProviders: titles, suggestions: { settings: db, testKinds: scripted }, git: { settings: db, username: fake ? sampleUsername : undefined }, projectEdits: { settings: db }, remoteStarts: { settings: db }, startBase: { settings: db }, projectScripts: { settings: db }, projectEnv: { settings: db }, mcpServers, savedActions: { settings: db }, gitDefaults: { settings: db }, notifications: { settings: db }, cleanup: { settings: db }, whoDoesWhat: { settings: db }, keepAwake: { settings: db }, commandsKept: { settings: db }, openIn: { settings: db }, sandboxAllow: { settings: db }, commitSigning: { settings: db }, crashReports: { settings: db }, reviewPrefs: { settings: db }, colours: { settings: db }, reviewing: fake ? null : reviewingComments(), ...(fake ? { reviewRunner: async () => ({ stdout: '' }) } : {}) });
if (demo && seeded && !story && !sidebarDemo) await seedDemoExtras(workspace, runtime.savedActions);
// SAMPLE: with fake data, one running session shows background work left running (seed.ts).
if (fake && !story && !sidebarDemo) {
  const sample = sampleBackgroundTasks(Date.now());
  runtime.background.showSample(sample.sessionId, sample.tasks);
  const commands = sampleCommands(Date.now());
  runtime.commands.showSample(commands.sessionId, commands.commands, commands.outputs);
}
const interrupted = await runtime.recoverAfterRestart();
// Worktree folders removed by hand since the last run: their sessions say so, then their
// repositories forget them. Not waited for.
void runtime.markLostWorktrees().then(() => runtime.pruneWorktrees()).catch((error) => console.error('[kestrel] worktree check failed', error));
// Files attached in a composer and never sent: no window from before this start can send them.
runtime.attachments.cleanDrafts();
if (interrupted > 0) console.log(`[kestrel] ${interrupted} running session(s) marked interrupted after restart`);

// The Electron shell makes the token itself and passes it in; otherwise the server makes one.
const suppliedToken = process.env.KESTREL_TOKEN;
if (suppliedToken !== undefined && suppliedToken.length < 32) throw new Error('KESTREL_TOKEN must be at least 32 characters.');
const token = suppliedToken ?? newLaunchToken();
// An out-of-process agent (Codex) reaches its session's Kestrel tools here, with a token for that session only.
runtime.setMcpAccess((sessionId) => ({ url: mcpUrl(port, sessionId), token: sessionToken(token, sessionId) }));
// With fake data, the Details pane's pull requests are sample data (pull-requests/fake.ts). A
// generated pull request's text comes from the same providers as titles.
const details = detailsSources(fake);
// The order the user dragged the CODE REVIEWS rows into is kept with the app's settings.
const REVIEW_ORDER_KEY = 'review-order';
const storedReviewOrder = await db.getSetting(REVIEW_ORDER_KEY).then((raw) => (raw ? asReviewOrder(JSON.parse(raw)) : null)).catch(() => null);
// So are the requests the user dismissed, by key.
const REVIEW_DISMISSED_KEY = 'review-dismissed';
const storedDismissed = await db.getSetting(REVIEW_DISMISSED_KEY).then((raw) => (raw ? asDismissedKeys(JSON.parse(raw)) : [])).catch(() => []);
// And the ones they have looked at: a waiting request not among them is new.
const REVIEW_SEEN_KEY = 'review-seen';
const storedSeen = await db.getSetting(REVIEW_SEEN_KEY).then((raw) => (raw ? asDismissedKeys(JSON.parse(raw)) : [])).catch(() => []);
// And which requests have been listed, and which were read because they arrived already approved.
const REVIEW_ARRIVALS_KEY = 'review-arrivals';
const storedArrivals = await db.getSetting(REVIEW_ARRIVALS_KEY).then((raw) => (raw ? asReviewArrivals(JSON.parse(raw)) : null)).catch(() => null);
const reviewRequests = new ReviewRequestStore({
  arrivals: storedArrivals,
  saveArrivals: (arrivals) => void db.putSetting(REVIEW_ARRIVALS_KEY, JSON.stringify(arrivals)).catch((error: unknown) => console.error('[kestrel] could not store the listed reviews', error)),
  seen: storedSeen,
  saveSeen: (keys) => void db.putSetting(REVIEW_SEEN_KEY, JSON.stringify(keys)).catch((error: unknown) => console.error('[kestrel] could not store the read reviews', error)),
  dismissed: storedDismissed,
  saveDismissed: (keys) => void db.putSetting(REVIEW_DISMISSED_KEY, JSON.stringify(keys)).catch((error: unknown) => console.error('[kestrel] could not store the dismissed reviews', error)),
  order: storedReviewOrder ?? [],
  saveOrder: (order) => void db.putSetting(REVIEW_ORDER_KEY, JSON.stringify(order)).catch((error: unknown) => console.error('[kestrel] could not store the review order', error)),
});
// Settings → Git → Review requests: off, listed, or started on their own, and in which projects.
const reviewPrefs = runtime.reviewPrefs;
let reviewSettings = await reviewPrefs.current();
// Kestrel's own failures are reported from the installed app only, never with fake data, and only
// while Settings → General → Crash reports is on (crash-reports/). KESTREL_CRASH_DSN is a test
// address; KESTREL_TEST_CRASH_REPORT=1 sends one report at launch to check the path.
const crashReporting = fake ? null : crashReportSetup({ packaged: process.env.KESTREL_PACKAGED === '1', version: process.env.KESTREL_APP_VERSION || checkoutVersion(), dsnOverride: process.env.KESTREL_CRASH_DSN });
if (crashReporting) {
  await runtime.crashReports.prefs();
  try {
    const reporter = await startCrashReporter(crashReporting, () => runtime.crashReports.current().enabled);
    if (process.env.KESTREL_TEST_CRASH_REPORT === '1') console.log(`[kestrel] test crash report ${(await reporter.sendTest()) ? 'sent' : 'not sent'}`);
  } catch (error) {
    console.error(`[kestrel] crash reports could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
}
// The user's tickets (tickets/): dismissed and read keys and the links to the work on them are kept
// with the app's settings, through the persistence facade. With fake data the scripted sample
// tracker stands in (tickets/sources/fake.ts); the story and sidebar scenes have none.
const storedKeys = async (key: string): Promise<string[]> => db.getSetting(key).then((raw) => (raw ? asDismissedKeys(JSON.parse(raw)) : [])).catch(() => []);
const keepSetting = (key: string, what: string) => (value: unknown) => void db.putSetting(key, JSON.stringify(value)).catch((error: unknown) => console.error(`[kestrel] could not store ${what}`, error));
const tickets = new TicketStore({
  dismissed: await storedKeys('ticket-dismissed'),
  saveDismissed: keepSetting('ticket-dismissed', 'the dismissed tickets'),
  // A fresh data directory on the sample tracker starts with a couple of tickets new, not all of them.
  seen: (await db.getSetting('ticket-seen').catch(() => null)) === null && fake ? sampleSeenKeys() : await storedKeys('ticket-seen'),
  saveSeen: keepSetting('ticket-seen', 'the read tickets'),
  // The tickets demo starts with one ticket under way, so the Tickets page shows the group.
  links: await db.getSetting('ticket-links').then(async (raw) => (raw ? asTicketLinks(JSON.parse(raw)) : ticketsDemo ? sampleTicketLinks(Date.now(), (await workspace.state()).workstreams) : [])).catch(() => []),
  saveLinks: keepSetting('ticket-links', 'the tickets attached to work'),
  // Settings → Tickets: off until the user turns it on; the tickets demo starts with it on.
  settings: await db.getSetting('ticket-settings').then((raw) => (raw ? asTicketSettings(JSON.parse(raw)) : asTicketSettings({ on: ticketsDemo }))).catch(() => asTicketSettings(null)),
  saveSettings: keepSetting('ticket-settings', 'the tickets setting'),
  // The last list of every source, so a ticket that closes while Kestrel is not running is still found, and the closed ones.
  held: await db.getSetting('ticket-held').then((raw) => (raw ? asStoredTickets(JSON.parse(raw)) : [])).catch(() => []),
  saveHeld: keepSetting('ticket-held', 'the tickets last listed'),
  closed: await db.getSetting('ticket-closed').then((raw) => (raw ? asClosedTickets(JSON.parse(raw)) : [])).catch(() => []),
  saveClosed: keepSetting('ticket-closed', 'the closed tickets'),
});
// Jira Cloud's site, email and token are kept sealed under the app's key, as Connect's sign-in is.
const credentials = vaultKey ? sealedCredentials(join(dataDir, PROTECTED_FILES.trackersSealed), vaultKey) : plainCredentials(join(dataDir, PROTECTED_FILES.trackersPlain));
let checkTickets: () => void = () => undefined;
const jira = new JiraConnection(credentials, { unavailable: fake ? SAMPLE_TRACKERS_REASON : null, changed: () => checkTickets() });
const linear = new LinearConnection(credentials, { unavailable: fake ? SAMPLE_TRACKERS_REASON : null, changed: () => checkTickets() });
const sourcesOfTickets = ticketSources({ fake, workspace, originOf: originUrl, glabSignIn: sharedGlabSignIn, githubLogin: githubLoginLookup(), jira: () => jira.ticketSource(), linear: () => linear.ticketSource() });
const noTicketSources = story || sidebarDemo;
// The sync is made before the server, which hands its routes to it, and asks only while a window is connected.
let watchedNow: () => boolean = () => false;
const ticketSync = syncTickets(async () => (noTicketSources ? [] : sourcesOfTickets.list()), tickets, () => watchedNow());
const ticketWork = {
  projects: async () => (await workspace.state()).projects,
  sessions: async () => (await workspace.state()).sessions,
  workstreams: async () => (await workspace.state()).workstreams,
  originOf: originUrl,
  start: (req: Parameters<typeof runtime.start>[0]) => runtime.start(req),
  tag: (id: string, tag: string) => workspace.tagSession(id, tag),
  started: (id: string) => void runtime.proposeTicketStarted(id).catch((error: unknown) => console.error('[kestrel] could not propose the ticket’s move', error)),
};
// A session's ticket, for the `ticket` suggestion and the ticket tools (tickets/session.ts).
runtime.useTickets(
  sessionTickets({
    store: tickets,
    sync: ticketSync,
    workstreams: async () => (await workspace.state()).workstreams,
    liveSessions: async () => new Set((await workspace.state()).sessions.map((s) => s.id)), // archived ones are not listed,
    tag: (id, tag) => workspace.tagSession(id, tag),
    untag: (id, tag) => workspace.untagSession(id, tag),
  }),
);
// The Tickets routes, for the window and a phone of the account alike (tickets/api.ts).
const ticketsApi = { store: tickets, sync: ticketSync, work: ticketWork, jira, linear, sources: () => sourcesOfTickets.status() };
// Kestrel Connect (connect/link/): signed in and switched on in Settings, it links to the relay.
const connect = await startConnect({ dataDir, settings: db, fake, workspace, runtime, reviewRequests, tickets, ticketsApi, pullRequests: details.store, vaultKey });
// What's new: the notes shipped with this copy (the repository's whats-new/ from a checkout; the shell
// names the installed app's copy), and the record of what was shown. Only the installed app opens
// them by itself; KESTREL_WHATS_NEW_AS_INSTALLED=1 lets a checkout behave as one, to try it.
/** A checkout's version, from app/package.json, so the dev page knows its release too. */
function checkoutVersion(): string {
  try {
    return String(JSON.parse(readFileSync(new URL('../../app/package.json', import.meta.url), 'utf8')).version ?? '');
  } catch {
    return '';
  }
}
const whatsNewNotes = notesSource(process.env.KESTREL_WHATS_NEW_DIR || fileURLToPath(new URL('../../whats-new', import.meta.url)));
const whatsNew = { notes: whatsNewNotes, store: new WhatsNew({ settings: db, notes: whatsNewNotes, version: process.env.KESTREL_APP_VERSION || checkoutVersion(), packaged: process.env.KESTREL_PACKAGED === '1' || process.env.KESTREL_WHATS_NEW_AS_INSTALLED === '1' }) };
await whatsNew.store.view().catch((error: unknown) => console.error('[kestrel] could not read what is new', error));
const app = createKestrelServer(workspace, { token, allowedOrigins: uiOrigins, port }, runtime, { details: { sources: details, sample: fake }, writers: titles, reviewRequests, tickets: ticketsApi, crashReporting, connect, whatsNew });
watchedNow = () => app.watched();
checkTickets = () => void ticketSync.check();
await app.listen();
// The one copy of every session's pull requests, kept current and pushed to every window.
// Autopilot keeps it current with no window open too: it acts on what the store sees.
const pullRequestSync = syncPullRequests(workspace, details, fake, () => app.watched() || (runtime.autopilot?.anyOn() ?? false), (sessionId) => app.watching(sessionId));
// The cards about a pull request that needs the user, from the same store (suggestions/request-kind.ts).
runtime.watchRequestAttention(details.store, fake);
// The requests the user was asked to review, asked of each host the projects are on and pushed.
// With fake data they are samples, and no host is asked.
const seedSampleReviews = async (): Promise<void> => {
  if (story) {
    if (storyReviews) reviewRequests.set('github.com', ready(storyReviewRequests(Date.now())));
    return;
  }
  const state = await workspace.state();
  // KESTREL_SAMPLE_REVIEWS=300 seeds that many, to see a long list.
  const samples = sampleReviewRequests(state.projects.map((p) => p.id), Date.now(), sampleReviewCount(process.env.KESTREL_SAMPLE_REVIEWS));
  reviewRequests.set('github.com', ready(samples));
  if (sidebarDemo) return;
  // SAMPLE: the second request has a review session, so CODE REVIEWS shows both kinds of row.
  const reviewed = samples[1];
  if (reviewed?.projectId && !state.sessions.some((s) => s.review?.key === reviewed.key)) {
    await workspace.addSession({ title: reviewSessionTitle(reviewed.title), agent: 'claude', startedIn: reviewed.projectId, state: 'done', note: 'Finished', review: { key: reviewed.key, host: reviewed.host, number: reviewed.number, sha: '4f9c2ab81d3e5f60718293a4b5c6d7e8f9a0b1c2', url: reviewed.url } });
  }
  // SAMPLE: a request with a review is read, as one whose review was started is; the rest are new.
  reviewRequests.markSeen([reviewed, scripted ? samples[2] : undefined].flatMap((r) => (r ? [r.key] : [])), true);
  // KESTREL_SAMPLE_UNREAD=10 leaves that many new, the most recent ones, and marks the rest read.
  const unread = sampleUnreadCount(process.env.KESTREL_SAMPLE_UNREAD);
  if (unread !== null) {
    reviewRequests.markSeen(samples.slice(0, unread).map((r) => r.key), false);
    reviewRequests.markSeen(samples.slice(unread).map((r) => r.key), true);
  }
  // SAMPLE: with the scripted agent the third request has a review that really ran (a scripted turn
  // that hands over a sample review), so the review card can be seen. It has no project or worktree.
  const scriptedReview = samples[2];
  if (scripted && scriptedReview && !state.sessions.some((s) => s.review?.key === scriptedReview.key)) {
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: '/review', title: reviewSessionTitle(scriptedReview.title), review: { key: scriptedReview.key, host: scriptedReview.host, number: scriptedReview.number, sha: '9ab3c1d27e4f5a60b1c2d3e4f5a6b7c8d9e0f1a2', url: scriptedReview.url } });
    // SAMPLE: as if its approval had been posted (it has no worktree to post from), so the offer to archive it can be seen when its turn ends.
    await runtime.approvalPosted(session.id, `#${scriptedReview.number}`);
  }
};
if (fake && reviewSettings.mode !== 'off') await seedSampleReviews();
const reviewRequestSync = fake ? null : syncReviewRequests(workspace, { github: githubReviewRequests(), gitlab: gitlabReviewRequests(), glabSignIn: sharedGlabSignIn, originOf: originUrl }, reviewRequests, () => app.watched() && reviewSettings.mode !== 'off');
// Reviews that start on their own: whenever the list changes, and every few seconds, since a
// review that finishes frees a place for one that waited.
runtime.useReviewDismissed((key) => reviewRequests.isDismissed(key));
// Archived review sessions count: a request whose review was archived after an approval is not started again.
const reviewStarts = reviewStarter({ settings: () => reviewPrefs.current(), sessions: async () => { const state = await workspace.state(); return [...state.sessions, ...state.archived.sessions]; }, start: (request) => runtime.startReview(request, { automatic: true }) }, reviewRequests);
reviewRequests.onChange(() => void reviewStarts.run());
const reviewStartTimer = setInterval(() => void reviewStarts.run(), REVIEW_CHECK_MS);
reviewPrefs.onChange((next) => {
  reviewSettings = next;
  reviewRequests.clearNotes(); // a start that was refused may be tried again under the new setting
  if (next.mode === 'off') reviewRequests.keep([]);
  else if (fake) void seedSampleReviews();
  else void reviewRequestSync?.check();
  void reviewStarts.run();
});

// Stands in for the Electron shell handing the token to the UI: the Vite dev server reads this
// file (owner-only) and injects it into the page it serves. It is rewritten on every launch.
// (The Electron shell hands the token over directly and sets KESTREL_NO_LAUNCH_FILE.)
if (process.env.KESTREL_NO_LAUNCH_FILE !== '1') writeFileSync(join(dataDir, 'launch.json'), JSON.stringify({ port, token }), { mode: 0o600 });

console.log(`[kestrel] server on http://${LOOPBACK_HOST}:${port} (loopback only) · ${fake ? (scripted ? 'fake data, scripted agent' : 'fake data') : 'real store'} · UI origins: ${uiOrigins.join(', ')}`);

// Stopping is asked for twice by the shell (it closes the pipe and sends SIGTERM): it runs once.
// Each step is timed into the log, and the whole thing has a deadline, so a quit is never held up
// by one agent or one connection that will not let go.
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref();
  const took = await timedSteps([
    ['agents', () => runtime.shutdown()],
    ['pull requests', async () => pullRequestSync.stop()],
    ['review requests', async () => {
      reviewRequestSync?.stop();
      clearInterval(reviewStartTimer);
    }],
    ['tickets', async () => ticketSync.stop()],
    ['connect', () => connect.close()],
    ['http', () => app.close()],
    ['store', () => db.close()],
  ]);
  console.log(`[kestrel] stopped (${took})`);
  process.exit(0);
};
process.on('SIGINT', shutdown);
// A shell that started this process over a pipe stops it by closing that pipe, even if it crashes.
if (process.env.KESTREL_EXIT_ON_STDIN_CLOSE === '1') {
  process.stdin.resume();
  process.stdin.on('end', shutdown);
}
process.on('SIGTERM', shutdown);
