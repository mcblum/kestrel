// SQLite provider, on Node's built-in driver (no native module to build).
// Statements are prepared once and reused; WAL keeps readers from blocking the writer.
import { asReviewMark, type ReviewMark } from '../shared/review-requests.ts';
import { sanitizeAside, type AsideOf } from '../shared/asides.ts';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Group, Link, LinkKind, Pin, PinKind, Project, ProjectFolder, RequestLink, Session, SessionRequestLink, SessionWait, TagRow, Workstream } from '../model.ts';
import type { PullRequestState } from '../shared/details.ts';
import type { HostKind } from '../shared/host-terms.ts';
import { isPullRequestState } from '../shared/request-state.ts';
import type { PinRef } from '../shared/pins.ts';
import { createLocalPersistence } from './local.ts';
import { foldersByProject, migrateFolders, SETTLE_DEFAULT, SYNC_LEGACY_PATH } from './sqlite-folders.ts';
import type { LocalDriver, Persistence, SessionPatch, StoredDetail, WorkstreamPatch } from './types.ts';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, is_git INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, auto INTEGER NOT NULL, created_at INTEGER NOT NULL, project_id TEXT);
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL, state TEXT NOT NULL, note TEXT NOT NULL,
    started_in TEXT REFERENCES projects(id), landed_in TEXT REFERENCES projects(id),
    worktree_path TEXT, branch TEXT, worktree_discarded INTEGER NOT NULL DEFAULT 0,
    group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS sessions_group ON sessions(group_id);
  CREATE INDEX IF NOT EXISTS sessions_state ON sessions(state);
  CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    child_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS links_parent ON links(parent_id);
  CREATE TABLE IF NOT EXISTS session_detail (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS session_tags (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, tag TEXT NOT NULL,
    PRIMARY KEY (session_id, position));
  CREATE TABLE IF NOT EXISTS workstreams (id TEXT PRIMARY KEY, name TEXT NOT NULL, objective TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS workstream_sessions (
    workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (workstream_id, session_id));
  CREATE TABLE IF NOT EXISTS session_waits (
    workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
    waiter_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    reason TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (waiter_id, target_id));
  CREATE TABLE IF NOT EXISTS pins (kind TEXT NOT NULL, id TEXT NOT NULL, pinned_at INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kind, id));
  CREATE TABLE IF NOT EXISTS session_requests (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    host TEXT NOT NULL, number INTEGER NOT NULL, url TEXT NOT NULL, branch TEXT NOT NULL, linked_at INTEGER NOT NULL,
    state TEXT,
    PRIMARY KEY (session_id, host, number));
`;
// New tables are added to SCHEMA with IF NOT EXISTS, so a store written before them opens with them empty.

/**
 * Stores written before pins could be reordered have no position column: add it and number the
 * pins in the order they were pinned, which is the order they were shown in.
 */
function addPinPositions(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(pins)').all() as { name: string }[];
  if (columns.some((c) => c.name === 'position')) return;
  db.exec(`
    ALTER TABLE pins ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
    UPDATE pins SET position = (SELECT count(*) FROM pins AS p WHERE p.pinned_at < pins.pinned_at OR (p.pinned_at = pins.pinned_at AND p.rowid < pins.rowid));
  `);
}

/** Stores written before a workstream could be complete or archived: add the columns (active, not archived). */
function addWorkstreamStateColumns(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(workstreams)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'status')) db.exec("ALTER TABLE workstreams ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  if (!columns.some((c) => c.name === 'archived_at')) db.exec('ALTER TABLE workstreams ADD COLUMN archived_at INTEGER');
}

/** Stores written before groups could belong to a project: add the column, empty (the Sessions list). */
function addGroupProjectColumn(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(groups)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'project_id')) db.exec('ALTER TABLE groups ADD COLUMN project_id TEXT');
}

/**
 * Stores written before sessions kept their own activity time: add the column, and give a session
 * without one its last update as one. Left empty it would be read as `updatedAt`, so a later move or
 * rename would count as activity and turn the dot green.
 */
function addActivityColumn(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'last_activity_at')) db.exec('ALTER TABLE sessions ADD COLUMN last_activity_at INTEGER');
  db.exec('UPDATE sessions SET last_activity_at = updated_at WHERE last_activity_at IS NULL');
}

/** Freeze the best known completion date once, so later filing or resuming cannot move it. */
function addCompletionColumn(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (columns.some((c) => c.name === 'completed_at')) return;
  db.exec('ALTER TABLE sessions ADD COLUMN completed_at INTEGER');
  db.exec("UPDATE sessions SET completed_at = last_activity_at WHERE state = 'done' AND note NOT LIKE 'Stopped%' AND note NOT LIKE 'Handed off%'");
}

/**
 * Stores written before "Stopped" was a status of its own: add the column, and derive it once from the
 * note the runtime wrote for a stopped turn ("Stopped"). From then on it is set with the state, never read from the note.
 */
function addStoppedColumn(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (columns.some((c) => c.name === 'stopped')) return;
  db.exec('ALTER TABLE sessions ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0');
  db.exec("UPDATE sessions SET stopped = 1 WHERE state = 'done' AND note LIKE 'Stopped%'");
}

/** Stores written before a turn's origin was kept (Session.turnByUser): every turn counts as not the user's. */
function addTurnByUserColumn(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'turn_by_user')) db.exec('ALTER TABLE sessions ADD COLUMN turn_by_user INTEGER NOT NULL DEFAULT 0');
}

/** Stores written before review sessions (Session.review): add the column, empty (no session is a review). */
function addReviewColumn(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'review')) db.exec('ALTER TABLE sessions ADD COLUMN review TEXT');
}

/** Stores written before sidebars (Session.aside): add the column, empty (no session is one). */
function addAsideColumn(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'aside')) db.exec('ALTER TABLE sessions ADD COLUMN aside TEXT');
}

/**
 * Stores written before guests were marked on their row (Session.hostId): add the column, and fill it
 * from each guest's stored detail, where the host was kept until then.
 */
function addHostColumn(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (columns.some((c) => c.name === 'host_id')) return;
  db.exec('ALTER TABLE sessions ADD COLUMN host_id TEXT');
  db.exec("UPDATE sessions SET host_id = (SELECT json_extract(d.json, '$.guest.hostId') FROM session_detail d WHERE d.session_id = sessions.id) WHERE EXISTS (SELECT 1 FROM session_detail d WHERE d.session_id = sessions.id AND json_type(d.json, '$.guest.hostId') = 'text')");
}

/** A stored sidebar mark (JSON), or null when there is none or it is not one. */
function asideOf(raw: unknown): AsideOf | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return sanitizeAside(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** A stored review mark (JSON), or null when there is none or it is not one. */
function reviewOf(raw: unknown): ReviewMark | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return asReviewMark(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Stores written before links kept their request's state: add the column, empty (read as unknown). */
function addRequestStateColumn(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(session_requests)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'state')) db.exec('ALTER TABLE session_requests ADD COLUMN state TEXT');
}

/** A stored link row as a RequestLink; a state that is not one of ours reads as unknown. */
function requestLinkOf(r: any): RequestLink {
  const link: RequestLink = { host: r.host, number: r.number, url: r.url, branch: r.branch, linkedAt: r.linked_at };
  return isPullRequestState(r.state) ? { ...link, state: r.state } : link;
}

const PATCH_COLUMNS: Record<keyof SessionPatch, string> = {
  title: 'title',
  state: 'state',
  note: 'note',
  startedIn: 'started_in',
  startedFolderId: 'started_folder_id',
  landedIn: 'landed_in',
  worktreePath: 'worktree_path',
  branch: 'branch',
  worktreeDiscarded: 'worktree_discarded',
  groupId: 'group_id',
  updatedAt: 'updated_at',
  lastActivityAt: 'last_activity_at',
  completedAt: 'completed_at',
  stopped: 'stopped',
  turnByUser: 'turn_by_user',
};

class SqliteDriver implements LocalDriver {
  private db: DatabaseSync;
  private statements = new Map<string, StatementSync>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    addPinPositions(this.db);
    addActivityColumn(this.db);
    addCompletionColumn(this.db);
    addStoppedColumn(this.db);
    addTurnByUserColumn(this.db);
    addReviewColumn(this.db);
    addAsideColumn(this.db);
    addHostColumn(this.db);
    addGroupProjectColumn(this.db);
    addWorkstreamStateColumns(this.db);
    addRequestStateColumn(this.db);
    migrateFolders(this.db);
    // Older stores may have a groups.allow_auto column (a removed per-folder setting): it is left in place and never read or written.
  }

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) {
      statement = this.db.prepare(text);
      this.statements.set(text, statement);
    }
    return statement;
  }

  isEmpty() {
    const row = this.sql('SELECT (SELECT count(*) FROM projects) + (SELECT count(*) FROM sessions) AS n').get() as { n: number };
    return row.n === 0;
  }

  listProjects(): Project[] {
    const folders = foldersByProject(this.sql('SELECT id, project_id, path, is_git FROM project_folders ORDER BY project_id, position, rowid').all() as any[]);
    return (this.sql('SELECT id, name, default_folder_id FROM projects ORDER BY rowid').all() as any[]).map((r) => ({ id: r.id, name: r.name, folders: folders.get(r.id) ?? [], defaultFolderId: r.default_folder_id ?? null }));
  }
  /** After any change to a project's folders: a default unset or gone becomes the first, and the legacy columns follow it. */
  private settle(projectId: string) {
    this.sql(SETTLE_DEFAULT).run(projectId);
    this.sql(SYNC_LEGACY_PATH).run(projectId);
  }
  insertProject(p: Project) {
    this.sql("INSERT INTO projects (id, name, path, is_git) VALUES (?, ?, '', 0)").run(p.id, p.name);
    p.folders.forEach((f, i) => this.sql('INSERT INTO project_folders (id, project_id, path, is_git, position) VALUES (?, ?, ?, ?, ?)').run(f.id, p.id, f.path, f.isGit ? 1 : 0, i));
    this.sql('UPDATE projects SET default_folder_id = ? WHERE id = ?').run(p.defaultFolderId ?? null, p.id);
    this.settle(p.id);
  }
  insertFolder(projectId: string, f: ProjectFolder) {
    this.sql('INSERT INTO project_folders (id, project_id, path, is_git, position) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM project_folders WHERE project_id = ?))').run(f.id, projectId, f.path, f.isGit ? 1 : 0, projectId);
    this.settle(projectId);
  }
  deleteFolder(projectId: string, folderId: string) {
    const gone = this.sql('DELETE FROM project_folders WHERE project_id = ? AND id = ?').run(projectId, folderId).changes > 0;
    this.settle(projectId);
    return gone;
  }
  setFolderOrder(projectId: string, ids: readonly string[]) {
    const update = this.sql('UPDATE project_folders SET position = ? WHERE project_id = ? AND id = ?');
    ids.forEach((id, i) => update.run(i, projectId, id));
    this.settle(projectId);
  }
  setDefaultFolder(projectId: string, folderId: string) {
    this.sql('UPDATE projects SET default_folder_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM project_folders WHERE project_id = ? AND id = ?)').run(folderId, projectId, projectId, folderId);
    this.settle(projectId);
  }

  deleteProject(id: string) {
    return this.sql('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  }
  renameProject(id: string, name: string) {
    return this.sql('UPDATE projects SET name = ? WHERE id = ?').run(name, id).changes > 0;
  }
  /** Links and the stored conversation go with it (ON DELETE CASCADE). */
  deleteSession(id: string) {
    return this.sql('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
  }
  getSetting(key: string) {
    return (this.sql('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }
  putSetting(key: string, value: string) {
    this.sql('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  listGroups(): Group[] {
    return (this.sql('SELECT * FROM groups ORDER BY created_at, rowid').all() as any[]).map((r) => ({ id: r.id, name: r.name, auto: !!r.auto, createdAt: r.created_at, projectId: r.project_id ?? null }));
  }
  insertGroup(g: Group) {
    this.sql('INSERT INTO groups (id, name, auto, created_at, project_id) VALUES (?, ?, ?, ?, ?)').run(g.id, g.name, g.auto ? 1 : 0, g.createdAt, g.projectId ?? null);
  }
  renameGroup(id: string, name: string) {
    return this.sql('UPDATE groups SET name = ? WHERE id = ?').run(name, id).changes > 0;
  }
  setGroupProject(id: string, projectId: string | null) {
    return this.sql('UPDATE groups SET project_id = ? WHERE id = ?').run(projectId, id).changes > 0;
  }
  deleteGroup(id: string) {
    this.sql('DELETE FROM groups WHERE id = ?').run(id);
  }

  listSessions(): Session[] {
    return (this.sql('SELECT * FROM sessions ORDER BY created_at, rowid').all() as any[]).map(rowToSession);
  }
  getSession(id: string) {
    const row = this.sql('SELECT * FROM sessions WHERE id = ?').get(id);
    return row ? rowToSession(row) : null;
  }
  insertSession(s: Session) {
    this.sql(
      'INSERT INTO sessions (id, title, agent, state, note, started_in, started_folder_id, landed_in, worktree_path, branch, worktree_discarded, group_id, created_at, updated_at, last_activity_at, completed_at, stopped, turn_by_user, review, aside, host_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(s.id, s.title, s.agent, s.state, s.note, s.startedIn, s.startedFolderId ?? null, s.landedIn, s.worktreePath, s.branch, s.worktreeDiscarded ? 1 : 0, s.groupId, s.createdAt, s.updatedAt, s.lastActivityAt ?? null, s.completedAt ?? null, s.stopped ? 1 : 0, s.turnByUser ? 1 : 0, s.review ? JSON.stringify(s.review) : null, s.aside ? JSON.stringify(s.aside) : null, s.hostId ?? null);
  }
  updateSession(id: string, patch: SessionPatch) {
    const keys = (Object.keys(patch) as (keyof SessionPatch)[]).filter((k) => patch[k] !== undefined);
    if (keys.length === 0) return this.getSession(id) !== null;
    const values = keys.map((k) => (typeof patch[k] === 'boolean' ? (patch[k] ? 1 : 0) : (patch[k] as string | number | null)));
    // Column names come from the fixed map above, never from input.
    const text = `UPDATE sessions SET ${keys.map((k) => `${PATCH_COLUMNS[k]} = ?`).join(', ')} WHERE id = ?`;
    return this.sql(text).run(...values, id).changes > 0;
  }
  setSessionsGroup(ids: readonly string[], groupId: string | null, updatedAt: number) {
    const statement = this.sql('UPDATE sessions SET group_id = ?, updated_at = ? WHERE id = ?');
    for (const id of ids) statement.run(groupId, updatedAt, id);
  }
  markRunningInterrupted() {
    return Number(this.sql("UPDATE sessions SET state = 'interrupted' WHERE state = 'running'").run().changes);
  }

  listLinks(): Link[] {
    return (this.sql('SELECT * FROM links ORDER BY rowid').all() as any[]).map((r) => ({ id: r.id, parentId: r.parent_id, childId: r.child_id, kind: r.kind as LinkKind }));
  }
  insertLink(l: Link) {
    this.sql('INSERT INTO links (id, parent_id, child_id, kind) VALUES (?, ?, ?, ?)').run(l.id, l.parentId, l.childId, l.kind);
  }

  listTags(): TagRow[] {
    return (this.sql('SELECT session_id, tag FROM session_tags ORDER BY session_id, position').all() as any[]).map((r) => ({ sessionId: r.session_id, tag: r.tag }));
  }
  tagsOf(sessionId: string): string[] {
    return (this.sql('SELECT tag FROM session_tags WHERE session_id = ? ORDER BY position').all(sessionId) as any[]).map((r) => r.tag);
  }
  setTags(sessionId: string, tags: readonly string[]) {
    this.sql('DELETE FROM session_tags WHERE session_id = ?').run(sessionId);
    const insert = this.sql('INSERT INTO session_tags (session_id, position, tag) VALUES (?, ?, ?)');
    tags.forEach((tag, i) => insert.run(sessionId, i, tag));
  }

  listWorkstreams(): Workstream[] {
    const members = new Map<string, string[]>();
    for (const r of this.sql('SELECT workstream_id, session_id FROM workstream_sessions ORDER BY workstream_id, position').all() as any[]) members.set(r.workstream_id, [...(members.get(r.workstream_id) ?? []), r.session_id]);
    return (this.sql('SELECT * FROM workstreams ORDER BY created_at, rowid').all() as any[]).map((r) => ({ id: r.id, name: r.name, objective: r.objective, createdAt: r.created_at, sessionIds: members.get(r.id) ?? [], status: r.status === 'complete' ? 'complete' : 'active', archivedAt: typeof r.archived_at === 'number' ? r.archived_at : null }));
  }
  insertWorkstream(w: Workstream) {
    this.sql('INSERT INTO workstreams (id, name, objective, created_at, status, archived_at) VALUES (?, ?, ?, ?, ?, ?)').run(w.id, w.name, w.objective, w.createdAt, w.status ?? 'active', w.archivedAt ?? null);
    this.setWorkstreamSessions(w.id, w.sessionIds);
  }
  updateWorkstream(id: string, patch: WorkstreamPatch) {
    const found = this.sql('SELECT 1 FROM workstreams WHERE id = ?').get(id) !== undefined;
    if (patch.name !== undefined) this.sql('UPDATE workstreams SET name = ? WHERE id = ?').run(patch.name, id);
    if (patch.objective !== undefined) this.sql('UPDATE workstreams SET objective = ? WHERE id = ?').run(patch.objective, id);
    if (patch.status !== undefined) this.sql('UPDATE workstreams SET status = ? WHERE id = ?').run(patch.status, id);
    if (patch.archivedAt !== undefined) this.sql('UPDATE workstreams SET archived_at = ? WHERE id = ?').run(patch.archivedAt, id);
    return found;
  }
  setWorkstreamSessions(id: string, sessionIds: readonly string[]) {
    this.sql('DELETE FROM workstream_sessions WHERE workstream_id = ?').run(id);
    const insert = this.sql('INSERT INTO workstream_sessions (workstream_id, session_id, position) VALUES (?, ?, ?)');
    sessionIds.forEach((sessionId, i) => insert.run(id, sessionId, i));
  }
  deleteWorkstream(id: string) {
    this.sql('DELETE FROM workstreams WHERE id = ?').run(id);
  }
  listWaits(): SessionWait[] {
    return (this.sql('SELECT * FROM session_waits ORDER BY created_at, rowid').all() as any[]).map((r) => ({ workstreamId: r.workstream_id, waiterId: r.waiter_id, targetId: r.target_id, reason: r.reason, createdAt: r.created_at }));
  }
  putWait(w: SessionWait) {
    this.sql('INSERT INTO session_waits (workstream_id, waiter_id, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(waiter_id, target_id) DO UPDATE SET workstream_id = excluded.workstream_id, reason = excluded.reason, created_at = excluded.created_at').run(w.workstreamId, w.waiterId, w.targetId, w.reason, w.createdAt);
  }
  deleteWait(waiterId: string, targetId: string) {
    return this.sql('DELETE FROM session_waits WHERE waiter_id = ? AND target_id = ?').run(waiterId, targetId).changes > 0;
  }
  deleteWaitsOf(sessionId: string) {
    this.sql('DELETE FROM session_waits WHERE waiter_id = ? OR target_id = ?').run(sessionId, sessionId);
  }

  listPins(): Pin[] {
    return (this.sql('SELECT kind, id, pinned_at FROM pins ORDER BY position, pinned_at, rowid').all() as any[]).map((r) => ({ kind: r.kind as PinKind, id: r.id, pinnedAt: r.pinned_at }));
  }
  putPin(p: Pin) {
    this.sql('INSERT INTO pins (kind, id, pinned_at, position) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM pins)) ON CONFLICT(kind, id) DO NOTHING').run(p.kind, p.id, p.pinnedAt);
  }
  setPinOrder(order: readonly PinRef[]) {
    const update = this.sql('UPDATE pins SET position = ? WHERE kind = ? AND id = ?');
    order.forEach((pin, i) => update.run(i, pin.kind, pin.id));
  }
  deletePin(kind: PinKind, id: string) {
    return this.sql('DELETE FROM pins WHERE kind = ? AND id = ?').run(kind, id).changes > 0;
  }

  getDetail(sessionId: string): StoredDetail | null {
    const row = this.sql('SELECT json FROM session_detail WHERE session_id = ?').get(sessionId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as StoredDetail) : null;
  }
  putDetail(sessionId: string, detail: StoredDetail) {
    this.sql('INSERT INTO session_detail (session_id, json) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET json = excluded.json').run(sessionId, JSON.stringify(detail));
  }

  listRequestLinks(sessionId: string): RequestLink[] {
    return (this.sql('SELECT host, number, url, branch, linked_at, state FROM session_requests WHERE session_id = ? ORDER BY rowid').all(sessionId) as any[]).map(requestLinkOf);
  }
  listAllRequestLinks(): SessionRequestLink[] {
    return (this.sql('SELECT session_id, host, number, url, branch, linked_at, state FROM session_requests ORDER BY rowid').all() as any[]).map((r) => ({ ...requestLinkOf(r), sessionId: r.session_id }));
  }
  insertRequestLink(sessionId: string, l: RequestLink) {
    const insert = 'INSERT INTO session_requests (session_id, host, number, url, branch, linked_at, state) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, host, number) DO NOTHING';
    return this.sql(insert).run(sessionId, l.host, l.number, l.url, l.branch, l.linkedAt, l.state ?? null).changes > 0;
  }
  setRequestState(sessionId: string, host: HostKind, number: number, state: PullRequestState) {
    const update = 'UPDATE session_requests SET state = ? WHERE session_id = ? AND host = ? AND number = ? AND state IS NOT ?';
    return this.sql(update).run(state, sessionId, host, number, state).changes > 0;
  }

  begin() {
    this.db.exec('BEGIN IMMEDIATE');
  }
  commit() {
    this.db.exec('COMMIT');
  }
  rollback() {
    this.db.exec('ROLLBACK');
  }
  close() {
    this.statements.clear();
    this.db.close();
  }
}

function rowToSession(r: any): Session {
  const review = reviewOf(r.review);
  const aside = asideOf(r.aside);
  return {
    id: r.id,
    title: r.title,
    agent: r.agent,
    state: r.state,
    note: r.note,
    startedIn: r.started_in,
    startedFolderId: r.started_folder_id ?? null,
    landedIn: r.landed_in,
    worktreePath: r.worktree_path,
    branch: r.branch,
    worktreeDiscarded: !!r.worktree_discarded,
    groupId: r.group_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(typeof r.completed_at === 'number' ? { completedAt: r.completed_at } : {}),
    ...(typeof r.last_activity_at === 'number' ? { lastActivityAt: r.last_activity_at } : {}),
    ...(r.stopped ? { stopped: true } : {}),
    ...(r.turn_by_user ? { turnByUser: true } : {}),
    ...(review ? { review } : {}),
    ...(aside ? { aside } : {}),
    ...(typeof r.host_id === 'string' && r.host_id ? { hostId: r.host_id } : {}),
  };
}

export function sqlitePersistence(path = ':memory:'): Persistence {
  return createLocalPersistence(new SqliteDriver(path));
}
