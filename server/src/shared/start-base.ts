// Where a new session's worktree starts when the project's checkout is not on its default branch
// (0.0.19, Matt, 2026-11-19). The New session box asks before the session exists: start from the
// latest default branch (the usual answer, offered first), or from the branch checked out now, as
// it is. The answer can be remembered per project (the project's Settings tab → General → New sessions start from).
// A session an agent starts (handoff, delegate, spawn) is never asked: it takes the project's
// remembered answer, else the default branch. Pure, shared with the UI.

export const BASE_CHOICES = ['default', 'current'] as const;
/** `default`: the latest default branch. `current`: the branch checked out now, at its current commit. */
export type BaseChoice = (typeof BASE_CHOICES)[number];

export const isBaseChoice = (value: unknown): value is BaseChoice => typeof value === 'string' && (BASE_CHOICES as readonly string[]).includes(value);

/** What the checkout is on, when that is not its default branch: what the question is about. */
export interface BaseQuestion {
  projectId: string;
  projectName: string;
  /** The branch checked out; null when HEAD is detached. */
  branch: string | null;
  /** The remote's default branch (origin/HEAD), else main or master. */
  defaultBranch: string;
  /** Commits on the checkout that the default branch does not have. */
  ahead: number;
  /** Commits on the default branch that the checkout does not have. */
  behind: number;
  /** Everything on the checkout is already in the default branch (its work was merged, or it has none). */
  contained: boolean;
  /** Changed files in the checkout; neither choice brings them into the new worktree. */
  uncommitted: number;
}

/** Each project's remembered answer, by project id. Projects not in it are asked. */
export type StartBasePrefs = Readonly<Record<string, BaseChoice>>;

/** What was stored, made safe: anything unreadable is dropped, so that project is asked again. */
export function sanitizeStartBasePrefs(raw: unknown): StartBasePrefs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([id, choice]) => id.length > 0 && isBaseChoice(choice)));
}

/** The base a session takes without asking: the one asked for, else the remembered one, else `fallback`. */
export const effectiveBase = (asked: BaseChoice | undefined, remembered: BaseChoice | undefined, fallback: BaseChoice): BaseChoice => asked ?? remembered ?? fallback;

const commits = (n: number): string => `${n} ${n === 1 ? 'commit' : 'commits'}`;
const files = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`;

/** The question in words: where the checkout is, then what each choice would leave out. */
export function describeBaseQuestion(q: BaseQuestion): { summary: string; notes: string[] } {
  const where = q.branch === null ? 'a detached commit' : q.branch;
  const notes: string[] = [];
  if (q.contained && q.behind > 0) notes.push(`Everything on it is already in ${q.defaultBranch}, which has ${commits(q.behind)} more.`);
  if (!q.contained && q.behind > 0) notes.push(`It is ${commits(q.behind)} behind ${q.defaultBranch}.`);
  if (q.ahead > 0) notes.push(`It has ${commits(q.ahead)} that ${q.defaultBranch} does not. Starting from ${q.defaultBranch} leaves them out.`);
  if (q.uncommitted > 0) notes.push(`${files(q.uncommitted)} changed in the checkout and not committed. Neither choice brings them into the new worktree.`);
  return { summary: `${q.projectName} is on ${where}, not ${q.defaultBranch}.`, notes };
}

/** The two choices as the dialog and Settings name them. */
export const BASE_CHOICE_LABEL = (choice: BaseChoice, q: Pick<BaseQuestion, 'branch' | 'defaultBranch'>): string =>
  choice === 'default' ? `Start from the latest ${q.defaultBranch}` : q.branch === null ? 'Start from the checked-out commit, as it is' : `Start from ${q.branch}, as it is`;
