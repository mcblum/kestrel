// A session that works in another session's worktree (0.0.20, matt/kestrel#25 and #26): the
// design agent making its part where the work was asked, the builder carrying on there, a reviewer
// reading it. Matt, 2026-11-20: "one worktree, one writer at a time". The guest is a delegate
// child of the session whose worktree it is (its host); it has no worktree of its own. One session
// writes at a time: the host while no writing guest is at work, a writing guest while it is; a
// reviewer never writes. Pure and browser-safe: the rule and the words.
import type { Role } from './who-does-what.ts';
import { ROLE_LABEL } from './who-does-what.ts';

export interface Guest {
  /** The session whose worktree it works in. */
  hostId: string;
  role: Role;
  /** Design and Build change files; Review only reads. */
  writes: boolean;
}

export const guestWrites = (role: Role): boolean => role !== 'review';

export function sanitizeGuest(value: unknown): Guest | null {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (typeof v.hostId !== 'string' || !v.hostId || (v.role !== 'design' && v.role !== 'build' && v.role !== 'review')) return null;
  return { hostId: v.hostId, role: v.role, writes: guestWrites(v.role) };
}

/** Why a guest may not change a file in its host's worktree, or null when it may. */
export function guestEditRefusal(guest: Guest, path: string): string | null {
  if (guest.writes) return null;
  return `${path} was not changed: you are reviewing this work, and a reviewer does not change files. Say in your findings what should change and why; the session that wrote it makes the change.`;
}

/** What the host is told when it tries to change its own worktree while a guest is writing there. */
export function hostEditRefusal(path: string, guest: { title: string; id: string; role: Role }): string {
  return `${path} was not changed: "${guest.title}" (${guest.id}) is doing the ${ROLE_LABEL[guest.role]} part in this worktree now, and one session writes here at a time. You are told when it hands back; make your change then. To stop it, tell the user.`;
}

/** Why another writing guest cannot start in a worktree now, or null when it can. */
export function writerRefusal(busy: { title: string; role: Role } | null, startingWriters: number): string | null {
  if (startingWriters > 1) return 'One session writes in a worktree at a time: start one role here, and the next after it hands back.';
  return busy && startingWriters > 0 ? `"${busy.title}" is doing the ${ROLE_LABEL[busy.role]} part in this worktree now, and one session writes here at a time. Start the next part after it hands back.` : null;
}

/** What a guest is told about where it is, before its brief. */
export function guestIntro(role: Role, hostTitle: string): string {
  if (role === 'review') return `You are reviewing the work of the session "${hostTitle}", in its worktree. You can read everything here and run its tests, and you change no file.`;
  return `You are doing the ${ROLE_LABEL[role]} part of the task of the session "${hostTitle}", in its worktree, while it waits: your changes are made here, in its branch, and it carries on from them. Do exactly your part and nothing more, do not commit unless the brief asks, and end by saying what you made and what is left for the rest of the task.`;
}

/** What the host is told when a writing guest hands back: Kestrel's routing of what is left. */
export function handBackText(guest: { title: string; id: string; role: Role; runner: string }, said: string, buildRunner: string | null, delegateTool: string): string {
  const next =
    guest.role === 'design'
      ? buildRunner
        ? `If something is left to build, the user has given Build work to ${buildRunner}: call ${delegateTool} with a task for what is left, role "build", saying what ${guest.runner} made and where; it carries on in this same worktree. If nothing is left, tell the user what was done.`
        : 'If something is left to build, carry on with it yourself now, from what was made: do not redo or restyle that part. If nothing is left, tell the user what was done.'
      : 'Check that the whole task is now done, finish anything left yourself, and tell the user what was done.';
  return `[Kestrel] ${guest.runner} finished the ${ROLE_LABEL[guest.role]} part ("${guest.title}", ${guest.id}) in your worktree: its changes are here, in your branch; see them with git status and git diff.${said ? ` Its last message: ${said}` : ''} ${next}`;
}

// ---- review ----------------------------------------------------------------------------------

export const REVIEW_ROUNDS = 2;

/** Where a review of a session's work stands. Kept with the session whose work it is. */
export interface Review {
  reviewerId: string;
  /** Who reviews, in words ("Astra (Codex · …)"). */
  reviewer: string;
  /** The round the reviewer is on, or last finished: 1 is its first look. */
  round: number;
  rounds: number;
  /** `reviewing`: the reviewer is at work. `answering`: the author is acting on its findings. `done`: over. */
  status: 'reviewing' | 'answering' | 'done';
  /** Post how it ended to the session's pull request as a comment (chosen with "Open PR and start review", or from the card after an agent opened one). */
  comment?: boolean;
  /** How it ended, once it has: the reviewer's last verdict. */
  verdict?: 'clean' | 'findings';
  /** The reviewer's last findings, clipped: what a pull request's description can carry. */
  summary?: string;
}

export function sanitizeReview(value: unknown): Review | null {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (typeof v.reviewerId !== 'string' || typeof v.round !== 'number') return null;
  const status = v.status === 'answering' || v.status === 'done' ? v.status : 'reviewing';
  return { reviewerId: v.reviewerId, reviewer: typeof v.reviewer === 'string' ? v.reviewer : 'The reviewer', round: v.round, rounds: typeof v.rounds === 'number' ? v.rounds : REVIEW_ROUNDS, status, ...(v.verdict === 'clean' || v.verdict === 'findings' ? { verdict: v.verdict } : {}), ...(typeof v.summary === 'string' ? { summary: v.summary } : {}), ...(v.comment === true ? { comment: true } : {}) };
}

const VERDICT_CLEAN = 'VERDICT: NOTHING TO FIX';
const VERDICT_FINDINGS = 'VERDICT: FIX FIRST';

/** The reviewer's brief: adversarial, concrete, ending in one of two lines Kestrel reads. */
export function reviewBrief(base: string | null): string {
  const range = base ? `Everything since the commit ${base} is the work under review: \`git diff ${base}\` shows it, uncommitted changes included, and \`git log ${base}..HEAD\` its commits.` : 'The work under review is what this branch changes: use `git status`, `git diff` and `git log` to see it.';
  return [
    'Review this work as a sceptical second engineer from another team would, before it becomes a pull request. Your job is to find what is wrong with it, not to approve it.',
    range,
    'Read the changed code and the code around it. Run the tests and the type checker if the project has them. Look for: bugs and wrong behaviour, cases not handled, things the change breaks elsewhere, tests that do not test what they claim, security and data-loss risks, and anything the change says it does but does not.',
    'Report findings as a numbered list, most serious first. For each: the file and line, what is wrong, why it matters, and what would fix it. Leave out style preferences and praise. If you checked something and it holds, do not list it.',
    `End with exactly one of these two lines, alone: "${VERDICT_FINDINGS}" when anything must change before this is merged, or "${VERDICT_CLEAN}" when nothing must.`,
  ].join('\n\n');
}

/** What the reviewer's last message concluded; findings unless it plainly said there is nothing to fix. */
export const verdictOf = (said: string): 'clean' | 'findings' => (said.toUpperCase().includes(VERDICT_CLEAN) && !said.toUpperCase().includes(VERDICT_FINDINGS) ? 'clean' : 'findings');

/** What the author is told after a round with findings. */
export function findingsText(review: Pick<Review, 'reviewer' | 'round' | 'rounds'>, said: string): string {
  const after = review.round < review.rounds ? `When your turn ends, ${review.reviewer} looks again (round ${review.round + 1} of ${review.rounds}).` : 'This was the last round: the user decides from here.';
  return `[Kestrel] ${review.reviewer} reviewed your work (round ${review.round} of ${review.rounds}) and found things to fix. Its findings: ${said}\n\nFor each finding: fix it if it is right, and if you disagree say so and why, briefly. Do not argue style. Then say what you changed. ${after}`;
}

/** What the reviewer is asked for the next round. */
export function nextRoundText(review: Pick<Review, 'round' | 'rounds'>, authorSaid: string): string {
  return `[Kestrel] The author acted on your findings.${authorSaid ? ` It says: ${authorSaid}` : ''}\n\nLook again (round ${review.round} of ${review.rounds}): check each finding was really fixed, weigh any disagreement on its merits, and look for anything the fixes broke. Report only what still must change, in the same form, and end with the same verdict line.`;
}

/** The line the user sees in the author's conversation when the review is over. */
export function reviewEndNotice(review: Pick<Review, 'reviewer' | 'round' | 'verdict'>): string {
  const rounds = review.round === 1 ? '1 round' : `${review.round} rounds`;
  return review.verdict === 'clean'
    ? `${review.reviewer} reviewed this work (${rounds}) and found nothing that must change before it is merged.`
    : `${review.reviewer} reviewed this work (${rounds}) and still has findings. They are a warning, not a block: read them in its conversation and decide.`;
}

const SUMMARY_MAX = 1500;
export const clipSummary = (said: string): string => (said.length > SUMMARY_MAX ? `${said.slice(0, SUMMARY_MAX - 1)}…` : said);

/** What a pull request's description says about the review; '' when there was none or it is not over. */
export function reviewForRequest(review: Review | null): string {
  if (!review || review.status !== 'done') return '';
  const head = review.verdict === 'clean' ? `Reviewed by ${review.reviewer} before opening: nothing that must change.` : `Reviewed by ${review.reviewer} before opening. Open findings from its last round:`;
  return review.verdict === 'clean' || !review.summary ? head : `${head}\n\n${review.summary}`;
}

/** The choices the Create pull request form offers (Matt, 2026-11-20), in his order. */
export const REVIEW_CHOICES = ['before', 'after', 'skip', 'skip-session', 'never'] as const;
export type ReviewChoice = (typeof REVIEW_CHOICES)[number];
export const REVIEW_CHOICE_LABEL: Record<ReviewChoice, string> = {
  before: 'Review before opening PR',
  after: 'Open PR and start review',
  skip: 'Skip review',
  'skip-session': "Don't ask again for this session",
  never: "Don't ask again",
};

/** What is posted to the pull request when a review asked to be posted there ends. */
export function reviewComment(review: Review): string {
  const rounds = review.round === 1 ? '1 round' : `${review.round} rounds`;
  const head = review.verdict === 'clean' ? `**Review by ${review.reviewer}** (${rounds}, run in Kestrel): nothing that must change before this is merged.` : `**Review by ${review.reviewer}** (${rounds}, run in Kestrel): open findings from its last round. They are a second opinion, not a block.`;
  return review.verdict === 'clean' || !review.summary ? head : `${head}\n\n${review.summary}`;
}

/** What the form and the start notice add when the reviewer runs on the author's own agent: it is allowed, and it is not a second provider. */
export const sameAgentNote = (reviewer: string, agentLabel: string): string => `${reviewer} runs on ${agentLabel}, the same agent as this session. For a second opinion from another provider, point Review at another preset in Settings → Models & roles → Who does what.`;

/** The card offered when an agent opened a pull request itself: the form's choices, less the one that is too late. */
export const REVIEW_CARD = { start: 'Start review', skip: 'Not now', never: "Don't ask again" } as const;
