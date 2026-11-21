// What the Search box finds: sessions, projects, groups and tags, by any of the words typed. Pure.
import { NO_FOLDER_YET, otherFolders, projectPath } from './project-folders.ts';
import { tagCounts } from './tags.ts';

export type SearchHit =
  /** `archived`: out of the sidebar; it cannot be opened as a tab, so picking it opens Settings → Archived. */
  | { kind: 'session'; id: string; title: string; detail: string; archived?: true }
  | { kind: 'project'; id: string; title: string; detail: string }
  | { kind: 'group'; id: string; title: string; detail: string }
  /** `id` is the tag itself; it opens the tag's page. */
  | { kind: 'tag'; id: string; title: string; detail: string }
  /** `archived`: out of the sidebar (Settings → Archived); it still opens its page, which says so. */
  | { kind: 'workstream'; id: string; title: string; detail: string; archived?: true };

export interface Searchable {
  sessions: readonly { id: string; title: string; detail: string; updatedAt: number; tags?: readonly string[] }[];
  projects: readonly { id: string; name: string; folders: readonly { id: string; path: string }[]; defaultFolderId?: string | null }[];
  groups: readonly { id: string; name: string }[];
  /** Absent from data written before workstreams existed. */
  workstreams?: readonly SearchableWorkstream[];
  /** Archived workstreams: found by a typed search only, below everything that is not archived. */
  archivedWorkstreams?: readonly SearchableWorkstream[];
  /** Archived sessions, with their project's name: found by a typed search only, at the very end. */
  archivedSessions?: readonly { id: string; title: string; project: string; updatedAt: number }[];
}

type SearchableWorkstream = { id: string; name: string; objective: string; sessionIds: readonly string[] };
type Candidate = SearchHit & { at: number; also: string };

const sessionCount = (n: number) => `${n} session${n === 1 ? '' : 's'}`;

function workstreamHit(w: SearchableWorkstream, archived: boolean): Candidate {
  const detail = `${archived ? 'Archived workstream' : 'Workstream'} · ${sessionCount(w.sessionIds.length)}`;
  return { kind: 'workstream', id: w.id, title: w.name, detail, at: 0, also: w.objective, ...(archived ? { archived: true as const } : {}) };
}

/** Everything that can be found, archived workstreams only when something is typed. */
function candidates(data: Searchable, typed: boolean): Candidate[] {
  return [
    ...data.sessions.map((s) => ({ kind: 'session' as const, id: s.id, title: s.title, detail: s.detail, at: s.updatedAt, also: (s.tags ?? []).join(' ') })),
    ...data.projects.map((p) => ({ kind: 'project' as const, id: p.id, title: p.name, detail: projectPath(p) ?? NO_FOLDER_YET, at: 0, also: otherFolders(p).map((f) => f.path).join(' ') })),
    ...data.groups.map((g) => ({ kind: 'group' as const, id: g.id, title: g.name, detail: 'Group', at: 0, also: '' })),
    ...(data.workstreams ?? []).map((w) => workstreamHit(w, false)),
    // Tags as the sidebar lists them (tags.ts): each once, whatever its case, alphabetical.
    ...tagCounts(data.sessions.map((x) => ({ tags: x.tags ?? [] }))).map(({ tag, count }) => ({ kind: 'tag' as const, id: tag, title: tag, detail: `Tag · ${sessionCount(count)}`, at: 0, also: '' })),
    ...(typed ? (data.archivedWorkstreams ?? []).map((w) => workstreamHit(w, true)) : []),
    ...(typed ? (data.archivedSessions ?? []).map((s) => ({ kind: 'session' as const, id: s.id, title: s.title, detail: `Archived · ${s.project}`, at: s.updatedAt, also: '', archived: true as const })) : []),
  ];
}

/**
 * Where a hit ranks before its words are weighed: what is in sight, then archived workstreams, then
 * archived sessions (Settings → Archived is where they otherwise live).
 */
function tier(hit: Candidate): number {
  if (!('archived' in hit) || !hit.archived) return 0;
  return hit.kind === 'workstream' ? 1 : 2;
}

const MAX_HITS = 40;

/**
 * Every word typed must appear in an item's title or detail (or a session's tags), in any order, ignoring case. With
 * nothing typed, the most recently changed sessions come first, then projects and groups.
 * Matches in the title rank above matches only in the detail. An archived workstream comes after
 * everything that is not archived, and an archived session after that, the most recently active
 * first whatever the words matched (`tier`).
 */
export function search(data: Searchable, query: string): SearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = candidates(data, words.length > 0)
    .map((hit) => {
      const title = hit.title.toLowerCase();
      const text = `${title} ${hit.detail.toLowerCase()} ${hit.also.toLowerCase()}`;
      if (!words.every((w) => text.includes(w))) return null;
      const rank = tier(hit);
      // Archived sessions keep their own order (most recently active first): a title match does not lift one.
      return { hit, rank, inTitle: rank < 2 && words.length > 0 && words.every((w) => title.includes(w)) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  scored.sort((a, b) => a.rank - b.rank || Number(b.inTitle) - Number(a.inTitle) || b.hit.at - a.hit.at);
  return scored.slice(0, MAX_HITS).map(({ hit: { at: _at, also: _also, ...hit } }) => hit);
}
