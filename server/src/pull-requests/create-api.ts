// HTTP routes behind the New PR form, shaped like details-api.ts: the caller hands over the path
// parts and gets an answer, or null when the path is not one of these.
//
//   POST /api/sessions/:id/pr-prepare  { generated }                 → { title, body, base, draft, inherited }
//   POST /api/sessions/:id/pr-create   { title, body, base, draft }  → { url }
//
// The repository's origin picks the host (choose.ts): GitHub through gh, GitLab through glab, and the
// errors use that host's words. "Generated" is written with the session's own model (its stored
// settings), asked of its own agent. `inherited` counts the commits the request carries from the
// branch the session started on (create.ts). With sample data both answer from fake.ts (no gh, no git, no model);
// "create" adds a made-up pull request that the Details lookup then finds. One creation at a time per
// checkout: a second press while one is on its way is refused (409), so nothing is pushed or opened twice.
import type { GitDefaults } from '../shared/git-defaults.ts';
import { syncBranch } from '../branch-sync.ts';
import { originUrl } from '../git.ts';
import type { TitleProvider } from '../agents/title-providers.ts';
import { hostTerms } from '../shared/host-terms.ts';
import { folderOf } from '../shared/project-folders.ts';
import type { Session, SessionView } from '../model.ts';
import type { Workspace } from '../workspace.ts';
import { checkoutIn, type Checkout } from '../working-tree.ts';
import { requestSideOf, sessionFinder } from '../shared/working-tree.ts';
import { resolveProvider } from './choose.ts';
import { preparePR, publishPR, validatePRForm } from './create.ts';
import { samplePrefill, type SamplePullRequests } from './fake.ts';
import { ghFailureReason, githubCommands } from './github.ts';
import { gitlabCommands } from './gitlab.ts';
import { sharedGlabSignIn, type GlabSignInCheck } from './glab.ts';
import type { CommandRunner, HostCommands } from './types.ts';

export type CreateAnswer = { status: number; body: unknown };
type Read = () => Promise<Record<string, unknown>>;

export interface CreateDeps {
  /** The sample provider with fake data; null with a real store. */
  samples: SamplePullRequests | null;
  /** Who may write generated text (index.ts chooses them once, for titles too). */
  writers: readonly TitleProvider[];
  run?: CommandRunner;
  originOf?: (path: string) => Promise<string | null>;
  branchOf?: (workspace: Workspace, session: Pick<Session, 'id' | 'branch' | 'worktreePath'>) => Promise<string | null>;
  /** Whether glab is signed in to a host; the server's shared lookup when absent. */
  glabSignIn?: GlabSignInCheck;
  wait?: (ms: number) => Promise<void>;
  /** Told when the form created a request for a session: the user already chose about a review there. */
  onCreated?: (sessionId: string, autopilot: AutopilotChoice | null) => void;
  /** The project's Git defaults (git-defaults/prefs.ts): its base branch is the form's base. Automatic when absent. */
  gitDefaults?: (projectId: string | null) => Promise<GitDefaults>;
}

const ACTIONS = new Set(['pr-prepare', 'pr-create']);
const COMMANDS = { github: githubCommands, gitlab: gitlabCommands } as const;
const refused = (status: number, error: string): CreateAnswer => ({ status, body: { error } });

/** The answers with sample data: made-up text, and a made-up pull request. */
async function sampleAnswer(action: string, session: Session, branch: string | null, read: Read, samples: SamplePullRequests): Promise<CreateAnswer> {
  if (!branch) return refused(400, 'This session has no branch.');
  const body = await read();
  if (action === 'pr-prepare') return { status: 200, body: { ...samplePrefill(session.title, branch, body.generated === true), draft: false } };
  const pr = samples.create(branch, validatePRForm(body));
  return { status: 200, body: { url: pr.url } };
}

/** The checkout a session's request is made from (working-tree.ts `checkoutIn`): its host's worktree for a guest. */
async function checkoutOf(workspace: Workspace, session: SessionView): Promise<Checkout> {
  const state = await workspace.state();
  const project = state.projects.find((p) => p.id === session.startedIn);
  return checkoutIn(state, session, project ? folderOf(project, session.folderId) : null);
}

/** What the form's Autopilot switch and checkbox said; null when the form sent none (the settings decide). */
export interface AutopilotChoice {
  on: boolean;
  merge: boolean;
}

export function autopilotChoice(raw: unknown): AutopilotChoice | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return typeof r.on === 'boolean' ? { on: r.on, merge: r.merge === true } : null;
}

/** The route for one server: it keeps which checkouts are creating a pull request right now. */
export function createPRRoutes(deps: CreateDeps) {
  const publishing = new Set<string>();
  const originOf = deps.originOf ?? originUrl;
  const branchOf = deps.branchOf ?? syncBranch;
  const glabSignIn = deps.glabSignIn ?? sharedGlabSignIn;

  async function publish(cwd: string, branch: string, read: Read, commands: HostCommands): Promise<CreateAnswer> {
    const form = validatePRForm(await read());
    if (publishing.has(cwd)) return refused(409, `A ${hostTerms(commands.kind).long} is already being created for this checkout.`);
    publishing.add(cwd);
    try {
      return { status: 200, body: await publishPR(cwd, branch, form, { run: deps.run, commands }) };
    } finally {
      publishing.delete(cwd);
    }
  }

  async function answer(action: string, session: SessionView, readOnce: Read, workspace: Workspace): Promise<CreateAnswer> {
    // The body is read once: the form and the Autopilot choice both come from it.
    let body: Promise<Record<string, unknown>> | null = null;
    const read: Read = () => (body ??= readOnce());
    const checkout = await checkoutOf(workspace, session);
    if ('reason' in checkout) return refused(400, checkout.reason);
    const cwd = checkout.path;
    const choice = await resolveProvider(await originOf(cwd), glabSignIn);
    if (choice.kind === 'none') return refused(400, choice.reason);
    const commands = COMMANDS[choice.kind];
    try {
      // The branch the checkout is on now, recorded on the worktree's owner (branch-sync.ts).
      const branch = await branchOf(workspace, checkout.branch === null ? { id: session.id, branch: session.branch, worktreePath: null } : { id: checkout.ownerId, branch: checkout.branch, worktreePath: cwd });
      if (!branch) return refused(400, 'This checkout has no branch.');
      if (action === 'pr-create') {
        const created = await publish(cwd, branch, read, commands);
        if (created.status === 200) deps.onCreated?.(session.id, autopilotChoice((await read()).autopilot));
        return created;
      }
      const generated = (await read()).generated === true;
      const model = (await workspace.storedDetail(session.id))?.settings?.model || undefined;
      return { status: 200, body: await preparePR(cwd, branch, generated, { run: deps.run, commands, writers: deps.writers, agent: session.agent, model, wait: deps.wait, base: (await deps.gitDefaults?.(session.startedIn))?.baseBranch }) };
    } catch (error) {
      return refused(400, commands.failureReason(error));
    }
  }

  return async function createPRRoute(parts: readonly string[], method: string, read: Read, workspace: Workspace): Promise<CreateAnswer | null> {
    if (method !== 'POST' || parts.length !== 4 || parts[1] !== 'sessions' || !ACTIONS.has(parts[3]!)) return null;
    const action = parts[3]!;
    const state = await workspace.state();
    const session = state.sessions.find((s) => s.id === parts[2]);
    if (!session) return refused(404, 'No such session');
    try {
      if (deps.samples) return await sampleAnswer(action, session, requestSideOf(session, sessionFinder(state)).branch, read, deps.samples);
      return await answer(action, session, read, workspace);
    } catch (error) {
      return refused(400, ghFailureReason(error));
    }
  };
}
