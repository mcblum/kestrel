// A release's notes, from the one source: whats-new/<release>.md, the same file the app shows on its
// What's new page (server/src/shared/whats-new.ts reads it for both).
//
//   node scripts/release/release-notes.mjs check <version>   exit 0 when the version may be released, 1 with the reason
//   node scripts/release/release-notes.mjs body <version>    the notes as the release on the host shows them
//
// A release (1.2.3) must have whats-new/1.2.3.md with a title line and something under it: preflight
// asks first, so a release without notes stops before anything is built. A beta (1.2.3-beta.4) shows
// its release's notes when there are some, and publishes as before when there are none.
// `--dir <folder>` reads another folder (the tests).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostNotes, notesFileName, parseNotes, releaseOf } from '../../server/src/shared/whats-new.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const dirAt = args.indexOf('--dir');
const dir = dirAt >= 0 ? args.splice(dirAt, 2)[1] : join(root, 'whats-new');
const [command, version = ''] = args;

/** The notes of a version: { parsed } or { missing } or { error }, with the file's path as the repository names it. */
function notesOf(v) {
  const release = releaseOf(v);
  if (!release) return { error: `${v || 'no version'} is not a version that can be released (1.2.3 or 1.2.3-beta.4)` };
  const file = join(dir, notesFileName(release));
  const shown = `whats-new/${notesFileName(release)}`;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { missing: shown, release };
  }
  const parsed = parseNotes(text);
  return 'error' in parsed ? { error: `${shown} cannot be used: ${parsed.error}` } : { parsed, shown, release };
}

const beta = /-beta\.\d+$/.test(version);
const notes = notesOf(version);

switch (command) {
  case 'check':
    if (notes.error) {
      console.error(`!! ${notes.error}`);
      process.exit(1);
    }
    if (notes.missing) {
      if (beta) {
        console.log(`no ${notes.missing}: the beta publishes as before, and its What's new page shows nothing`);
        process.exit(0);
      }
      console.error(`!! Kestrel ${version} has no release notes: write ${notes.missing} (a "# " title line, then a few sections for people who use the app) and commit it before releasing`);
      process.exit(1);
    }
    console.log(`${notes.shown}: “${notes.parsed.title}”`);
    process.exit(0);
  case 'body':
    if (notes.error || notes.missing) {
      console.error(`!! ${notes.error ?? `no ${notes.missing}`}`);
      process.exit(1);
    }
    console.log(hostNotes(notes.parsed));
    process.exit(0);
  default:
    console.error('usage: release-notes.mjs check|body <version> [--dir <folder>]');
    process.exit(2);
}
