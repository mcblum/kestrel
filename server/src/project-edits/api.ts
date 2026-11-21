// HTTP route for Settings → Workflow → "Keep each project's edits in its own session". Shaped like
// git-settings/api.ts: the caller hands over the path parts and a body reader, and gets an answer,
// or null when the path is not this one.
//
//   GET   /api/project-edits                            200 { keepInProject }
//   PATCH /api/project-edits  { keepInProject: boolean } 200 { keepInProject } | 400 { error }
import type { ProjectEdits } from './prefs.ts';

export type ProjectEditsAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

export async function projectEditsRoute(parts: readonly string[], method: string, readBody: ReadBody, edits: ProjectEdits): Promise<ProjectEditsAnswer | null> {
  if (parts[1] !== 'project-edits' || parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: await edits.prefs() };
  if (method !== 'PATCH') return null;
  const body = await readBody();
  if (typeof body.keepInProject !== 'boolean') return { status: 400, body: { error: 'keepInProject must be true or false.' } };
  return { status: 200, body: await edits.setKeepInProject(body.keepInProject) };
}
