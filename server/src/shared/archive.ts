// What the user has archived: put out of sight, not deleted. Stored as one small setting. Pure.

export type ArchiveKind = 'session' | 'project' | 'group';

export interface Archived {
  sessions: string[];
  projects: string[];
  groups: string[];
}

export const NOTHING_ARCHIVED: Archived = { sessions: [], projects: [], groups: [] };
const KEY: Record<ArchiveKind, keyof Archived> = { session: 'sessions', project: 'projects', group: 'groups' };

export const isArchiveKind = (value: unknown): value is ArchiveKind => value === 'session' || value === 'project' || value === 'group';

const ids = (value: unknown): string[] => (Array.isArray(value) ? [...new Set(value.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 200))] : []);

export function sanitizeArchived(value: unknown): Archived {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return { sessions: ids(v.sessions), projects: ids(v.projects), groups: ids(v.groups) };
}

/** Archive or restore one thing. Returns the same object when nothing changes. */
export function setArchived(archived: Archived, kind: ArchiveKind, id: string, on: boolean): Archived {
  const key = KEY[kind];
  const has = archived[key].includes(id);
  if (has === on) return archived;
  return { ...archived, [key]: on ? [...archived[key], id] : archived[key].filter((x) => x !== id) };
}

/** Forget ids that no longer exist, so a deleted thing does not linger in the list. */
export function pruneArchived(archived: Archived, existing: { sessions: ReadonlySet<string>; projects: ReadonlySet<string>; groups: ReadonlySet<string> }): Archived {
  const next = { sessions: archived.sessions.filter((x) => existing.sessions.has(x)), projects: archived.projects.filter((x) => existing.projects.has(x)), groups: archived.groups.filter((x) => existing.groups.has(x)) };
  return next.sessions.length === archived.sessions.length && next.projects.length === archived.projects.length && next.groups.length === archived.groups.length ? archived : next;
}

/**
 * Whether a session is out of sight: archived itself, in an archived group, or belonging to an
 * archived project.
 */
export function sessionHidden(session: { id: string; groupId: string | null; projectId: string | null }, archived: Archived): boolean {
  return archived.sessions.includes(session.id) || (session.groupId !== null && archived.groups.includes(session.groupId)) || (session.projectId !== null && archived.projects.includes(session.projectId));
}
