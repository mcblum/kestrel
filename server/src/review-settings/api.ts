// HTTP route for Settings → Git → Review requests (shared/review-settings.ts). The UI's only; no
// Kestrel tool reaches it, so no agent can let itself start reviews.
//
//   GET /api/review-settings                                   200 ReviewSettings
//   PUT /api/review-settings  { mode?, projects?, confirmed? } 200 ReviewSettings | 400 { error }
//
// `mode: "reply"` posts in the user's name, so it is stored only with `confirmed: true`: the
// warning was shown and agreed to.
//
// `projects` is "all" or a list of project ids; ids of projects that are not registered are dropped.
import { asReviewProjects, REVIEW_MODES, type ReviewMode, type ReviewSettings } from '../shared/review-settings.ts';
import type { ReviewPrefs } from './prefs.ts';

export type ReviewSettingsAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;
type ProjectsSource = { state(): Promise<{ projects: readonly { id: string }[] }> };

const bad = (error: string): ReviewSettingsAnswer => ({ status: 400, body: { error } });

export async function reviewSettingsRoute(parts: readonly string[], method: string, readBody: ReadBody, workspace: ProjectsSource, prefs: ReviewPrefs): Promise<ReviewSettingsAnswer | null> {
  if (parts[1] !== 'review-settings' || parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: await prefs.current() };
  if (method !== 'PUT') return null;
  const body = await readBody();
  let change: Partial<ReviewSettings> = {};
  if (body.mode !== undefined) {
    if (!REVIEW_MODES.includes(body.mode as ReviewMode)) return bad(`mode must be one of: ${REVIEW_MODES.join(', ')}.`);
    if (body.mode === 'reply' && body.confirmed !== true) return bad('Posting reviews without showing them first has to be confirmed.');
    change = { ...change, mode: body.mode as ReviewMode };
  }
  if (body.projects !== undefined) {
    const projects = asReviewProjects(body.projects);
    if (!projects) return bad('projects must be "all" or a list of project ids.');
    const registered = new Set((await workspace.state()).projects.map((p) => p.id));
    change = { ...change, projects: projects === 'all' ? 'all' : projects.filter((id) => registered.has(id)) };
  }
  if (body.mode === undefined && body.projects === undefined) return bad('Give a mode, a choice of projects, or both.');
  return { status: 200, body: await prefs.set(change) };
}
