// Finding, and if need be building, `kestrel-sim`: the small Swift program that sends touches to
// a simulator and streams its screen (source in app/native/simhelper/). It is built with Xcode's
// own compiler the first time it is needed and kept under the data folder, named after a hash of
// its source, so a changed source is rebuilt. `KESTREL_SIM_HELPER` points at a ready-made binary
// (a packaged release ships one).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Runner } from './sim-process.ts';

export const HELPER_SOURCE = fileURLToPath(new URL('../../app/native/simhelper/', import.meta.url));
const BUILD_TIMEOUT_MS = 180_000;

export type HelperOutcome = { ok: true; path: string } | { ok: false; reason: string };

export class SimHelper {
  private building: Promise<HelperOutcome> | null = null;

  constructor(
    private readonly run: Runner,
    private readonly dataDir: string,
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly sourceDir: string = HELPER_SOURCE,
  ) {}

  /** The helper's path, building it once if needed. Never rejects; a failed build says why and is tried again next time. */
  ensure(): Promise<HelperOutcome> {
    const given = this.env.KESTREL_SIM_HELPER;
    if (given) return Promise.resolve(existsSync(given) ? { ok: true, path: given } : { ok: false, reason: `KESTREL_SIM_HELPER points at ${given}, which does not exist.` });
    this.building ??= this.build().then((outcome) => {
      if (!outcome.ok) this.building = null;
      return outcome;
    });
    return this.building;
  }

  private sources(): string[] {
    if (!existsSync(this.sourceDir)) return [];
    return readdirSync(this.sourceDir).filter((f) => f.endsWith('.swift')).sort().map((f) => join(this.sourceDir, f));
  }

  private async build(): Promise<HelperOutcome> {
    const files = this.sources();
    if (!files.length) return { ok: false, reason: `The simulator helper's source is missing (${this.sourceDir}).` };
    const hash = createHash('sha256');
    for (const f of files) hash.update(readFileSync(f));
    const dir = join(this.dataDir, 'bin');
    const path = join(dir, `kestrel-sim-${hash.digest('hex').slice(0, 12)}`);
    if (existsSync(path)) return { ok: true, path };
    mkdirSync(dir, { recursive: true });
    const partial = `${path}.building`;
    const built = await this.run('xcrun', ['swiftc', '-O', '-swift-version', '5', ...files, '-o', partial], { timeoutMs: BUILD_TIMEOUT_MS });
    if (built.code !== 0) {
      const why = built.code === -1 && /ENOENT/.test(built.stderr) ? 'xcrun was not found: install Xcode.' : (built.stderr.split('\n').find((l) => /error/i.test(l)) ?? built.stderr).slice(0, 400);
      return { ok: false, reason: `The simulator helper could not be built: ${why || `swiftc exited with ${built.code}`}` };
    }
    renameSync(partial, path);
    return { ok: true, path };
  }
}
