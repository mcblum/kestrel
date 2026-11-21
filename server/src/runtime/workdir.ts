// Where a new session (or a child of handoff, delegate or spawn) works, decided after its row is
// stored. In a git project it gets its own worktree, whose branch is named from the session's
// title: the generated one when it comes within the wait (runtime/titling.ts), else the
// provisional one, or the user's if they renamed it meanwhile; a generated title that comes later
// renames the branch too, while that is safe (runtime/late-branch.ts). Anywhere else there is no branch,
// so nothing waits and the title comes in the background.
import type { HostKind } from '../shared/host-terms.ts';
import type { ProcessSystem } from './kill-task.ts';
import type { CommitSigningOptions } from '../commit-signing/prefs.ts';
import type { CrashReportsOptions } from '../crash-reports/prefs.ts';
import type { SettingStore } from '../suggestions/prefs.ts';
import type { CommandRunner } from '../pull-requests/types.ts';
import type { TitleProvider } from '../agents/title-providers.ts';
import type { BaseNotice, FetchRunner, FreshStart } from '../base-refresh.ts';
import type { ChildOrigin } from '../delegation.ts';
import { createWorktree, removeWorktree, type WorktreeStart } from '../git.ts';
import type { GitSettingsOptions } from '../git-settings/prefs.ts';
import type { KeepAwakeOptions } from '../keep-awake/hold.ts';
import type { RunScript } from '../project-scripts/run.ts';
import { DEFAULT_PREFIX } from '../shared/branch-prefix.ts';
import type { Agent, Attachment, Project, ProjectFolder, SessionSettings } from '../model.ts';
import type { BaseChoice } from '../shared/start-base.ts';
import type { Simulator } from '../simulator.ts';
import type { SuggestionOptions } from '../suggestions/index.ts';
import type { Workspace } from '../workspace.ts';
import { followTitle } from './late-branch.ts';
import type { Titler } from './titling.ts';

export interface RuntimeOptions {
  simulator?: Simulator;
  /** Who writes short session titles (agents/title-providers.ts); none by default. */
  titleProviders?: readonly TitleProvider[];
  /** The clock for the capped wait for a title; tests pass one. */
  titleWait?: (ms: number) => Promise<void>;
  /** Where the suggestions' rules are kept, and whether test-only kinds are offered (suggestions/index.ts). */
  suggestions?: SuggestionOptions;
  /** The clock turns are timed by, ms since 1970 (shared/turns.ts); tests pass one. */
  now?: () => number;
  /** Where Settings → Git is kept, and who gh is signed in as (git-settings/prefs.ts). */
  git?: GitSettingsOptions;
  /** Where "Keep each project's edits in its own session" is kept (project-edits/prefs.ts). */
  projectEdits?: { settings?: SettingStore };
  /** Where each project's remembered answer to where a new session starts is kept (start-base/prefs.ts). */
  startBase?: { settings?: SettingStore };
  /** Where "Commands kept per session" is kept (commands-kept/prefs.ts). */
  commandsKept?: { settings?: SettingStore };
  /** Where each project's setup and archive scripts are kept, and what runs them (project-scripts/). */
  projectScripts?: { settings?: SettingStore; run?: RunScript };
  /** Where Settings → Workflow → Keep awake is kept, and what holds the Mac awake (keep-awake/hold.ts). */
  keepAwake?: Pick<KeepAwakeOptions, 'settings' | 'hold' | 'power' | 'available'>;
  /** Where the model presets and the "Who does what" table are kept (who-does-what/prefs.ts). */
  whoDoesWhat?: { settings?: SettingStore };
  /** Adds a comment to a pull request, run in a worktree (pull-requests/create.ts); tests pass their own. */
  requestComment?: (cwd: string, number: number, body: string, host: HostKind) => Promise<void>;
  /** Where the cleanup policies are kept (cleanup/prefs.ts). */
  cleanup?: { settings?: SettingStore };
  /** Where Settings → Workflow → Notifications is kept (notifications/prefs.ts). */
  notifications?: { settings?: SettingStore };
  /** Where each project's base branch and remote are kept (git-defaults/prefs.ts). */
  gitDefaults?: { settings?: SettingStore };
  /** Where each project's saved actions are kept (saved-actions/prefs.ts). */
  savedActions?: { settings?: SettingStore };
  /** Where the environment settings are kept (project-env/prefs.ts). */
  projectEnv?: { settings?: SettingStore };
  /** Where the default "Open in" app is kept (open-in/prefs.ts). */
  openIn?: { settings?: SettingStore };
  /** Where the always-allowed list for commands outside the sandbox is kept (sandbox-allow/store.ts). */
  sandboxAllow?: { settings?: SettingStore };
  /** Runs the fetch of a base branch before a new worktree is cut (base-refresh.ts); tests pass one. */
  baseFetch?: FetchRunner;
  /** Where Settings → Workflow → Commit signing is kept, and how signing is detected (commit-signing/prefs.ts). */
  commitSigning?: CommitSigningOptions;
  crashReports?: CrashReportsOptions;
  /** Where Settings → Git → Review requests is kept (review-settings/prefs.ts). */
  reviewPrefs?: { settings?: SettingStore };
  /** How a review is posted to its host (review-requests/post.ts); tests pass their own, so they never call gh or glab. */
  reviewRunner?: CommandRunner;
  /** How a command's processes are found and ended when its agent cannot stop it (runtime/kill-task.ts); tests pass their own. */
  processes?: ProcessSystem;
}

/** What the runtime needs to bring up a session's agent once its row exists. */
export interface Launch {
  agent: Agent;
  project: Project | null;
  /** The project's directory it works in; null with no project, or a project with no directory yet. */
  source: ProjectFolder | null;
  /** Where to work when there is no repository: the plain folder, or scratch. */
  folder: string;
  prompt: string;
  /** Files attached to the first message, already stored with the session (attachments/store.ts). */
  attachments?: readonly Attachment[];
  title: string;
  generateTitle: boolean;
  settings: SessionSettings;
  /** Where its worktree starts when the checkout is not on the default branch (shared/start-base.ts); as today when absent. */
  base?: BaseChoice;
  origin?: ChildOrigin;
  /** The commit the worktree starts at and its base, given by the caller (a review); the project's HEAD or its latest base when absent. */
  start?: WorktreeStart;
  /** A working folder already made (a start the user stopped, then resumed by replying). */
  workdir?: Workdir;
}

export interface Workdir {
  directory: string;
  branch: string | null;
  base: string | null;
  /** The project's setup script has run here (or there was none): it is not run again. */
  setupDone?: boolean;
}

export interface WorkdirDeps {
  titler: Pick<Titler, 'begin' | 'decide' | 'whenTitled'>;
  workspace: Pick<Workspace, 'attachWorktree' | 'state' | 'setBranch'>;
  worktreesDir: string;
  createWorktree?: typeof createWorktree;
  /** The prefix a new branch gets, resolved from Settings → Git ('' for none); the default when absent. */
  branchPrefix?: () => Promise<string>;
  /** Where a new worktree starts: the latest base when Settings → Git asks for it (base-refresh.ts). From the checkout's HEAD when absent. */
  freshStart?: (repo: string) => Promise<FreshStart>;
  /** Tells the session what `freshStart` found (a newer base, or a fetch that failed). */
  notice?: (notice: BaseNotice) => void;
}

export interface WorkdirRequest {
  sessionId: string;
  agent: Agent;
  prompt: string;
  /** The session's title now (provisional, or given by the caller). */
  title: string;
  /** Ask for a generated title (false when the caller gave one). */
  generate: boolean;
  /** The repository to make a worktree in; null for a plain folder or no project. */
  repo: string | null;
  /** Where to work when there is no repository. */
  folder: string;
  /** Aborted when the user stops the session while it starts: no worktree is made after that. */
  signal?: AbortSignal;
}

/** Thrown when the start was abandoned (the user stopped the session) before anything was made. */
export class Abandoned extends Error {
  constructor() {
    super('Stopped before the agent started.');
  }
}

/** The session's working folder, with its worktree made and stored on the row when it has a repository. Throws if the worktree cannot be made. */
export async function prepareWorkdir(deps: WorkdirDeps, req: WorkdirRequest): Promise<Workdir> {
  const job = { sessionId: req.sessionId, provisional: req.title, prompt: req.prompt, agent: req.agent };
  if (!req.repo) {
    if (req.generate) deps.titler.begin(job);
    return { directory: req.folder, branch: null, base: null };
  }
  // The fetch runs while the title is awaited; it never throws.
  const fresh = deps.freshStart ? deps.freshStart(req.repo) : Promise.resolve<FreshStart>({ notice: null });
  const title = req.generate ? await deps.titler.decide(job, req.signal) : req.title;
  if (req.signal?.aborted) throw new Abandoned();
  const prefix = deps.branchPrefix ? await deps.branchPrefix() : DEFAULT_PREFIX;
  const { start, notice } = await fresh;
  if (req.signal?.aborted) throw new Abandoned();
  const worktree = await (deps.createWorktree ?? createWorktree)(req.repo, deps.worktreesDir, req.sessionId, title, prefix, start);
  try {
    await deps.workspace.attachWorktree(req.sessionId, worktree);
  } catch (error) {
    // The row is gone (deleted meanwhile): nothing would ever clean this worktree up.
    await removeWorktree(req.repo, worktree.path).catch(() => undefined);
    throw error;
  }
  if (notice) deps.notice?.(notice);
  // A title still coming names the branch when it comes (the agent starts meanwhile).
  const repo = req.repo;
  if (req.generate) deps.titler.whenTitled(req.sessionId, async () => void (await followTitle(deps, { sessionId: req.sessionId, repo, worktreePath: worktree.path, branch: worktree.branch, prefix })));
  return { directory: worktree.path, branch: worktree.branch, base: worktree.base };
}
