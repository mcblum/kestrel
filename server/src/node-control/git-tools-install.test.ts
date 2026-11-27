// Installing gh and glab into Kestrel's tools folder, against a fake release folder reached by file: addresses: the
// archives are real tar.gz files holding a stub program that says its version. No network, no administrator, and the
// PATH holds only plain tools, so a real gh, glab or package manager on this computer plays no part.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { toolPinsOf, type GitTool, type ToolPins } from '../shared/node-git-tools.ts';
import { runProgram } from './agents-programs.ts';
import { installTool, toolPath } from './git-tools-install.ts';
import { hermeticPath, realProgramsOn } from './test-path.ts';

let root: string;
let home: string;
let dataDir: string;
let releases: string;
let path: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kn-tools-')));
  home = join(root, 'home');
  dataDir = join(home, '.kestrel');
  releases = join(root, 'releases');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(releases);
  path = hermeticPath(root, []);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A release archive with the program where the pin says, saying `version`; answers the pins pointing at it. */
function release(tool: GitTool, version: string): ToolPins {
  const pins = toolPinsOf();
  const asset = pins[tool].assets.x64;
  const stage = join(root, `stage-${tool}`);
  const program = join(stage, asset.inArchive);
  mkdirSync(join(program, '..'), { recursive: true });
  writeFileSync(program, `#!/bin/sh\necho "${tool} version ${version} (stub)"\n`);
  chmodSync(program, 0o755);
  const archive = join(releases, asset.url.split('/').at(-1)!);
  execFileSync('tar', ['-czf', archive, '-C', stage, asset.inArchive.split('/')[0]!]);
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  return { ...pins, [tool]: { ...pins[tool], assets: { ...pins[tool].assets, x64: { ...asset, url: pathToFileURL(archive).href, sha256 } } } };
}

const fetched: string[] = [];
beforeEach(() => void (fetched.length = 0));
const ctx = (pins: ToolPins) => ({
  dataDir,
  pins,
  arch: 'x64',
  env: { HOME: home, PATH: path },
  run: runProgram,
  fetch: async (url: string) => (fetched.push(url), readFileSync(new URL(url))),
});

/** Every file under a folder, relative to it. */
const filesUnder = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort() : []);

describe('installing gh and glab at their pins', () => {
  test('hermetic: the PATH reaches only plain tools', () => {
    expect(realProgramsOn(path, [])).toEqual([]);
  });

  test('the pinned version is the one fetched, checked, unpacked and asked; only the program is kept, in Kestrel’s tools folder', async () => {
    for (const [tool, version] of [['gh', '2.96.0'], ['glab', '1.130.0']] as const) {
      const pins = release(tool, version);
      expect(await installTool(tool, ctx(pins))).toEqual({ ok: true, version, path: toolPath(dataDir, tool) });
      expect(fetched.at(-1)).toBe(pins[tool].assets.x64.url);
      expect(fetched.at(-1)).toContain(`_${version}_linux_amd64.tar.gz`);
      expect(execFileSync(toolPath(dataDir, tool), ['--version'], { encoding: 'utf8' })).toContain(version);
    }
    expect(filesUnder(join(dataDir, 'tools'))).toEqual(['bin', 'bin/gh', 'bin/glab']);
    // Nothing anywhere else: not in the home folder, not on the plain tools' PATH.
    expect(filesUnder(home).filter((f) => !f.startsWith('.kestrel'))).toEqual([]);
    expect(realProgramsOn(path, [])).toEqual([]);
  });

  test('an archive that is not the published one is refused before anything is unpacked, and leaves nothing', async () => {
    const pins = release('gh', '2.96.0');
    const wrong = { ...pins, gh: { ...pins.gh, assets: { ...pins.gh.assets, x64: { ...pins.gh.assets.x64, sha256: '0'.repeat(64) } } } };
    const done = await installTool('gh', ctx(wrong));
    expect(done).toMatchObject({ ok: false, reason: expect.stringMatching(/^The download of gh 2\.96\.0 is not the published one \(its SHA-256 is [0-9a-f]{64}, the release says 0{64}\)\. Nothing was installed\.$/) });
    expect(filesUnder(join(dataDir, 'tools'))).toEqual([]);
  });

  test('a program that does not say the pinned version is not kept', async () => {
    const pins = release('glab', '1.129.0');
    expect(await installTool('glab', ctx(pins))).toEqual({ ok: false, reason: 'The unpacked glab says it is 1.129.0, not 1.130.0. Nothing was installed.' });
    expect(filesUnder(join(dataDir, 'tools'))).toEqual([]);
  });

  test('a download that fails, or an architecture with no pin, installs nothing and says why', async () => {
    const pins = toolPinsOf();
    const missing = { ...pins, gh: { ...pins.gh, assets: { ...pins.gh.assets, x64: { ...pins.gh.assets.x64, url: pathToFileURL(join(releases, 'none.tar.gz')).href } } } };
    expect(await installTool('gh', ctx(missing))).toMatchObject({ ok: false, reason: expect.stringMatching(/^gh 2\.96\.0 could not be downloaded: .*Nothing was installed\.$/) });
    expect(await installTool('gh', { ...ctx(pins), arch: 'ia32' })).toEqual({ ok: false, reason: 'gh is not pinned for ia32; only x64 and arm64 are.' });
    expect(filesUnder(join(dataDir, 'tools'))).toEqual([]);
  });
});
