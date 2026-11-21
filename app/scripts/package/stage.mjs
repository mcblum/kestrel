// Lays out everything the packaged app contains, in dist/stage, for electron-builder:
//
//   dist/stage/app/         the app archive (app.asar): package.json, main.mjs (the shell and
//                           electron-updater, bundled), preload.cjs, ui/ (vite build output)
//   dist/stage/resources/   Contents/Resources, outside the archive:
//     server/index.mjs        the server, built to one JavaScript file (build-server.mjs)
//     server/node_modules/node-pty   its one native dependency (N-API prebuilt, no rebuild needed)
//     bin/claude              the Claude Code binary the Agent SDK runs (its own, Anthropic-signed)
//     bin/kestrel-sim         the simulator helper (build:simhelper)
//
// Nothing in the workspace's node_modules is changed: files are copied out of it.
//   node app/scripts/package/stage.mjs      (run from anywhere; ui/dist and kestrel-sim must exist)
// The version is app/package.json's: the one source for the bundle, the About panel and the updater.
import { build } from 'esbuild';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './build-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', '..');
const root = join(appDir, '..');
const stage = join(root, 'dist', 'stage');
const stageApp = join(stage, 'app');
const resources = join(stage, 'resources');
const PLATFORM = 'darwin-arm64';

function fail(message) {
  console.error(`!! stage: ${message}`);
  process.exit(1);
}

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
    license: 'UNLICENSED',
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
  const pty = packageDir(serverDir, 'node-pty');
  const ptyOut = join(out, 'node_modules', 'node-pty');
  cpSync(join(pty, 'package.json'), join(ptyOut, 'package.json'));
  cpSync(join(pty, 'LICENSE'), join(ptyOut, 'LICENSE'));
  cpSync(join(pty, 'lib'), join(ptyOut, 'lib'), { recursive: true, filter: (src) => !/\.(test\.js|map)$/.test(src) && !src.includes(`${join('lib', 'worker')}`) });
  const prebuilt = need(join(pty, 'prebuilds', PLATFORM), `node-pty's ${PLATFORM} prebuild`);
  cpSync(prebuilt, join(ptyOut, 'prebuilds', PLATFORM), { recursive: true });
  chmodSync(join(ptyOut, 'prebuilds', PLATFORM, 'spawn-helper'), 0o755);
}

function stageBinaries() {
  const bin = join(resources, 'bin');
  mkdirSync(bin, { recursive: true });
  // The SDK resolves its CLI as `@anthropic-ai/claude-agent-sdk-<platform>/claude` next to itself.
  const sdk = packageDir(join(root, 'server'), '@anthropic-ai/claude-agent-sdk');
  const cli = packageDir(sdk, `@anthropic-ai/claude-agent-sdk-${PLATFORM}`);
  cpSync(need(join(cli, 'claude'), 'the Claude Code binary'), join(bin, 'claude'));
  chmodSync(join(bin, 'claude'), 0o755);
  cpSync(need(join(appDir, 'native', 'build', 'kestrel-sim'), 'the simulator helper (pnpm --filter @kestrel/app build:simhelper)'), join(bin, 'kestrel-sim'));
  chmodSync(join(bin, 'kestrel-sim'), 0o755);
}

const appPackage = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
// For test builds only (make-release.sh --version): the version in the bundle, without touching app/package.json.
const override = process.env.KESTREL_VERSION_OVERRIDE;
if (override) {
  if (!/^\d+\.\d+\.\d+$/.test(override)) fail(`KESTREL_VERSION_OVERRIDE must look like 1.2.3, not ${override}`);
  appPackage.version = override;
}
rmSync(stage, { recursive: true, force: true });
mkdirSync(stageApp, { recursive: true });
await stageShell(appPackage);
await stageServer();
stageBinaries();
console.log(`==> staged Kestrel ${appPackage.version} in ${stage}`);
