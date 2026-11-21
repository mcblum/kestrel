// Making a picture small enough for the API, with macOS's own `sips` (on every Mac, no extra
// dependency). Elsewhere, or when it fails, there is no smaller copy and the picture is sent to
// the agent as a file instead (content.ts).
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A smaller copy of a picture under `maxBytes`, or null when none can be made. */
export type Downscale = (file: string, maxBytes: number) => Promise<{ mediaType: string; data: Buffer } | null>;

/** Longest edge of the smaller copy; the API scales anything larger down anyway. */
export const DOWNSCALE_MAX_EDGE = 2048;
const JPEG_QUALITY = 80;
const SIPS_TIMEOUT_MS = 30_000;

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(command, args, { timeout: SIPS_TIMEOUT_MS }, (error) => (error ? reject(error) : resolve())));
}

export const downscaleWithSips: Downscale = async (file, maxBytes) => {
  if (process.platform !== 'darwin') return null;
  const dir = await mkdtemp(join(tmpdir(), 'kestrel-image-'));
  const out = join(dir, 'small.jpg');
  try {
    await run('/usr/bin/sips', ['-Z', String(DOWNSCALE_MAX_EDGE), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(JPEG_QUALITY), file, '--out', out]);
    const data = await readFile(out);
    return data.length > 0 && data.length <= maxBytes ? { mediaType: 'image/jpeg', data } : null;
  } catch (error) {
    console.error('[kestrel] could not make a picture smaller', error);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
