// Settings → General → "Get beta versions": where the choice is kept, and what it means for this
// copy. The updater runs in the shell, before and apart from the server, so the choice is a small
// JSON file in the shell's own userData folder (~/Library/Application Support/Kestrel/
// update-channel.json on a Mac; KESTREL_APP_USER_DATA moves it with the rest), not in the server's
// database. The page reads it and changes it only through the shell (preload.cjs), never directly.
//
// No file, or no choice in it, means the default: on for a beta build, off for a release
// (release-channel.mjs, wantsBeta). So the first beta, installed by hand on a computer whose stable
// copy had no switch, comes up on the beta channel by itself. No Electron import, so it is tested.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { channelOf, isVersion, wantsBeta } from './release-channel.mjs';

export const CHANNEL_FILE = 'update-channel.json';

/** @param {string} userData the shell's userData folder */
export const channelFile = (userData) => join(userData, CHANNEL_FILE);

/** What was saved, or null when nothing was (or the file cannot be read: the default then applies). */
export function readSaved(file) {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    return saved && typeof saved === 'object' ? saved : null;
  } catch {
    return null;
  }
}

/**
 * This copy's update channel, as the page shows it.
 * @param {string} version this copy's own version
 * @param {{ beta?: unknown } | null} saved
 * @returns {{ beta: boolean, build: 'stable' | 'beta' }} whether it takes betas, and what it is itself
 */
export function channelInfo(version, saved) {
  return { beta: wantsBeta(version, saved), build: isVersion(version) ? channelOf(version) : 'stable' };
}

/** Saves the choice. Throws with the reason when it cannot be written, so the switch says so. */
export function saveChoice(file, beta) {
  if (typeof beta !== 'boolean') throw new Error('The beta choice must be on or off.');
  writeFileSync(file, `${JSON.stringify({ beta })}\n`);
}
