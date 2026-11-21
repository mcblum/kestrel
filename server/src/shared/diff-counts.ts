// Lines added and removed, counted one way for everything that shows them: the session bar, the
// Details pane and the session's hover card (through the change counts the server sends).

/** Lines added and removed across unified diffs, not counting the file headers. */
export function diffCounts(diffs: readonly string[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const diff of diffs)
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
  return { added, removed };
}
