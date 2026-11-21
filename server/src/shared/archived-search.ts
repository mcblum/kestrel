// Settings → Archived: which archived rows a typed search shows. Pure. Every word typed must appear
// in a row's name, its detail (a session's project, a project's folder) or its kind, in any order,
// ignoring case. Nothing typed shows every row, in the order given.

export interface ArchivedRow {
  kind: string;
  name: string;
  detail: string;
}

export function matchingArchived<T extends ArchivedRow>(rows: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const text = `${row.name} ${row.detail} ${row.kind}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
