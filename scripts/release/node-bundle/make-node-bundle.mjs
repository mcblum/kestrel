// Makes a worker node's bundle for Linux on one architecture (docs/designs/worker-nodes.md, section 4):
//
//   dist/node/kestrel-node-linux-<arch>.tar.gz   and   dist/node/kestrel-node-linux-<arch>.tar.gz.sha256
//
// It holds, at its top (the install script unpacks it into ~/.kestrel/node/<version>/):
//
//   VERSION                     the release, app/package.json's
//   agents.json                 the versions `kestrel node agents` installs Codex and OpenCode at
//                               (server/src/shared/node-agent-versions.ts: OpenCode's is the server's SDK's)
//   tools.json                  the versions and checksums `kestrel node git` installs gh and glab at
//                               (server/src/shared/node-git-tools.ts)
//   bin/kestrel-node            the launcher (launcher.sh): the bundle's Node first on PATH, then the server. The install
//                               links it into ~/.local/bin as `kestrel` and `kestrel-node`
//   bin/kestrel                 a link to it, by the name the unit runs it by (`kestrel node run`)
//   node/                       Node for this architecture, the version node-runtime.json pins, from nodejs.org,
//                               its checksum checked against the pin before it is used
//   server/kestrel-node.mjs     the server with the kestrel-node entry, built to one JavaScript file (no tsx)
//   server/node_modules/node-pty                                    with a pty.node built for this architecture
//   server/node_modules/@anthropic-ai/claude-agent-sdk-linux-<arch>  Claude Code's program, as the Agent SDK ships it
//   share/kestrel-node.service  the systemd --user unit (shared/node-service.ts)
//   share/install.sh            the install script, as in the checkout (it names no version): what `kestrel upgrade`
//                               runs, on the installed version's channel (server/src/node-control/upgrade.ts)
//   LICENSE
//
//   node scripts/release/node-bundle/make-node-bundle.mjs --arch x64|arm64 [--pty <pty.node>] [--version x.y.z]
//                                                         [--node-tarball <file>] [--out <folder>]
//
//   --pty           the compiled pty.node (build-pty.sh); default: the one pnpm compiled, on Linux of this architecture
//   --node-tarball  Node's tarball already on disk (its checksum is still checked); default: fetched into dist/cache
//   --version       another version in the bundle than app/package.json's (test builds only)
//
// Run from a checkout after `pnpm install`. The server's bundling is app/scripts/package/build-server.mjs and the
// parts beside it are laid out by server-parts.mjs, as for the app. Nothing is uploaded.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildServer } from '../../../app/scripts/package/build-server.mjs';
import { claudePackageDir, copyNodePty, findPackageDir } from '../../../app/scripts/package/server-parts.mjs';
import { isVersion } from '../../../app/release-channel.mjs';
import { bundleFileName, checksumFileName, checksumLine, checksumProblem, elfArchOf, isNodeBundleArch } from '../../../server/src/shared/node-bundle.ts';
import { serviceUnitText } from '../../../server/src/shared/node-service.ts';
import { AGENT_PINS_FILE, agentPinsOf, agentPinsText } from '../../../server/src/shared/node-agent-versions.ts';
import { TOOL_PINS_FILE, toolPinsOf, toolPinsText } from '../../../server/src/shared/node-git-tools.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const { values } = parseArgs({ options: { arch: { type: 'string' }, pty: { type: 'string' }, version: { type: 'string' }, 'node-tarball': { type: 'string' }, out: { type: 'string' } } });

function fail(message) {
  console.error(`!! make-node-bundle: ${message}`);
  process.exit(1);
}
const step = (message) => console.log(`==> ${message}`);

const ARCH = values.arch;
if (!isNodeBundleArch(ARCH)) fail('--arch is x64 or arm64');
const VERSION = values.version ?? JSON.parse(readFileSync(join(root, 'app', 'package.json'), 'utf8')).version;
if (!isVersion(VERSION)) fail(`the version must look like 1.2.3 or 1.2.3-beta.4, not ${VERSION}`);
const OUT = resolve(values.out ?? join(root, 'dist', 'node'));
const STAGE = join(root, 'dist', 'node-stage', ARCH);
const CACHE = join(root, 'dist', 'cache');
const runtime = JSON.parse(readFileSync(join(here, 'node-runtime.json'), 'utf8'));

const sha256Of = (file) =>
  new Promise((done, failed) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => done(hash.digest('hex'))).on('error', failed);
  });

/** The first bytes of a file, for its ELF header. */
function headerOf(file) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(20);
    readSync(fd, buffer, 0, 20, 0);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

/** Stops the build unless `file` is a Linux program for this architecture. */
function needArch(file, what) {
  const arch = elfArchOf(headerOf(file));
  if (arch !== ARCH) fail(`${what} is built for ${arch ?? 'something that is not 64-bit Linux'}, not linux-${ARCH}: ${file}`);
}

async function stageNode() {
  const name = `node-v${runtime.version}-linux-${ARCH}.tar.gz`;
  const expected = runtime.sha256[`linux-${ARCH}`];
  if (!expected) fail(`node-runtime.json pins no checksum for linux-${ARCH}`);
  let tarball = values['node-tarball'];
  if (!tarball) {
    tarball = join(CACHE, name);
    if (!existsSync(tarball)) {
      step(`fetching ${name} from nodejs.org`);
      mkdirSync(CACHE, { recursive: true });
      const res = await fetch(`https://nodejs.org/dist/v${runtime.version}/${name}`);
      if (!res.ok) fail(`nodejs.org answered ${res.status} for ${name}`);
      writeFileSync(`${tarball}.part`, Buffer.from(await res.arrayBuffer()));
      execFileSync('mv', [`${tarball}.part`, tarball]);
    }
  }
  const problem = checksumProblem(expected, await sha256Of(tarball), name);
  if (problem) {
    if (!values['node-tarball']) rmSync(tarball, { force: true });
    fail(problem);
  }
  step(`Node ${runtime.version} for linux-${ARCH} (checksum matches the pin)`);
  const node = join(STAGE, 'node');
  mkdirSync(node, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', node, '--strip-components=1']);
  // The headers, man pages and docs are for building and reading, not for running.
  for (const unused of ['include', 'share', 'CHANGELOG.md', 'README.md']) rmSync(join(node, unused), { recursive: true, force: true });
  needArch(join(node, 'bin', 'node'), 'Node');
}

async function stageServer() {
  const out = join(STAGE, 'server');
  step('server (kestrel-node entry, one file)');
  await buildServer({ entry: join(root, 'server', 'src', 'node.ts'), outfile: join(out, 'kestrel-node.mjs') });
  writeFileSync(join(out, 'package.json'), '{ "type": "module", "private": true }\n');
  const ptyDir = findPackageDir(join(root, 'server'), 'node-pty') ?? fail('node-pty is not installed (pnpm install)');
  let builtPty = values.pty;
  if (!builtPty) {
    if (process.platform !== 'linux' || process.arch !== ARCH) fail(`--pty is needed: pty.node for linux-${ARCH} is built by build-pty.sh (this is ${process.platform}-${process.arch})`);
    builtPty = join(ptyDir, 'build', 'Release', 'pty.node');
  }
  copyNodePty({ ptyDir, outDir: join(out, 'node_modules', 'node-pty'), os: 'linux', arch: ARCH, builtPty, fail });
  needArch(join(out, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'), 'pty.node');
  const sdkDir = findPackageDir(join(root, 'server'), '@anthropic-ai/claude-agent-sdk') ?? fail('the Agent SDK is not installed (pnpm install)');
  const claude = claudePackageDir({ root, sdkDir, os: 'linux', arch: ARCH }) ?? fail(`Claude Code for linux-${ARCH} is missing (node scripts/release/fetch-claude-binary.mjs --platform linux --arch ${ARCH})`);
  const claudeOut = join(out, 'node_modules', '@anthropic-ai', `claude-agent-sdk-linux-${ARCH}`);
  cpSync(claude, claudeOut, { recursive: true, dereference: true });
  chmodSync(join(claudeOut, 'claude'), 0o755);
  needArch(join(claudeOut, 'claude'), 'Claude Code');
}

function stageFiles() {
  writeFileSync(join(STAGE, 'VERSION'), `${VERSION}\n`);
  const pins = agentPinsOf(JSON.parse(readFileSync(join(root, 'server', 'package.json'), 'utf8')));
  writeFileSync(join(STAGE, AGENT_PINS_FILE), agentPinsText(pins));
  step(`agents: Codex ${pins.codex}, OpenCode ${pins.opencode}`);
  const tools = toolPinsOf();
  writeFileSync(join(STAGE, TOOL_PINS_FILE), toolPinsText(tools));
  step(`tools: gh ${tools.gh.version}, glab ${tools.glab.version}`);
  mkdirSync(join(STAGE, 'bin'), { recursive: true });
  writeFileSync(join(STAGE, 'bin', 'kestrel-node'), readFileSync(join(here, 'launcher.sh'), 'utf8').replaceAll('@ARCH@', ARCH));
  chmodSync(join(STAGE, 'bin', 'kestrel-node'), 0o755);
  // The same launcher by the name people type, which the unit runs (`kestrel node run`). A relative link, so it stays
  // right wherever the bundle is unpacked; the launcher reads the bundle's folder through it.
  symlinkSync('kestrel-node', join(STAGE, 'bin', 'kestrel'));
  mkdirSync(join(STAGE, 'share'), { recursive: true });
  writeFileSync(join(STAGE, 'share', 'kestrel-node.service'), serviceUnitText());
  cpSync(join(root, 'scripts', 'release', 'install.sh'), join(STAGE, 'share', 'install.sh'));
  chmodSync(join(STAGE, 'share', 'install.sh'), 0o755);
  cpSync(join(root, 'LICENSE'), join(STAGE, 'LICENSE'));
}

/** On Linux of this architecture: the bundle starts, and its node-pty opens a terminal. */
function smokeTest() {
  if (process.platform !== 'linux' || process.arch !== ARCH) {
    step(`not run here (this is ${process.platform}-${process.arch}): the bundle's own check that it starts and opens a terminal`);
    return;
  }
  execFileSync(join(STAGE, 'bin', 'kestrel-node'), ['help'], { stdio: 'ignore' });
  execFileSync(join(STAGE, 'bin', 'kestrel'), ['node', 'help'], { stdio: 'ignore' });
  const script = "const pty = require(process.argv[1]); const t = pty.spawn('/bin/echo', ['pty-ok'], {}); let out = ''; t.onData((d) => (out += d)); t.onExit(() => { if (!out.includes('pty-ok')) process.exit(1); });";
  execFileSync(join(STAGE, 'node', 'bin', 'node'), ['-e', script, join(STAGE, 'server', 'node_modules', 'node-pty')], { stdio: 'inherit', timeout: 20_000 });
  step('checked: the bundle starts, and node-pty opens a terminal');
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
await stageNode();
await stageServer();
stageFiles();
smokeTest();
mkdirSync(OUT, { recursive: true });
const file = join(OUT, bundleFileName(ARCH));
execFileSync('tar', ['-czf', file, '-C', STAGE, '.']);
writeFileSync(join(OUT, checksumFileName(ARCH)), checksumLine(await sha256Of(file), bundleFileName(ARCH)));
step(`Kestrel worker node ${VERSION} for linux-${ARCH}: ${file} and its .sha256`);
