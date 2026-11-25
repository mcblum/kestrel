// The notes this copy carries: the `whats-new/` folder of the repository, shipped inside the app
// (app/scripts/package/stage.mjs puts it beside the server; the shell names it in
// KESTREL_WHATS_NEW_DIR). Read when asked, never from the network, so the page works offline. A
// file that is not a release's notes (shared/whats-new.ts `parseNotes`) is left out, not an error.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareReleases, isRelease, notesFileName, parseNotes, releaseOfFile, type WhatsNewEntry, type WhatsNewNotes } from '../shared/whats-new.ts';

/** The hash of a notes file: what "shown" remembers, so a changed file opens again. */
export const notesHash = (text: string): string => createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex').slice(0, 32);

export interface NotesSource {
  /** Every release with notes, newest first. */
  list(): Promise<WhatsNewEntry[]>;
  /** One release's notes, or null when there are none. */
  read(release: string): Promise<WhatsNewNotes | null>;
  /** The folder pictures are read from. */
  readonly dir: string;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.code === 'ENOTDIR';

export function notesSource(dir: string): NotesSource {
  const read = async (release: string): Promise<WhatsNewNotes | null> => {
    if (!isRelease(release)) return null;
    let text: string;
    try {
      text = await readFile(join(dir, notesFileName(release)), 'utf8');
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    const parsed = parseNotes(text);
    return 'error' in parsed ? null : { release, title: parsed.title, body: parsed.body, hash: notesHash(text) };
  };
  return {
    dir,
    read,
    async list() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
      const releases = names.flatMap((n) => releaseOfFile(n) ?? []).sort(compareReleases);
      const notes = await Promise.all(releases.map(read));
      return notes.flatMap((n) => (n ? [{ release: n.release, title: n.title }] : []));
    },
  };
}
