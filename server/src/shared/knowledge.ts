// The knowledge base's format (design doc: docs/designs/knowledge.md). A knowledge base is a git
// repository with a manifest at its root and one Markdown file per topic under `entries/<area>/`.
// Everything here is pure: the server reads and writes entries with it, and the page words the same
// limits with it, so a file Kestrel writes always passes the check Kestrel reads with.
//
// The rule the sizes serve: a session is handed one line per entry that applies to its repository,
// never a body, and at most `INDEX_LINES_MAX` lines however large the knowledge base grows.

/** The file at the root of a repository that makes it a knowledge base. */
export const KNOWLEDGE_MANIFEST = 'kestrel-knowledge.json';
/** Where entries live: `entries/<area>/<slug>.md`, exactly two levels. */
export const KNOWLEDGE_ENTRIES_DIR = 'entries';

export const KNOWLEDGE_TITLE_MAX = 80;
/** An entry's one line in the index. */
export const KNOWLEDGE_SUMMARY_MAX = 160;
/** An entry's body, in characters: about 1,500 tokens. A longer topic is two entries. */
export const KNOWLEDGE_BODY_MAX = 6000;
/** Index lines a session's standing instruction may carry. */
export const INDEX_LINES_MAX = 40;
/** Entries one search returns. */
export const SEARCH_RESULTS_MAX = 15;
/** Days after which an entry nobody re-verified is read with a warning. */
export const KNOWLEDGE_STALE_DAYS = 180;
/** Proposals one session may raise: a session that learns ten things proposes the two that matter. */
export const PROPOSALS_PER_SESSION = 2;

export interface KnowledgeManifest {
  version: 1;
  /** What the knowledge base is called, as agents and the user read it. */
  name: string;
}

/** Which repositories an entry applies to: every one, or those named by `repositoryKey`. */
export type KnowledgeScope = 'all' | readonly string[];

/** An entry without its body: what the index holds. */
export interface KnowledgeIndexEntry {
  /** `<area>/<slug>`: its path under `entries/`, without `.md`. */
  id: string;
  area: string;
  title: string;
  summary: string;
  scope: KnowledgeScope;
  /** The person or team who answers for it. */
  owner: string;
  /** The day somebody last checked it was true, `YYYY-MM-DD`. */
  verified: string;
}

export interface KnowledgeEntry extends KnowledgeIndexEntry {
  body: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseManifest(text: string): Checked<KnowledgeManifest> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, reason: `${KNOWLEDGE_MANIFEST} is not valid JSON.` }; }
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: `${KNOWLEDGE_MANIFEST} must be an object with "version" and "name".` };
  const { version, name } = raw as Record<string, unknown>;
  if (version !== 1) return { ok: false, reason: `${KNOWLEDGE_MANIFEST} has a version this Kestrel does not read; it reads version 1.` };
  if (typeof name !== 'string' || !name.trim()) return { ok: false, reason: `${KNOWLEDGE_MANIFEST} needs a "name".` };
  return { ok: true, value: { version: 1, name: name.trim().slice(0, KNOWLEDGE_TITLE_MAX) } };
}

/**
 * A repository as scopes name it: `host/owner/name`, lower case, whatever way its remote is
 * written. Every developer's clone of one repository gives the same key, which a local project
 * name never would.
 */
export function repositoryKey(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const raw = remote.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(raw);
  try {
    const url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : raw);
    const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    if (!url.hostname || !path) return null;
    return `${url.hostname}/${path}`.toLowerCase();
  } catch { return null; }
}

/** The id of an entry from its path in the repository, or null when the path is not an entry's. */
export function entryIdOf(path: string): string | null {
  const parts = path.split('/');
  if (parts.length !== 3 || parts[0] !== KNOWLEDGE_ENTRIES_DIR || !parts[2]!.endsWith('.md')) return null;
  const area = parts[1]!;
  const slug = parts[2]!.slice(0, -3);
  return SLUG.test(area) && SLUG.test(slug) ? `${area}/${slug}` : null;
}

export const entryPath = (id: string): string => `${KNOWLEDGE_ENTRIES_DIR}/${id}.md`;

/** A title as a file name: lower case, words joined by hyphens, at most 60 characters. */
export function slugFor(title: string): string {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, 60).replace(/-+$/, '');
}

function parseScope(raw: string): Checked<KnowledgeScope> {
  const parts = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return { ok: false, reason: 'scope is empty: write "all" or the repositories it applies to (host/owner/name), separated by commas.' };
  if (parts.includes('all')) return parts.length === 1 ? { ok: true, value: 'all' } : { ok: false, reason: 'scope is "all" or a list of repositories, not both.' };
  const bad = parts.find((p) => !/^[^/\s]+\/[^\s]+$/.test(p));
  if (bad) return { ok: false, reason: `scope "${bad}" is not a repository: write host/owner/name, such as github.com/acme/api.` };
  return { ok: true, value: parts };
}

/** What is wrong with an entry's fields, or null. One check, for a file read and a proposal alike. */
export function entryProblem(e: Omit<KnowledgeEntry, 'id' | 'area'>): string | null {
  if (!e.title.trim()) return 'An entry needs a title.';
  if (e.title.length > KNOWLEDGE_TITLE_MAX) return `The title is ${e.title.length} characters; at most ${KNOWLEDGE_TITLE_MAX}.`;
  if (!e.summary.trim()) return 'An entry needs a summary: the one line an agent reads to decide whether to open it.';
  if (e.summary.length > KNOWLEDGE_SUMMARY_MAX) return `The summary is ${e.summary.length} characters; at most ${KNOWLEDGE_SUMMARY_MAX}.`;
  if (/[\r\n]/.test(e.title) || /[\r\n]/.test(e.summary)) return 'The title and the summary are one line each.';
  if (!e.owner.trim()) return 'An entry needs an owner: the person or team who answers for it.';
  if (!DAY.test(e.verified) || Number.isNaN(Date.parse(e.verified))) return 'verified must be a date written YYYY-MM-DD.';
  if (!e.body.trim()) return 'An entry needs a body.';
  if (e.body.length > KNOWLEDGE_BODY_MAX) return `The body is ${e.body.length} characters; at most ${KNOWLEDGE_BODY_MAX}. Split it into two entries, each about one thing.`;
  return null;
}

const FIELDS = ['title', 'summary', 'scope', 'owner', 'verified'] as const;

/** An entry from its file: a header of `key: value` lines between `---` lines, then the body. */
export function parseEntry(path: string, text: string): Checked<KnowledgeEntry> {
  const id = entryIdOf(path);
  if (!id) return { ok: false, reason: `${path} is not at ${KNOWLEDGE_ENTRIES_DIR}/<area>/<name>.md with lower-case, hyphenated names.` };
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return { ok: false, reason: 'The file does not start with a header between --- lines.' };
  const end = lines.indexOf('---', 1);
  if (end < 0) return { ok: false, reason: 'The header is not closed with a --- line.' };
  const header = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const at = line.indexOf(':');
    if (at < 1) return { ok: false, reason: `Header line "${line.slice(0, 60)}" is not "key: value".` };
    header.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const missing = FIELDS.find((f) => !header.get(f));
  if (missing) return { ok: false, reason: `The header has no ${missing}.` };
  const scope = parseScope(header.get('scope')!);
  if (!scope.ok) return scope;
  const entry: KnowledgeEntry = {
    id,
    area: id.split('/')[0]!,
    title: header.get('title')!,
    summary: header.get('summary')!,
    scope: scope.value,
    owner: header.get('owner')!,
    verified: header.get('verified')!,
    body: lines.slice(end + 1).join('\n').trim(),
  };
  const problem = entryProblem(entry);
  return problem ? { ok: false, reason: problem } : { ok: true, value: entry };
}

/** An entry as its file. `parseEntry` reads back exactly what this writes. */
export function renderEntry(e: Omit<KnowledgeEntry, 'id' | 'area'>): string {
  const scope = e.scope === 'all' ? 'all' : e.scope.join(', ');
  return `---\ntitle: ${e.title.trim()}\nsummary: ${e.summary.trim()}\nscope: ${scope}\nowner: ${e.owner.trim()}\nverified: ${e.verified}\n---\n\n${e.body.trim()}\n`;
}

/** Whether an entry applies to a session working in the repositories `keys`. */
export const appliesTo = (e: Pick<KnowledgeIndexEntry, 'scope'>, keys: readonly string[]): boolean => e.scope === 'all' || e.scope.some((s) => keys.includes(s));

/**
 * At most `n` entries, taken one area at a time in turn, so every area is seen when not everything
 * fits; in the order they came. Without it the lines that fit would be whichever areas sort first.
 */
function acrossAreas(entries: readonly KnowledgeIndexEntry[], n: number): KnowledgeIndexEntry[] {
  if (entries.length <= n) return [...entries];
  const byArea = new Map<string, KnowledgeIndexEntry[]>();
  for (const e of entries) byArea.set(e.area, [...(byArea.get(e.area) ?? []), e]);
  const queues = [...byArea.values()];
  const picked = new Set<KnowledgeIndexEntry>();
  for (let round = 0; picked.size < n && queues.some((q) => q.length > round); round++) {
    for (const q of queues) if (q[round] && picked.size < n) picked.add(q[round]!);
  }
  return entries.filter((e) => picked.has(e));
}

const line = (e: KnowledgeIndexEntry): string => `- ${e.id}: ${e.title}. ${e.summary}`;

/**
 * The index a session is handed: the entries for its own repositories first, then the ones for
 * every repository, at most `max` lines, taken evenly across areas; what does not fit is counted
 * by area, to be found by searching. So the text has a ceiling that does not move as the knowledge base grows.
 */
export function indexText(index: readonly KnowledgeIndexEntry[], keys: readonly string[], max: number = INDEX_LINES_MAX): string {
  const mine = index.filter((e) => e.scope !== 'all' && appliesTo(e, keys));
  const shared = index.filter((e) => e.scope === 'all');
  const listedMine = acrossAreas(mine, max);
  const listed = [...listedMine, ...acrossAreas(shared, max - listedMine.length)];
  const shown = new Set(listed);
  const left = [...mine, ...shared].filter((e) => !shown.has(e));
  const elsewhere = index.length - mine.length - shared.length;
  const out = listed.map(line);
  if (left.length > 0) {
    const counts = new Map<string, number>();
    for (const e of left) counts.set(e.area, (counts.get(e.area) ?? 0) + 1);
    const areas = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([area, n]) => `${area} (${n})`);
    out.push(`- ${left.length} more that apply here are not listed, by area: ${areas.join(', ')}.`);
  }
  if (elsewhere > 0) out.push(`- ${elsewhere} more are about other repositories.`);
  return out.join('\n');
}

const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

/**
 * The entries that match a query, best first: a word in the title counts most, then the summary,
 * then the id, and an entry for the caller's own repository is ahead of an equal one that is not.
 * `inBody` names entries whose body holds the words (the store greps for them); they rank last.
 */
export function searchIndex(index: readonly KnowledgeIndexEntry[], query: string, keys: readonly string[], inBody: ReadonlySet<string> = new Set(), max: number = SEARCH_RESULTS_MAX): KnowledgeIndexEntry[] {
  const terms = words(query);
  if (terms.length === 0) return [];
  const scored = index.flatMap((e) => {
    const title = words(e.title), summary = words(e.summary), id = words(e.id);
    let score = 0;
    for (const t of terms) score += (title.includes(t) ? 4 : 0) + (summary.includes(t) ? 2 : 0) + (id.includes(t) ? 2 : 0);
    if (inBody.has(e.id)) score += 1;
    if (score === 0) return [];
    return [{ e, score: score * 2 + (e.scope !== 'all' && appliesTo(e, keys) ? 1 : 0) }];
  });
  return scored.sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id)).slice(0, max).map((s) => s.e);
}

/** An existing entry a proposed title would repeat: the same slug, or the same words in the title. */
export function sameTopic(index: readonly KnowledgeIndexEntry[], title: string): KnowledgeIndexEntry | undefined {
  const slug = slugFor(title);
  const mine = new Set(words(title));
  return index.find((e) => {
    if (e.id.split('/')[1] === slug) return true;
    const theirs = new Set(words(e.title));
    if (mine.size < 3 || theirs.size < 3) return false;
    const both = [...mine].filter((w) => theirs.has(w)).length;
    return both / Math.min(mine.size, theirs.size) >= 0.8;
  });
}

/** How many days ago an entry was verified, as of `today` (`YYYY-MM-DD`). */
export const daysSince = (verified: string, today: string): number => Math.floor((Date.parse(today) - Date.parse(verified)) / 86_400_000);

export const isStale = (e: Pick<KnowledgeIndexEntry, 'verified'>, today: string): boolean => daysSince(e.verified, today) > KNOWLEDGE_STALE_DAYS;

const SECRETS: readonly { what: string; pattern: RegExp }[] = [
  { what: 'a private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { what: 'an access token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/ },
  { what: 'a password or key written out', pattern: /\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*["']?(?![<{$[(])[^\s"'<>{}$]{8,}/i },
  // A placeholder where the password goes (`<pw>`, `$PASSWORD`, `{password}`) is how an entry shows the shape of an address without the value.
  { what: 'credentials inside an address', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:(?![<{$[(%])[^\s/@]+@/i },
];

/**
 * What in a text looks like a secret, or null. A knowledge base is read by everyone's agents, so a
 * proposal holding one is refused before the user is even asked; it names where a credential is
 * kept instead.
 */
export function likelySecret(text: string): string | null {
  return SECRETS.find((s) => s.pattern.test(text))?.what ?? null;
}

/** The branch a proposal for an entry goes on: one name per entry, so two people proposing the same thing meet. */
export const proposalBranch = (id: string): string => `knowledge/${id.replace('/', '-')}`;

// ── The setting (Settings → Workflow → Knowledge base) ──────────────────────────────────────────

export interface KnowledgeSettings {
  /** The registered project that is the knowledge base; null: none is used. */
  projectId: string | null;
  /** Whether an agent may propose an addition: asked each time, or never proposed. */
  proposals: 'ask' | 'never';
  /** How often the knowledge base's remote is fetched, in minutes: one of `KNOWLEDGE_FETCH_MINUTES`. */
  fetchMinutes: number;
}

/** The intervals the remote may be fetched on, in minutes. A list, not a free number: nobody needs every second, and a host is not to be hammered. */
export const KNOWLEDGE_FETCH_MINUTES = [5, 10, 30, 60, 240] as const;
export const KNOWLEDGE_FETCH_DEFAULT = 10;
export const isFetchMinutes = (value: unknown): value is number => (KNOWLEDGE_FETCH_MINUTES as readonly unknown[]).includes(value);
/** An interval as the settings page words it. */
export const fetchEveryText = (minutes: number): string => (minutes < 60 ? `Every ${minutes} minutes` : minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`);

export const NO_KNOWLEDGE: KnowledgeSettings = { projectId: null, proposals: 'ask', fetchMinutes: KNOWLEDGE_FETCH_DEFAULT };

/** A stored value made safe, one field at a time. */
export function asKnowledgeSettings(raw: unknown): KnowledgeSettings {
  if (typeof raw !== 'object' || raw === null) return NO_KNOWLEDGE;
  const { projectId, proposals, fetchMinutes } = raw as Record<string, unknown>;
  return {
    projectId: typeof projectId === 'string' && projectId ? projectId : null,
    proposals: proposals === 'never' ? 'never' : 'ask',
    fetchMinutes: isFetchMinutes(fetchMinutes) ? fetchMinutes : KNOWLEDGE_FETCH_DEFAULT,
  };
}

/** A registered project whose default branch holds a manifest. */
export interface KnowledgeCandidate {
  projectId: string;
  project: string;
  /** The knowledge base's own name, from its manifest. */
  name: string;
}

/** What the settings page shows: the choice, what could be chosen, and the chosen one as read. */
export interface KnowledgeView {
  settings: KnowledgeSettings;
  candidates: KnowledgeCandidate[];
  base: {
    projectId: string;
    project: string;
    name: string;
    /** The ref it is read from, such as `origin/main`. */
    ref: string;
    entries: number;
    areas: string[];
    /** Entries not verified within `KNOWLEDGE_STALE_DAYS`. */
    stale: number;
    /** Files under `entries/` left out because they are not valid entries. */
    skipped: { path: string; reason: string }[];
  } | null;
  /** Why the chosen project cannot be read as a knowledge base, when it cannot. */
  problem: string | null;
}

export const KNOWLEDGE_OFF_REASON = 'No knowledge base is in use. The user chooses one in Settings → Workflow → Knowledge base; tell them so if they expected one.';
