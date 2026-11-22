import { AGENT_LABEL as SERVER_AGENT_LABEL, SELECTABLE_AGENTS, type Agent, type FilingStatus, type Project, type Session, type SessionView, type TrailEntry } from '@kestrel/server/model';
import { STATUS_DOT, STATUS_LABEL, statusOf, type Statused } from '@kestrel/server/status';

/** The agents the pickers offer. */
export const AGENTS: readonly Agent[] = SELECTABLE_AGENTS;
export const AGENT_LABEL: Record<Agent, string> = SERVER_AGENT_LABEL;

/** Which agents can start a session, and for the others the server's reason (not installed, not signed in…). */
export interface AgentStatus {
  available: Agent[];
  notes: Partial<Record<Agent, string>>;
  /** The ones that are not signed in and that Kestrel can sign in from here. */
  signIn: Agent[];
}

/** A few words for why an agent cannot start, for a picker entry; the full reason goes in its tooltip. */
export function unavailableWords(note: string | undefined): string {
  if (!note) return 'unavailable';
  if (/not installed/i.test(note)) return 'not installed';
  if (/not signed in/i.test(note)) return 'not signed in';
  return 'unavailable';
}

// Status words and dots come from the one vocabulary in @kestrel/server/status.
export const statusText = (s: Statused) => STATUS_LABEL[statusOf(s)];
export const dotClass = (s: Statused) => STATUS_DOT[statusOf(s)];
/** A trail entry has no note or landing; its filing says whether work landed. */
export const trailStatused = (e: TrailEntry): Statused => ({ state: e.state, note: '', request: e.request, ...(e.stopped ? { stopped: true } : {}) });

export const UNSCOPED = 'Unscoped';

export function projectName(session: SessionView, projects: readonly Project[]): string {
  const id = session.filing.status === 'hidden' ? session.startedIn : session.filing.projectId;
  return projects.find((p) => p.id === id)?.name ?? UNSCOPED;
}

/** The mark shown next to a project name when the filing is not simply "work landed here": a word or two, and what it means. */
export interface FilingMark {
  label: string;
  hint: string;
}

const FILING_MARKS = {
  // A handoff or delegate child with no changes yet: listed where it was started until git shows where its work is.
  pending: { label: 'no changes', hint: 'Started here by another session and has changed nothing yet, so it is listed where it was started. Once it changes files, it is listed under the project they are in.' },
  hidden: { label: 'handed off', hint: 'Handed its task to another session without changing anything.' },
  discarded: { label: 'discarded', hint: 'Its worktree was discarded: the changes that listed it here are gone.' },
} as const satisfies Record<string, FilingMark>;

export function filingMark(status: FilingStatus, discarded: boolean): FilingMark | null {
  if (status === 'pending') return FILING_MARKS.pending;
  if (status === 'hidden') return FILING_MARKS.hidden;
  if (discarded) return FILING_MARKS.discarded;
  return null;
}

export function age(updatedAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - updatedAt) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export const SESSION_MIME = 'application/x-kestrel-session';
/** A request row of CODE REVIEWS being dragged: its request's key. */
export const REVIEW_MIME = 'application/x-kestrel-review';
/** A project row being dragged to a new place among the projects. */
export const PROJECT_MIME = 'application/x-kestrel-project';
/** A group row being dragged to a new place in the Sessions list. */
export const GROUP_MIME = 'application/x-kestrel-group';
/** A project directory row being dragged to a new place in its project's list. */
export const DIR_MIME = 'application/x-kestrel-directory';
/** A file attached in a composer, dragged to reorder (components/attachments/). */
export const ATTACHMENT_MIME = 'application/x-kestrel-attachment';
/** A tag row being dragged to a new place in the Tags list. */
export const TAG_MIME = 'application/x-kestrel-tag';
/** A workstream's row, dragged to reorder the WORKSTREAMS section. */
export const WORKSTREAM_MIME = 'application/x-kestrel-workstream';
