// A stretch of the conversation where the agent works on its own (tap, screenshot, ask, tap,
// screenshot…) is drawn folded: one strip of its pictures, one line for the approvals you gave and
// one line for its tool steps, instead of a long alternation of fragments. Pure, so the rule is
// pinned by tests and the UI only draws what it says. See docs/designs/kestrel.md, "Pictures in the
// conversation" and "Answered approvals".

/** Two pictures further apart than this are not in one fold. */
export const PICTURE_GROUP_WINDOW_MS = 2 * 60 * 1000;

/** What the rule reads of an approval or question card (an InputCard has all of these). */
export interface FoldCard {
  kind: 'approval' | 'question';
  tool: string;
  title: string;
  detail: string;
  markdown?: boolean;
  options: readonly { label: string; role: 'allow' | 'deny' | 'choice' }[];
  resolved?: string;
}

/** What the rule reads of a message (a ChatMessage has all of these). */
export interface FoldMessage {
  author: 'you' | 'agent';
  text: string;
  /** When a picture message first appeared, ms since 1970. Older ones have none. */
  at?: number;
  notice?: unknown;
  activity?: readonly unknown[];
  images?: readonly string[];
  question?: unknown;
  input?: FoldCard;
  todos?: readonly unknown[];
  widget?: unknown;
  file?: unknown;
  next?: unknown;
  review?: unknown;
  roundFindings?: unknown;
  reviewEnd?: unknown;
  suggestion?: unknown;
  started?: unknown;
}

export interface Fold {
  /** The first message of the stretch: the fold is drawn in its place. */
  start: number;
  /** Every message the fold stands for, in order (start included). */
  members: number[];
  /** The pictures, in order. */
  pictures: { message: number; name: string }[];
  /** Messages that are answered approvals, in order. */
  approvals: number[];
  /** Messages that are only tool lines, in order. */
  steps: number[];
  /**
   * The agent's message just before the fold, when it is text followed by tool lines ("Testing the
   * app." then the first tap): its tool lines open the fold's steps line, and the message is drawn
   * with its text only. The tools of a text message always ran after its text.
   */
  lead?: number;
}

type Part = 'steps' | 'pictures' | 'approval';

/** Nothing on it besides tool lines and pictures (no prose, card, notice, list, widget, file or next step). */
function bare(m: FoldMessage): boolean {
  if (m.author !== 'agent' || m.notice || m.text.trim()) return false;
  return !(m.question || m.input || m.todos?.length || m.widget || m.file || m.next || m.review || m.roundFindings || m.reviewEnd || m.suggestion || m.started);
}

/** An approval that has been answered (or abandoned). Plans and questions keep their own form. */
export function isAnsweredApproval(card: FoldCard | undefined): card is FoldCard & { resolved: string } {
  return Boolean(card && card.kind === 'approval' && !card.markdown && card.resolved);
}

/** Agent text with tool lines after it and nothing else: its tool lines can join the fold that follows. */
function textThenSteps(m: FoldMessage | undefined): boolean {
  if (!m || m.author !== 'agent' || m.notice || !m.text.trim() || !m.activity?.length || m.images?.length) return false;
  return !(m.question || m.input || m.todos?.length || m.widget || m.file || m.next || m.review || m.roundFindings || m.reviewEnd || m.suggestion || m.started);
}

/** What a message can be inside a fold, or null when it ends one. */
function partOf(m: FoldMessage): Part | null {
  if (m.author === 'agent' && !m.notice && !m.text.trim() && isAnsweredApproval(m.input) && !m.images?.length && !m.activity?.length) return 'approval';
  if (!bare(m)) return null;
  if (m.images?.length) return 'pictures';
  return 'steps';
}

/** Close enough in time; without timestamps (messages stored before they had them) adjacency decides. */
function closeInTime(previous: FoldMessage, next: FoldMessage, windowMs: number): boolean {
  if (previous.at === undefined || next.at === undefined) return true;
  return next.at >= previous.at && next.at - previous.at <= windowMs;
}

const empty = (start: number): Fold => ({ start, members: [], pictures: [], approvals: [], steps: [] });

/** Worth folding: an approval to compact, or pictures to group. Tool lines and one picture alone stay as they were. */
const worthFolding = (f: Fold) => f.approvals.length > 0 || f.pictures.length >= 2;

/**
 * The folds of a conversation. A fold is a run of consecutive agent messages that are each only
 * tool lines, only pictures, or an answered approval. Agent prose, a user message, a notice, a
 * card still waiting, a question or plan card, a task list, a widget, a file or a next step ends
 * the run, and so does a picture more than `windowMs` after the run's previous picture. A run is
 * folded when it has an answered approval or at least two pictures; otherwise its messages are
 * drawn as themselves.
 */
export function foldConversation(messages: readonly FoldMessage[], windowMs = PICTURE_GROUP_WINDOW_MS): Fold[] {
  const folds: Fold[] = [];
  let run: Fold | null = null;
  let lastPicture: FoldMessage | null = null;
  const close = () => {
    if (run && worthFolding(run)) folds.push(textThenSteps(messages[run.start - 1]) ? { ...run, lead: run.start - 1 } : run);
    run = null;
    lastPicture = null;
  };
  messages.forEach((m, i) => {
    const part = partOf(m);
    if (!part) return close();
    if (part === 'pictures' && lastPicture && !closeInTime(lastPicture, m, windowMs)) close();
    const current: Fold = run ?? (run = empty(i));
    current.members.push(i);
    if (part === 'steps') current.steps.push(i);
    else if (part === 'approval') current.approvals.push(i);
    else {
      current.pictures.push(...m.images!.map((name) => ({ message: i, name })));
      lastPicture = m;
    }
  });
  close();
  return folds;
}

/**
 * How each message is drawn: as itself (no entry), as the fold that starts there, not at all, or
 * (a fold's lead) with its text only.
 */
export type FoldRole = { kind: 'fold'; fold: Fold } | { kind: 'folded' } | { kind: 'text-only' };

export function foldRoles(folds: readonly Fold[]): Map<number, FoldRole> {
  const roles = new Map<number, FoldRole>();
  for (const fold of folds) {
    for (const i of fold.members) roles.set(i, { kind: 'folded' });
    roles.set(fold.start, { kind: 'fold', fold });
    if (fold.lead !== undefined) roles.set(fold.lead, { kind: 'text-only' });
  }
  return roles;
}

// ---- answered approvals, in words ------------------------------------------------------------

export type Outcome = 'allowed' | 'denied' | 'other';

/** How an answered approval ended: one of its allow options, one of its deny options, or neither (stopped, interrupted). */
export function outcomeOf(card: FoldCard): Outcome {
  const option = card.options.find((o) => o.label === card.resolved);
  if (option?.role === 'allow') return 'allowed';
  if (option?.role === 'deny') return 'denied';
  return 'other';
}

type Sort = 'command' | 'edit' | 'browser' | 'simulator' | 'action';
const NOUNS: Record<Sort, [string, string]> = {
  command: ['command', 'commands'],
  edit: ['edit', 'edits'],
  browser: ['browser action', 'browser actions'],
  simulator: ['simulator action', 'simulator actions'],
  action: ['action', 'actions'],
};

/** What kind of thing an approval was for, by its tool. */
export function sortOf(tool: string): Sort {
  // An MCP tool is mcp__<server>__<name>.
  const name = tool.split('__').at(-1) ?? tool;
  if (name === 'Bash') return 'command';
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return 'edit';
  if (name.startsWith('browser_')) return 'browser';
  if (name.startsWith('sim_')) return 'simulator';
  return 'action';
}

export interface ApprovalSummary {
  /** The whole line, e.g. "12 commands allowed" or "9 commands allowed · 1 denied". */
  text: string;
  /** The same line in pieces, so a denial can be drawn in its meaning colour. */
  parts: { text: string; outcome: Outcome }[];
  allowed: number;
  denied: number;
  /** Neither allowed nor denied: stopped, interrupted, or never answered. */
  other: number;
}

/** One compact line for a run of answered approvals. A mixed run is counted as "actions". */
export function summarizeApprovals(cards: readonly FoldCard[]): ApprovalSummary {
  const sorts = new Set(cards.map((c) => sortOf(c.tool)));
  const [one, many] = NOUNS[sorts.size === 1 ? [...sorts][0]! : 'action'];
  const count = (o: Outcome) => cards.filter((c) => outcomeOf(c) === o).length;
  const allowed = count('allowed');
  const denied = count('denied');
  const other = count('other');
  const counted: { n: number; word: string; outcome: Outcome }[] = [
    { n: allowed, word: 'allowed', outcome: 'allowed' },
    { n: denied, word: 'denied', outcome: 'denied' },
    { n: other, word: 'not answered', outcome: 'other' },
  ];
  // The noun goes with the first count: "9 commands allowed · 1 denied", "1 command denied".
  const parts = counted.filter((p) => p.n > 0).map((p, i) => ({ text: i === 0 ? `${p.n} ${p.n === 1 ? one : many} ${p.word}` : `${p.n} ${p.word}`, outcome: p.outcome }));
  return { text: parts.map((p) => p.text).join(' · '), parts, allowed, denied, other };
}

/**
 * What was asked, in one line: the command itself for a command (its description is the first
 * paragraph of the detail when there is one), the card's title otherwise.
 */
export function askedLine(card: FoldCard): string {
  if (sortOf(card.tool) !== 'command' || !card.detail.trim()) return card.title;
  const paragraphs = card.detail.split(/\n\s*\n/).filter((p) => p.trim());
  const command = paragraphs.length > 1 ? paragraphs.slice(1).join('\n\n') : paragraphs[0]!;
  return command.trim().split('\n')[0]!.trim();
}

/** The outcome in words, for one approval. */
export function outcomeText(card: FoldCard): string {
  const outcome = outcomeOf(card);
  if (outcome === 'allowed') return card.resolved && card.resolved !== 'Allow' ? card.resolved : 'allowed';
  if (outcome === 'denied') return card.resolved && card.resolved !== 'Deny' ? card.resolved : 'denied';
  return card.resolved || 'not answered';
}
