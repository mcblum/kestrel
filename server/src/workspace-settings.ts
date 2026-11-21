// Workspace data kept as settings: what is archived, and each project's agent setup.
import { NOTHING_ARCHIVED, sanitizeArchived, setArchived, type ArchiveKind, type Archived } from './shared/archive.ts';
import { sanitizeSetup, type ProjectSetup } from './shared/setup.ts';
import { Refused } from './refused.ts';
import type { Persistence } from './persistence/types.ts';

export async function readArchived(db: Persistence): Promise<Archived> {
  const raw = await db.getSetting('archived');
  try {
    return sanitizeArchived(raw ? JSON.parse(raw) : null);
  } catch {
    return NOTHING_ARCHIVED;
  }
}

export function saveArchived(db: Persistence, next: Archived): Promise<void> {
  return db.putSetting('archived', JSON.stringify(next));
}

/** Takes something deleted off the archive list; writes only when it was on it. Call inside the deleting transaction. */
export async function unarchive(tx: Persistence, kind: ArchiveKind, id: string): Promise<void> {
  const current = await readArchived(tx);
  const next = setArchived(current, kind, id, false);
  if (next !== current) await saveArchived(tx, next);
}

// ---- what of the user's agent setup each project's sessions get -------------------------

export interface SetupChoice {
  setup: ProjectSetup;
  inherits: boolean;
}

/** The key the defaults are stored under, beside the per-project overrides. Not a project id. */
const DEFAULTS = '*';

async function allSetups(db: Persistence): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse((await db.getSetting('project-setup')) ?? '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function defaultSetup(db: Persistence): Promise<ProjectSetup> {
  return sanitizeSetup((await allSetups(db))[DEFAULTS]);
}

// Setup is not part of the pushed workspace state: the UI asks for it by route (`useResource`, asked
// again whenever a setup view opens) and a save writes the server's answer back into that entry, so
// these writes call no `changed()`. The setting holds every project's setup in one value, so each
// read-modify-write runs in one transaction and two saves cannot drop each other's change.

export async function setDefaultSetup(db: Persistence, setup: unknown): Promise<ProjectSetup> {
  const next = sanitizeSetup(setup);
  await db.transaction(async (tx) => tx.putSetting('project-setup', JSON.stringify({ ...(await allSetups(tx)), [DEFAULTS]: next })));
  return next;
}

export async function projectSetup(db: Persistence, projectId: string | null): Promise<SetupChoice> {
  const all = await allSetups(db);
  const own = projectId ? all[projectId] : undefined;
  return own === undefined ? { setup: sanitizeSetup(all[DEFAULTS]), inherits: true } : { setup: sanitizeSetup(own), inherits: false };
}

export function setProjectSetup(db: Persistence, projectId: string, setup: unknown | null): Promise<SetupChoice> {
  return db.transaction(async (tx) => {
    if (!(await tx.listProjects()).some((p) => p.id === projectId)) throw new Refused('No such project.');
    const { [projectId]: _old, ...others } = await allSetups(tx);
    const all = setup === null ? others : { ...others, [projectId]: sanitizeSetup(setup) };
    await tx.putSetting('project-setup', JSON.stringify(all));
    return projectSetup(tx, projectId);
  });
}
