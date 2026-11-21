// A project's directories in SQLite, and bringing older stores up to them. Before projects could
// have several directories, a project was one folder (`projects.path`, `projects.is_git`). Such a
// store gets one `project_folders` row per project, with the project's own id as the directory's,
// so every session, pin, setup and filing that names the project keeps working. The old columns are
// kept, written with the default directory, so an older Kestrel can still open the store.
//
// The default folder is stored explicitly (`projects.default_folder_id`); order carries no meaning.
// A store from before it (either shape) gets the first folder as its default. Whenever folders
// change, a default that is unset or gone falls back to the first.
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectFolder } from '../model.ts';

export const FOLDERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS project_folders (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL, is_git INTEGER NOT NULL, position INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS project_folders_project ON project_folders(project_id, position);
`;

const tableExists = (db: DatabaseSync, name: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
const hasColumn = (db: DatabaseSync, table: string, column: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);

/**
 * Create the directories table, and for a store from before it, give each project its folder as
 * its one directory. Run before anything reads projects. Returns whether it migrated.
 */
export function migrateFolders(db: DatabaseSync): boolean {
  // One transaction: a store must never be left with the table made and the folders not copied.
  db.exec('BEGIN IMMEDIATE');
  try {
    const before = tableExists(db, 'project_folders');
    db.exec(FOLDERS_SCHEMA);
    if (!hasColumn(db, 'sessions', 'started_folder_id')) db.exec('ALTER TABLE sessions ADD COLUMN started_folder_id TEXT');
    if (!before) db.exec("INSERT INTO project_folders (id, project_id, path, is_git, position) SELECT id, id, path, is_git, 0 FROM projects WHERE path <> ''");
    if (!hasColumn(db, 'projects', 'default_folder_id')) db.exec('ALTER TABLE projects ADD COLUMN default_folder_id TEXT');
    db.exec(SETTLE_ALL_DEFAULTS);
    db.exec('COMMIT');
    return !before;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const FIRST_FOLDER = '(SELECT id FROM project_folders WHERE project_id = projects.id ORDER BY position, rowid LIMIT 1)';
const DEFAULT_GONE = 'default_folder_id IS NULL OR NOT EXISTS (SELECT 1 FROM project_folders WHERE project_id = projects.id AND id = projects.default_folder_id)';

/** Every project whose default is unset or gone gets its first folder (null when it has none). */
const SETTLE_ALL_DEFAULTS = `UPDATE projects SET default_folder_id = ${FIRST_FOLDER} WHERE ${DEFAULT_GONE}`;

/** One project's default settled the same way. */
export const SETTLE_DEFAULT = `UPDATE projects SET default_folder_id = ${FIRST_FOLDER} WHERE id = ? AND (${DEFAULT_GONE})`;

/** The legacy one-folder columns, kept equal to the default folder (empty when there is none). Run after SETTLE_DEFAULT. */
export const SYNC_LEGACY_PATH = `UPDATE projects SET
  path = COALESCE((SELECT path FROM project_folders WHERE project_id = projects.id AND id = projects.default_folder_id), ''),
  is_git = COALESCE((SELECT is_git FROM project_folders WHERE project_id = projects.id AND id = projects.default_folder_id), 0)
  WHERE id = ?`;

/** Every project's directories, by project id, in order. */
export function foldersByProject(rows: readonly { id: string; project_id: string; path: string; is_git: number }[]): Map<string, ProjectFolder[]> {
  const map = new Map<string, ProjectFolder[]>();
  for (const r of rows) map.set(r.project_id, [...(map.get(r.project_id) ?? []), { id: r.id, path: r.path, isGit: !!r.is_git }]);
  return map;
}
