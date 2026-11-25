// Lays out everything the packaged app contains, in dist/stage, for electron-builder:
//
//   dist/stage/app/         the app archive (app.asar): package.json, main.mjs (the shell and
//                           electron-updater, bundled), preload.cjs, ui/ (vite build output)
//   dist/stage/resources/   the app's resources folder (Contents/Resources on a Mac), outside the archive:
//     server/index.mjs        the server, built to one JavaScript file (build-server.mjs)
//     server/node_modules/node-pty   its one native dependency (N-API, no rebuild needed for Electron)
//     server/whats-new/       the release notes (the repository's whats-new/), for the What's new page
//     bin/claude[.exe]        the Claude Code binary the Agent SDK runs (its own, Anthropic-signed)
//     bin/kestrel-sim         the simulator helper (build:simhelper), in a Mac build only
//
// Nothing in the workspace's node_modules is changed: files are copied out of it.
//   node app/scripts/package/stage.mjs [--platform darwin|win32|linux] [--arch arm64|x64]
// (run from anywhere; ui/dist must exist, and kestrel-sim for a Mac build). Without the options it
// stages for this computer. node-pty ships prebuilt for macOS and Windows; for Linux it is compiled
// when it is installed, so a Linux build is staged on Linux, for the architecture it runs on. The
// Claude Code binary of another platform is not installed by pnpm: fetch-claude-binary.mjs gets it.
// The version is app/package.json's: the one source for the bundle, the About panel and the updater.
import { build } from 'esbuild';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isVersion } from '../../release-channel.mjs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildServer } from './build-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', '..');
const root = join(appDir, '..');
const stage = join(root, 'dist', 'stage');
const stageApp = join(stage, 'app');
const resources = join(stage, 'resources');
const { values: target } = parseArgs({ options: { platform: { type: 'string', default: process.platform }, arch: { type: 'string', default: process.arch } } });
const OS = target.platform;
const ARCH = target.arch;
const PLATFORM = `${OS}-${ARCH}`;
const EXE = OS === 'win32' ? '.exe' : '';

function fail(message) {
  console.error(`!! stage: ${message}`);
  process.exit(1);
}

if (!['darwin', 'win32', 'linux'].includes(OS) || !['arm64', 'x64'].includes(ARCH)) fail(`cannot stage for ${PLATFORM}: --platform is darwin, win32 or linux and --arch is arm64 or x64`);

function need(path, what) {
  if (!existsSync(path)) fail(`${what} is missing: ${path}`);
  return path;
}

/** A package's real folder, found the way Node would from `fromDir` (pnpm keeps each package's
 *  dependencies beside it, so this is asked of the package that depends on it). Not through
 *  require.resolve: some packages export no package.json. */
function packageDir(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) fail(`${name} is not installed (looked from ${fromDir})`);
  }
}

async function stageShell(appPackage) {
  // The shell, with electron-updater, as one file: the archive then needs no node_modules.
  await build({
    entryPoints: [join(appDir, 'main.mjs')],
    outfile: join(stageApp, 'main.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron'],
    banner: { js: "import { createRequire as __kestrelCreateRequire } from 'node:module'; const require = __kestrelCreateRequire(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
  });
  cpSync(join(appDir, 'preload.cjs'), join(stageApp, 'preload.cjs'));
  need(join(root, 'ui', 'dist', 'index.html'), 'the UI build (pnpm --filter @kestrel/ui build)');
  cpSync(join(root, 'ui', 'dist'), join(stageApp, 'ui'), { recursive: true });
  const manifest = {
    name: 'kestrel',
    productName: 'Kestrel',
    version: appPackage.version,
    description: 'Runs coding agents, organized around tasks.',
    author: 'Matt Blum',
    license: 'AGPL-3.0-only',
    type: 'module',
    main: 'main.mjs',
  };
  writeFileSync(join(stageApp, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function stageServer() {
  const serverDir = join(root, 'server');
  const out = join(resources, 'server');
  await buildServer({ entry: join(serverDir, 'src', 'index.ts'), outfile: join(out, 'index.mjs') });
  // The server bundle is an ES module however its folder is named.
  writeFileSync(join(out, 'package.json'), '{ "type": "module", "private": true }\n');
  // What's new: the release notes, read by the server from beside itself (the shell names the folder
  // in KESTREL_WHATS_NEW_DIR), so the page works offline.
  cpSync(join(root, 'whats-new'), join(out, 'whats-new'), { recursive: true });
  const pty = packageDir(serverDir, 'node-pty');
  const ptyOut = join(out, 'node_modules', 'node-pty');
  cpSync(join(pty, 'package.json'), join(ptyOut, 'package.json'));
  cpSync(join(pty, 'LICENSE'), join(ptyOut, 'LICENSE'));
  // lib/worker is the Windows console's output reader; the Unix terminal never loads it.
  const skipWorker = OS !== 'win32';
  cpSync(join(pty, 'lib'), join(ptyOut, 'lib'), { recursive: true, filter: (src) => !/\.(test\.js|map)$/.test(src) && !(skipWorker && src.includes(`${join('lib', 'worker')}`)) });
  if (OS === 'linux') {
    // No prebuild for Linux: the module pnpm compiled on this computer, which must be the target.
    if (process.platform !== 'linux' || process.arch !== ARCH) fail(`node-pty has no prebuild for Linux, so a ${PLATFORM} build is staged on a ${PLATFORM} computer (this is ${process.platform}-${process.arch})`);
    const built = need(join(pty, 'build', 'Release', 'pty.node'), "node-pty's compiled module (pnpm install builds it; it needs python3, make and g++)");
    cpSync(built, join(ptyOut, 'build', 'Release', 'pty.node'));
    return;
  }
  const prebuilt = need(join(pty, 'prebuilds', PLATFORM), `node-pty's ${PLATFORM} prebuild`);
  cpSync(prebuilt, join(ptyOut, 'prebuilds', PLATFORM), { recursive: true, filter: (src) => !src.endsWith('.pdb') });
  if (OS === 'darwin') chmodSync(join(ptyOut, 'prebuilds', PLATFORM, 'spawn-helper'), 0o755);
}

/** The Claude Code binary for the target: from node_modules when pnpm installed that platform's
 *  package (it does for this computer's), else from where fetch-claude-binary.mjs put it. */
function claudeBinary(sdk) {
  const name = `claude${EXE}`;
  const pkg = `@anthropic-ai/claude-agent-sdk-${PLATFORM}`;
  for (let dir = sdk; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', pkg, name);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) break;
  }
  const version = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')).version;
  const fetched = join(root, 'dist', 'cache', `claude-${PLATFORM}-${version}`, 'package', name);
  return need(fetched, `the Claude Code binary for ${PLATFORM} (node scripts/release/fetch-claude-binary.mjs --platform ${OS} --arch ${ARCH})`);
}

function stageBinaries() {
  const bin = join(resources, 'bin');
  mkdirSync(bin, { recursive: true });
  // The SDK resolves its CLI as `@anthropic-ai/claude-agent-sdk-<platform>/claude` next to itself.
  const sdk = packageDir(join(root, 'server'), '@anthropic-ai/claude-agent-sdk');
  cpSync(claudeBinary(sdk), join(bin, `claude${EXE}`));
  chmodSync(join(bin, `claude${EXE}`), 0o755);
  if (OS !== 'darwin') return; // the iOS simulator, and so its helper, is on a Mac only
  cpSync(need(join(appDir, 'native', 'build', 'kestrel-sim'), 'the simulator helper (pnpm --filter @kestrel/app build:simhelper)'), join(bin, 'kestrel-sim'));
  chmodSync(join(bin, 'kestrel-sim'), 0o755);
}

const appPackage = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
if (!isVersion(appPackage.version)) fail(`app/package.json's version must look like 1.2.3 or 1.2.3-beta.4, not ${appPackage.version}`);
// For test builds only (make-release.sh --version): the version in the bundle, without touching app/package.json.
const override = process.env.KESTREL_VERSION_OVERRIDE;
if (override) {
  if (!isVersion(override)) fail(`KESTREL_VERSION_OVERRIDE must look like 1.2.3 or 1.2.3-beta.4, not ${override}`);
  appPackage.version = override;
}
rmSync(stage, { recursive: true, force: true });
mkdirSync(stageApp, { recursive: true });
await stageShell(appPackage);
await stageServer();
stageBinaries();
console.log(`==> staged Kestrel ${appPackage.version} for ${PLATFORM} in ${stage}`);
