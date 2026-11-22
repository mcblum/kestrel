// Gets the Claude Code binary of another platform, for a build made on a computer that is not it
// (a Windows installer built on Linux or a Mac). pnpm installs only this computer's
// `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`; this downloads the same package, at exactly the
// version of the Agent SDK the server uses, from the npm registry (`npm pack`, which checks the
// registry's integrity hash) and unpacks it where stage.mjs looks:
//
//   dist/cache/claude-<platform>-<arch>-<version>/package/claude[.exe]
//
//   node scripts/release/fetch-claude-binary.mjs --platform win32 --arch x64
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { values } = parseArgs({ options: { platform: { type: 'string' }, arch: { type: 'string' } } });
const { platform, arch } = values;
if (!['darwin', 'win32', 'linux'].includes(platform ?? '') || !['arm64', 'x64'].includes(arch ?? '')) {
  console.error('usage: fetch-claude-binary.mjs --platform darwin|win32|linux --arch arm64|x64');
  process.exit(2);
}

const sdk = realpathSync(join(root, 'server', 'node_modules', '@anthropic-ai', 'claude-agent-sdk'));
const version = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')).version;
const name = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
const out = join(root, 'dist', 'cache', `claude-${platform}-${arch}-${version}`);
const binary = join(out, 'package', platform === 'win32' ? 'claude.exe' : 'claude');
if (existsSync(binary)) {
  console.log(`==> already have ${binary}`);
  process.exit(0);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
console.log(`==> fetching ${name}@${version}`);
// npm.cmd on Windows needs a shell; the arguments are fixed strings from this file and the SDK's version.
execFileSync('npm', ['pack', `${name}@${version}`, '--pack-destination', out, '--silent'], { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
const tarball = readdirSync(out).find((file) => file.endsWith('.tgz'));
if (!tarball) {
  console.error(`!! npm pack left no tarball in ${out}`);
  process.exit(1);
}
execFileSync('tar', ['-xzf', join(out, tarball), '-C', out], { stdio: 'inherit' });
rmSync(join(out, tarball));
if (!existsSync(binary)) {
  console.error(`!! ${name}@${version} has no ${binary}`);
  process.exit(1);
}
console.log(`==> ${binary}`);
