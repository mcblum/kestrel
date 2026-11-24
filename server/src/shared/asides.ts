// A sidebar (Matt, 2026-11-24: "'sidebars' are universal. They are side convos starting from a point
// of time, essentially"): a side conversation that starts from one point of a session's conversation
// (a message or a card in it), about whatever the user pointed at, held in a pane beside that
// conversation while it stays in sight and carries on unchanged. Underneath it is a session of its
// own, kept out of sight: a read-only fork of the parent's conversation, made by the agent's own SDK
// (Claude: forkSession; Codex: thread/fork), cut at the end of the turn the point is in, so it knows
// the conversation as it was then. It reads the parent's worktree and changes nothing: no file, no
// other session, no ticket, and not the parent. It is listed nowhere (no session list, no project, no
// search, no notification) and drawn only in its pane. One point and subject has one sidebar; asking
// again opens it. It lives as long as its parent does. What it concluded goes back only by the user's
// hand: "Use in the conversation" puts the last answer into the parent's message box, never sent.
//
// Nothing here knows what a caller points at. A caller (a finding's control, a message's action)
// gives the point, a key that says which sidebar is the same one, and an optional subject: a name,
// a line for the placeholder, and what the agent should be told about it. Design: docs/designs/
// kestrel.md, "Sidebars". Pure and browser-safe.
//
// The word "sidebar" also names the session list down the left of the window. Matt's word is kept,
// and is said in one place (`ASIDE_NAME`), so it is one change if he settles on another.
import { AGENT_LABEL, type Agent } from '../model.ts';
import { FORKS } from './fork.ts';

/** What the feature is called wherever the app says its name. */
export const ASIDE_NAME = 'Sidebar';
/** The same in running text. */
export const ASIDE_WORD = 'sidebar';

export const ASIDE_KEY_MAX = 300;
export const SUBJECT_NAME_MAX = 80;
export const SUBJECT_SUMMARY_MAX = 400;
export const SUBJECT_CONTEXT_MAX = 8_000;

/** What a caller says a sidebar is about. */
export interface AsideSubject {
  /** In a few words, for the pane's head and placeholder: "Finding #1". */
  name: string;
  /** A line on it, shown under the placeholder. */
  summary: string;
  /** What the agent is told about it with the sidebar's first turn. */
  context?: string;
}

/** Where a sidebar comes from, kept on its session. */
export interface AsideOf {
  /** The parent: the session whose conversation it starts from. */
  sessionId: string;
  /** The message or card of the parent's conversation it starts from. */
  at: string;
  /** Which sidebar it is: asking with the same key in the same session opens this one. */
  key: string;
  /** What it is about in a few words; absent: the point itself. */
  name?: string;
  /** A line on what it is about, as it was when it started. */
  summary: string;
  /** The copy runs to the end of the conversation as it was when the sidebar started, because Kestrel has no record of where the point's turn ends. */
  whole?: true;
}

export function sanitizeAside(value: unknown): AsideOf | null {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (typeof v.sessionId !== 'string' || typeof v.at !== 'string' || typeof v.key !== 'string') return null;
  return {
    sessionId: v.sessionId,
    at: v.at,
    key: v.key,
    ...(typeof v.name === 'string' && v.name ? { name: v.name } : {}),
    summary: typeof v.summary === 'string' ? v.summary : '',
    ...(v.whole === true ? { whole: true as const } : {}),
  };
}

/** The same sidebar: the same key in the same parent. */
export const sameAside = (a: Pick<AsideOf, 'sessionId' | 'key'>, b: Pick<AsideOf, 'sessionId' | 'key'>): boolean => a.sessionId === b.sessionId && a.key === b.key;

/** What it is about, in running text: its subject's name, or "this point in the conversation". */
export const asideAbout = (of: Pick<AsideOf, 'name'>): string => of.name ?? 'this point in the conversation';

/** The empty pane's placeholder, in Matt's words. */
export const asidePlaceholder = (of: Pick<AsideOf, 'name'>): string => `Ask any questions you have about ${asideAbout(of)}`;

/** Its title, in its pane's head. */
export const asideTitle = (of: Pick<AsideOf, 'name' | 'summary'>): string => `${ASIDE_NAME}: ${of.name ?? clip(of.summary, 60)}`;

/** What a message's action says. */
export const START_ASIDE_HERE = `Start a ${ASIDE_WORD} from here`;
/** What a control says once there is one. */
export const OPEN_ASIDE = `Open its ${ASIDE_WORD}`;

/** Why a sidebar cannot be started from a session on this agent, or null when it can. */
export function asideRefusal(agent: Agent): string | null {
  return FORKS[agent] ? null : `${AGENT_LABEL[agent]} cannot fork a conversation, so a ${ASIDE_WORD} cannot start from this session: a ${ASIDE_WORD} is a copy of the conversation as it was at that point.`;
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
};

/** A line on a point with no subject: the start of what was said there. */
export const pointSummary = (text: string): string => clip(text, 160) || 'A card in the conversation.';

/** A caller's subject as given, checked: the subject, or why it is not one. */
export function checkSubject(value: unknown): { subject: AsideSubject | null } | { problem: string } {
  if (value === undefined || value === null) return { subject: null };
  const v = (typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  const summary = typeof v.summary === 'string' ? v.summary.trim() : '';
  const context = typeof v.context === 'string' ? v.context.trim() : '';
  if (!name || name.length > SUBJECT_NAME_MAX) return { problem: `A ${ASIDE_WORD}'s subject needs a name of at most ${SUBJECT_NAME_MAX} characters.` };
  if (summary.length > SUBJECT_SUMMARY_MAX) return { problem: `A ${ASIDE_WORD}'s summary can be at most ${SUBJECT_SUMMARY_MAX} characters.` };
  if (context.length > SUBJECT_CONTEXT_MAX) return { problem: `What a ${ASIDE_WORD} is told can be at most ${SUBJECT_CONTEXT_MAX} characters.` };
  return { subject: { name, summary, ...(context ? { context } : {}) } };
}

/** What the agent is told with the sidebar's first turn: where it is, what it may do, and what it is about. */
export function asideBrief(of: AsideOf, about: string): string {
  return [
    `[Kestrel] This is a ${ASIDE_WORD}: a side conversation the user started from a point of the conversation above, about ${asideAbout(of)}. The main conversation carries on without it, and nothing said here reaches it unless the user takes it there.`,
    'Answer what the user asks: what it means, whether it is right, what doing something about it would take, what the alternatives are. Read the code to check, and say what you are unsure of. You cannot change any file, run commands, or start or message other sessions. When you reach a conclusion, end with it in a few sentences the user can take back to the main conversation.',
    of.whole ? 'Your copy of the conversation runs past that point, to where it was when this sidebar started. Answer about the point, not about what came after it.' : '',
    about,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The Kestrel tools a sidebar keeps: the ones that only read or show. Every other call is refused (`ASIDE_TOOL_REFUSAL`). */
export const ASIDE_TOOLS: readonly string[] = ['listProjects', 'showWidget', 'ticketRead', 'browserRead', 'browserScreenshot', 'browserConsole', 'simList', 'simScreenshot'];
export const ASIDE_TOOL_REFUSAL = `This is a ${ASIDE_WORD}: it only talks. It cannot start, change or message anything. Tell the user what you would do; they decide in the main conversation.`;

/** The text "Use in the conversation" puts into the main message box: the sidebar's last answer, named. */
export const asideConclusion = (of: Pick<AsideOf, 'name'>, said: string): string => `From the ${ASIDE_WORD} about ${asideAbout(of)}:\n\n${said.trim()}`;
