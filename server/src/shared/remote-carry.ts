// How much of a session's page is carried from the computer it runs on to another desktop that shows it (account-
// sessions.md, "A session on another computer drawn as one here, as built"). A frame between two devices is sealed and
// sent whole, so what one answer carries is bounded here, once, for the computer that sends and the one that shows.
// What is left behind is said in the pane, naming where it is. Pure.
import type { ChangedFile } from '../model.ts';

/** One file's diff carried at most this long (characters); a longer one stays where the session runs. */
export const DIFF_CARRY_MAX = 512 * 1024;
/** All of a session's diffs together carried at most this long; the files past it keep their names and lose their diffs. */
export const DIFFS_CARRY_MAX = 8 * 1024 * 1024;
/** A document tab's file or a picture carried at most this large (bytes). */
export const FILE_CARRY_MAX = 10 * 1024 * 1024;

/** The changed files as carried: every name and status, each diff while it fits, `heldBack` where it did not. */
export function carriedFiles(files: readonly ChangedFile[]): ChangedFile[] {
  let total = 0;
  return files.map((file) => {
    const size = file.diff.length;
    if (size <= DIFF_CARRY_MAX && total + size <= DIFFS_CARRY_MAX) {
      total += size;
      return file;
    }
    return { path: file.path, status: file.status, diff: '', heldBack: size };
  });
}

/** What the pane says where something was too large to bring over: what, and where it is. */
export function tooLargeToBring(what: string, machine: string): string {
  return `${what} is too large to bring over from ${machine}. It is on ${machine}.`;
}
