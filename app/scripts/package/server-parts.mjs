// The parts of the server that are not in its one-file bundle, laid out the same way for the app (stage.mjs) and for
// a worker node's bundle (scripts/release/node-bundle/make-node-bundle.mjs): node-pty, its one native module, and the
// Claude Code program the Agent SDK runs.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A package's real folder, found the way Node would from `fromDir` (pnpm keeps each package's dependencies beside
 *  it, so this is asked of the package that depends on it), or null. Not through require.resolve: some packages
 *  export no package.json. */
export function findPackageDir(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Copies node-pty into `outDir` (a node_modules/node-pty folder) for `os`: its JavaScript, and either the prebuilt
 * module for `${os}-${arch}` (macOS, Windows) or, for Linux, which has no prebuild, the `pty.node` given in
 * `builtPty` (compiled for that architecture). `fail` reports a missing part and does not return.
 */
export function copyNodePty({ ptyDir, outDir, os, arch, builtPty, fail }) {
  cpSync(join(ptyDir, 'package.json'), join(outDir, 'package.json'));
  cpSync(join(ptyDir, 'LICENSE'), join(outDir, 'LICENSE'));
  // lib/worker is the Windows console's output reader; the Unix terminal never loads it.
  const skipWorker = os !== 'win32';
  cpSync(join(ptyDir, 'lib'), join(outDir, 'lib'), { recursive: true, filter: (src) => !/\.(test\.js|map)$/.test(src) && !(skipWorker && src.includes(`${join('lib', 'worker')}`)) });
  if (os === 'linux') {
    if (!builtPty || !existsSync(builtPty)) fail(`node-pty's compiled module for linux-${arch} is missing${builtPty ? `: ${builtPty}` : ''}`);
    mkdirSync(join(outDir, 'build', 'Release'), { recursive: true });
    cpSync(builtPty, join(outDir, 'build', 'Release', 'pty.node'));
    return;
  }
  const platform = `${os}-${arch}`;
  const prebuilt = join(ptyDir, 'prebuilds', platform);
  if (!existsSync(prebuilt)) fail(`node-pty's ${platform} prebuild is missing: ${prebuilt}`);
  cpSync(prebuilt, join(outDir, 'prebuilds', platform), { recursive: true, filter: (src) => !src.endsWith('.pdb') });
  if (os === 'darwin') chmodSync(join(outDir, 'prebuilds', platform, 'spawn-helper'), 0o755);
}

/** The Agent SDK's per-platform package (`@anthropic-ai/claude-agent-sdk-<os>-<arch>`, holding the `claude`
 *  program): from node_modules when pnpm installed that platform's (it does for this computer's), else where
 *  scripts/release/fetch-claude-binary.mjs unpacked it. Null when neither has it. */
export function claudePackageDir({ root, sdkDir, os, arch }) {
  const name = `@anthropic-ai/claude-agent-sdk-${os}-${arch}`;
  const exe = os === 'win32' ? 'claude.exe' : 'claude';
  const installed = findPackageDir(sdkDir, name);
  if (installed && existsSync(join(installed, exe))) return installed;
  const version = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')).version;
  const fetched = join(root, 'dist', 'cache', `claude-${os}-${arch}-${version}`, 'package');
  return existsSync(join(fetched, exe)) ? fetched : null;
}
