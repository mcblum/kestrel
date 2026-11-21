// Browser-safe helpers for showing and searching projects (no node imports: the UI uses this).

export interface SearchableProject {
  name: string;
  folders: readonly { path: string }[];
}

/** Projects whose name or one of whose directories' paths contains every word typed (any case); all of them for an empty query. */
export function filterProjects<P extends SearchableProject>(projects: readonly P[], query: string): P[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = (p: P) => [p.name, ...p.folders.map((f) => f.path)].join('\n').toLowerCase();
  return projects.filter((p) => words.every((w) => text(p).includes(w)));
}

/** A path under a user's home directory as `~/…`, for display (macOS and Linux layouts). */
export function tildePath(path: string): string {
  return path.replace(/^(?:\/Users|\/home)\/[^/]+(?=\/|$)/, '~');
}
