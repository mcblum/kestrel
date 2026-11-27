// Installs gh or glab into Kestrel's tools folder on a node (`~/.kestrel/tools/bin`; shared/node-git-tools.ts), at the
// pinned version, never globally and never with an administrator. The archive is fetched (https, or a file: address in
// tests), its SHA-256 compared with the pin before anything is unpacked, unpacked with `tar` into a hidden folder of
// its own beside the tools, and only the program is moved into place, by a rename. A mismatch, a failed download or an
// archive without the program leaves nothing behind. Afterwards the program is asked its version: a program that does
// not say the pinned one is taken out again.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolsBin, toolsFolder } from '../agents/kestrel-agents.ts';
import { lastLineOf } from '../shared/node-agents.ts';
import { toolArchOf, toolVersionFrom, type GitTool, type ToolPins } from '../shared/node-git-tools.ts';
import type { RunProgram } from './agents-programs.ts';

type Env = Record<string, string | undefined>;

export type ToolInstall = { ok: true; version: string; path: string } | { ok: false; reason: string };

export interface ToolInstallContext {
  dataDir: string;
  pins: ToolPins;
  arch: string;
  env: Env;
  run: RunProgram;
  /** The archive's bytes. Defaults to `fetchArchive`. */
  fetch?: (url: string) => Promise<Buffer>;
}

const DOWNLOAD_MS = 5 * 60_000;
const QUICK_MS = 20_000;

/** The archive's bytes from an https address (following the release's redirects) or a file: address. */
export async function fetchArchive(url: string): Promise<Buffer> {
  if (url.startsWith('file:')) return readFileSync(fileURLToPath(url));
  if (!url.startsWith('https:')) throw new Error(`Only https addresses are fetched, not ${url}.`);
  const answer = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_MS) });
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}.`);
  return Buffer.from(await answer.arrayBuffer());
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The program's path in Kestrel's tools folder. */
export const toolPath = (dataDir: string, tool: GitTool): string => join(toolsBin(dataDir), tool);

export async function installTool(tool: GitTool, ctx: ToolInstallContext): Promise<ToolInstall> {
  const arch = toolArchOf(ctx.arch);
  if (!arch) return { ok: false, reason: `${tool} is not pinned for ${ctx.arch}; only x64 and arm64 are.` };
  const pin = ctx.pins[tool];
  const asset = pin.assets[arch];
  let bytes: Buffer;
  try {
    bytes = await (ctx.fetch ?? fetchArchive)(asset.url);
  } catch (error) {
    return { ok: false, reason: `${tool} ${pin.version} could not be downloaded: ${reasonOf(error)} Nothing was installed.` };
  }
  const sum = createHash('sha256').update(bytes).digest('hex');
  if (sum !== asset.sha256) return { ok: false, reason: `The download of ${tool} ${pin.version} is not the published one (its SHA-256 is ${sum}, the release says ${asset.sha256}). Nothing was installed.` };

  const folder = toolsFolder(ctx.dataDir);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(folder, `.${tool}-`));
  try {
    const archive = join(work, 'archive.tar.gz');
    writeFileSync(archive, bytes, { mode: 0o600 });
    const unpacked = join(work, 'unpacked');
    mkdirSync(unpacked);
    const tar = await ctx.run('tar', ['-xzf', archive, '-C', unpacked, '--no-same-owner'], { env: ctx.env, cwd: work, quiet: true, timeoutMs: QUICK_MS * 3 });
    const program = join(unpacked, asset.inArchive);
    if (tar.code !== 0 || !existsSync(program)) return { ok: false, reason: `The ${tool} ${pin.version} archive could not be unpacked${tar.code !== 0 ? `: ${lastLineOf(tar.output) ?? `tar ended with exit code ${tar.code}`}` : `: it has no ${asset.inArchive}`}. Nothing was installed.` };
    chmodSync(program, 0o755);
    // Asked before it is moved into place, so a program that is not the pinned one never stands in the tools folder.
    const said = await ctx.run(program, ['--version'], { env: ctx.env, cwd: work, quiet: true, timeoutMs: QUICK_MS });
    const version = toolVersionFrom(said.output);
    if (version !== pin.version) return { ok: false, reason: `The unpacked ${tool} says it is ${version ?? 'no version'}, not ${pin.version}. Nothing was installed.` };
    mkdirSync(toolsBin(ctx.dataDir), { recursive: true, mode: 0o700 });
    const path = toolPath(ctx.dataDir, tool);
    renameSync(program, path);
    return { ok: true, version, path };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
