// install-node.sh end to end, in a temporary HOME, against a fake release folder (file:// URLs), with uname, id,
// systemctl, loginctl and a package manager replaced by stubs on PATH. No network, no systemd, nothing outside the
// temporary folder. Run with the app's tests (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archOfMachine } from '../../server/src/shared/node-bundle.ts';
import { serviceUnitText } from '../../server/src/shared/node-service.ts';
import { nodeStatusOf } from '../../server/src/shared/node-status.ts';
import { SANDBOX_INSTALL_COMMANDS, SANDBOX_RESTART, WITHOUT_SANDBOX } from '../../server/src/shared/node-sandbox.ts';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'install-node.sh');
const FILE = 'kestrel-node-linux-x64.tar.gz';

function sh(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** A bundle of `version` in its own release folder, with its checksum (or a wrong one). */
function release(root, version, { badChecksum = false, arch = 'x64' } = {}) {
  const dir = join(root, `release-${version}-${arch}`);
  const content = join(root, `content-${version}-${arch}`);
  // `status --json` answers what the test put in KESTREL_TEST_STATUS (a status built by the server's own nodeStatusOf).
  sh(join(content, 'bin', 'kestrel-node'), '#!/bin/sh\nif [ "$1 $2" = "status --json" ]; then [ -n "${KESTREL_TEST_STATUS:-}" ] && cat "$KESTREL_TEST_STATUS" && exit 0; echo \'{"running":false}\'; exit 1; fi\necho "kestrel-node $*"\n');
  sh(join(content, 'node', 'bin', 'node'), '#!/bin/sh\n');
  writeFileSync(join(content, 'VERSION'), `${version}\n`);
  mkdirSync(join(content, 'share'), { recursive: true });
  writeFileSync(join(content, 'share', 'kestrel-node.service'), serviceUnitText());
  mkdirSync(dir, { recursive: true });
  const file = `kestrel-node-linux-${arch}.tar.gz`;
  const made = spawnSync('tar', ['-czf', join(dir, file), '-C', content, '.']);
  assert.equal(made.status, 0, String(made.stderr));
  const hash = badChecksum ? 'f'.repeat(64) : createHash('sha256').update(readFileSync(join(dir, file))).digest('hex');
  writeFileSync(join(dir, `${file}.sha256`), `${hash}  ${file}\n`);
  return `file://${dir}`;
}

/**
 * The plain tools the script may use, and nothing else of the computer the tests run on: with the system's own
 * folders on its PATH a Debian machine's real apt-get was found before the stub for another distribution, and
 * a developer's own bwrap, socat or systemctl would change the answer the same way.
 */
const PLAIN_TOOLS = ['sh', 'mkdir', 'rm', 'mv', 'cp', 'ln', 'cat', 'tar', 'gzip', 'grep', 'cut', 'tr', 'sed', 'awk', 'head', 'tail', 'wc', 'sort', 'readlink', 'dirname', 'basename', 'mktemp', 'chmod', 'sleep', 'date', 'env', 'ls', 'touch', 'tee', 'expr', 'curl', 'sha256sum', 'shasum', 'perl'];
/** What the script looks for and a test decides: never taken from the computer. */
const DECIDED_BY_THE_TEST = ['apt-get', 'dnf', 'pacman', 'zypper', 'apk', 'systemctl', 'loginctl', 'uname', 'id', 'bwrap', 'socat', 'sudo', 'ldd', 'wget'];
const SYSTEM_DIRS = ['/usr/bin', '/bin'];

/** A folder of links to the plain tools this computer has. */
function plainTools(dir) {
  mkdirSync(dir, { recursive: true });
  for (const tool of PLAIN_TOOLS) {
    const found = SYSTEM_DIRS.map((d) => join(d, tool)).find((path) => existsSync(path));
    if (found) symlinkSync(found, join(dir, tool));
  }
  return dir;
}

/** A temporary world: HOME, the stubs, and a log of what systemctl and loginctl were asked. */
function world({ system = 'Linux', machine = 'x86_64', uid = '1000', userManager = true, active = false, packageManager = 'apt-get' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kn-install-'));
  const home = join(root, 'home');
  const stubs = join(root, 'stubs');
  const log = join(root, 'calls.log');
  const tools = plainTools(join(root, 'tools'));
  mkdirSync(home);
  mkdirSync(join(root, 'tmp'));
  sh(join(stubs, 'uname'), `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; *) echo ${system} ;; esac\n`);
  sh(join(stubs, 'id'), `#!/bin/sh\ncase "$1" in -u) echo ${uid} ;; -un) echo nodeuser ;; *) echo "uid=${uid}" ;; esac\n`);
  sh(join(stubs, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >> "${log}"\ncase "$*" in\n  *show-environment*) exit ${userManager ? 0 : 1} ;;\n  *is-active*) exit ${active ? 0 : 3} ;;\nesac\nexit 0\n`);
  sh(join(stubs, 'loginctl'), `#!/bin/sh\necho "loginctl $*" >> "${log}"\necho "Could not enable linger: Access denied" >&2\nexit 1\n`);
  if (packageManager) sh(join(stubs, packageManager), '#!/bin/sh\nexit 0\n');
  const run = (args = [], env = {}) => {
    const result = spawnSync('/bin/sh', [SCRIPT, ...args], {
      env: { HOME: home, PATH: `${stubs}:${tools}`, TMPDIR: join(root, 'tmp'), KESTREL_NODE_START_WAIT: '0', ...env },
      encoding: 'utf8',
    });
    const out = `${result.stdout}${result.stderr}`;
    // A tool the script runs that is neither stubbed nor among the plain tools would show here, on any computer.
    assert.doesNotMatch(out, /not found/, `the script ran a program the test's PATH lacks:\n${out}`);
    return { code: result.status, out };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  return { root, home, run, calls, path: [stubs, tools], kestrel: join(home, '.kestrel'), done: () => rmSync(root, { recursive: true, force: true }) };
}

test('the script sees only the stubs and plain tools, never this computer’s own package manager or services', () => {
  const w = world({ packageManager: null });
  try {
    const [, tools] = w.path;
    for (const name of DECIDED_BY_THE_TEST) assert.ok(!existsSync(join(tools, name)), `${name} must come from a stub or not at all`);
    assert.ok(w.path.every((dir) => !SYSTEM_DIRS.includes(dir)), 'the system’s own folders are not on the script’s PATH');
    // No package manager stubbed and none reachable: the generic line, whatever this computer has installed.
    const { code, out } = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34') });
    assert.equal(code, 0, out);
    for (const { command } of SANDBOX_INSTALL_COMMANDS) assert.ok(!out.includes(command), out);
  } finally {
    w.done();
  }
});

test('installs into ~/.kestrel, the user’s alone, with the link, the unit and the service started', () => {
  const w = world();
  try {
    const { code, out } = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34') });
    assert.equal(code, 0, out);
    assert.match(out, /Checksum verified\./);
    assert.equal(statSync(w.kestrel).mode & 0o777, 0o700);
    assert.equal(readlinkSync(join(w.kestrel, 'node', 'current')), '0.0.34');
    assert.equal(readFileSync(join(w.kestrel, 'node', '0.0.34', 'VERSION'), 'utf8'), '0.0.34\n');
    assert.ok(lstatSync(join(w.home, '.local', 'bin', 'kestrel-node')).isSymbolicLink());
    assert.equal(readFileSync(join(w.home, '.config', 'systemd', 'user', 'kestrel-node.service'), 'utf8'), serviceUnitText());
    assert.deepEqual(w.calls().filter((c) => c.startsWith('systemctl') && !c.includes('show-environment')), ['systemctl --user daemon-reload', 'systemctl --user enable kestrel-node.service', 'systemctl --user is-active --quiet kestrel-node.service', 'systemctl --user start kestrel-node.service']);
    assert.match(out, /kestrel-node join/);
    assert.match(out, /kestrel-node agents/);
    assert.ok(out.indexOf('kestrel-node join') < out.indexOf('kestrel-node agents'), 'agents comes after join');
    // ~/.local/bin is not on this PATH: it says so and how to run it meanwhile.
    assert.match(out, /\.local\/bin is not on your PATH/);
  } finally {
    w.done();
  }
});

test('lingering denied: says the one sudo command and what happens without it', () => {
  const w = world();
  try {
    const { code, out } = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34') });
    assert.equal(code, 0, out);
    assert.ok(w.calls().includes('loginctl enable-linger nodeuser'));
    assert.match(out, /^ {4}sudo loginctl enable-linger nodeuser$/m);
    assert.match(out, /stops when your last login session ends and does not start again after a reboot/);
    assert.doesNotMatch(out, /Access denied/);
  } finally {
    w.done();
  }
});

test('the sandbox programs missing: the install command for the distribution, and what happens without them', () => {
  // The same list `kestrel-node agents` says from (shared/node-sandbox.ts), so the two never disagree.
  for (const { manager, command } of SANDBOX_INSTALL_COMMANDS) {
    const w = world({ packageManager: manager });
    try {
      const { out } = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34') });
      assert.ok(out.includes(`    ${command}\n`), `${manager}: ${out}`);
      assert.ok(out.includes(WITHOUT_SANDBOX), out);
      assert.ok(out.includes(SANDBOX_RESTART), out);
    } finally {
      w.done();
    }
  }
});

test('a checksum that does not match refuses and leaves nothing behind', () => {
  const w = world();
  try {
    const { code, out } = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34', { badChecksum: true }) });
    assert.equal(code, 1);
    assert.match(out, /The checksum of kestrel-node-linux-x64\.tar\.gz does not match \(expected ffffffffffff…, got [0-9a-f]{12}…\)/);
    assert.match(out, /nothing was installed/);
    for (const left of ['.kestrel', '.local', '.config']) assert.equal(existsSync(join(w.home, left)), false, left);
    assert.deepEqual(w.calls(), []);
  } finally {
    w.done();
  }
});

test('a second run upgrades in place: the data folder is kept, the version before stays, the service restarts', () => {
  const w = world();
  try {
    assert.equal(w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34') }).code, 0);
    writeFileSync(join(w.kestrel, 'kestrel.sqlite'), 'the conversations');
    chmodSync(w.kestrel, 0o755);
    const second = world({ active: true });
    // The same home, now with the service running.
    const { code, out } = second.run([], { HOME: w.home, KESTREL_NODE_URL: release(w.root, '0.0.35') });
    second.done();
    assert.equal(code, 0, out);
    assert.match(out, /Upgraded Kestrel's worker node from 0\.0\.34 to 0\.0\.35/);
    assert.match(out, /Restarting the node so it runs 0\.0\.35/);
    assert.equal(readlinkSync(join(w.kestrel, 'node', 'current')), '0.0.35');
    assert.ok(existsSync(join(w.kestrel, 'node', '0.0.34', 'VERSION')));
    assert.equal(readFileSync(join(w.kestrel, 'kestrel.sqlite'), 'utf8'), 'the conversations');
    assert.equal(statSync(w.kestrel).mode & 0o777, 0o700);
    // A third release removes the oldest, keeping the one that ran before.
    assert.equal(w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.36') }).code, 0);
    assert.equal(existsSync(join(w.kestrel, 'node', '0.0.34')), false);
    assert.ok(existsSync(join(w.kestrel, 'node', '0.0.35')));
    // The same version again is put back whole.
    rmSync(join(w.kestrel, 'node', '0.0.36', 'bin'), { recursive: true });
    assert.equal(w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.36') }).code, 0);
    assert.ok(existsSync(join(w.kestrel, 'node', '0.0.36', 'bin', 'kestrel-node')));
    assert.deepEqual(spawnSync('ls', ['-A', join(w.kestrel, 'node')], { encoding: 'utf8' }).stdout.trim().split('\n').sort(), ['0.0.35', '0.0.36', 'current']);
  } finally {
    w.done();
  }
});

test('root is refused: it installs for a user', () => {
  const w = world({ uid: '0' });
  try {
    const { code, out } = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34') });
    assert.equal(code, 1);
    assert.match(out, /not as root/);
    assert.equal(existsSync(w.kestrel), false);
  } finally {
    w.done();
  }
});

test('another system or processor is refused with the reason, as the server words it', () => {
  const mac = world({ system: 'Darwin' });
  try {
    const { code, out } = mac.run([], { KESTREL_NODE_URL: 'file:///nowhere' });
    assert.equal(code, 1);
    assert.match(out, /runs on Linux; this is Darwin/);
  } finally {
    mac.done();
  }
  for (const machine of ['x86_64', 'amd64', 'aarch64', 'arm64', 'armv7l', 'riscv64']) {
    const w = world({ machine });
    try {
      const expected = archOfMachine(machine);
      const url = expected.ok ? release(w.root, '0.0.34', { arch: expected.value }) : 'file:///nowhere';
      const { code, out } = w.run([], { KESTREL_NODE_URL: url });
      if (expected.ok) {
        assert.equal(code, 0, out);
        assert.match(out, new RegExp(`kestrel-node-linux-${expected.value}\\.tar\\.gz`));
      } else {
        assert.equal(code, 1);
        assert.ok(out.includes(expected.reason), out);
      }
    } finally {
      w.done();
    }
  }
});

test('with no systemd user manager, it says so and how to run the node by hand, and writes no unit', () => {
  const w = world({ userManager: false });
  try {
    const { code, out } = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34') });
    assert.equal(code, 0, out);
    assert.match(out, /systemd --user is not available here/);
    assert.match(out, /kestrel-node run/);
    assert.equal(existsSync(join(w.home, '.config', 'systemd')), false);
    assert.ok(!w.calls().some((c) => c.startsWith('loginctl')));
  } finally {
    w.done();
  }
});

test('a version is checked: not a version is refused, and a bundle of another version is not installed', () => {
  const w = world();
  try {
    assert.match(w.run(['latest']).out, /"latest" is not a version/);
    const { code, out } = w.run(['0.0.35'], { KESTREL_NODE_URL: release(w.root, '0.0.34') });
    assert.equal(code, 1);
    assert.match(out, /Asked for 0\.0\.35, but the bundle is 0\.0\.34/);
    assert.deepEqual(spawnSync('ls', ['-A', join(w.kestrel, 'node')], { encoding: 'utf8' }).stdout.trim(), '');
  } finally {
    w.done();
  }
});

/** What `kestrel-node status --json` prints for a running node: the server's own status value, as the terminal prints it. */
function statusFile(root, { inAccount, canRun }) {
  const status = nodeStatusOf({
    version: '0.0.35',
    kind: 'node',
    platform: 'linux',
    name: 'Worker node 1',
    connect: { enabled: true, unavailable: null, account: inAccount ? { state: 'signed-in', email: 'a@example.com' } : { state: 'signed-out', reason: null }, link: inAccount ? { state: 'connected', since: 1 } : { state: 'off' }, inAccount, removed: false, storage: 'file' },
    agents: ['claude', 'codex', 'opencode'],
    availability: { available: canRun, notes: {} },
    sandbox: { available: true },
    host: { user: 'nodeuser', lingering: 'on', service: { manager: 'systemd', installed: true, active: true, mainPid: 1 }, disk: { path: '/x', freeBytes: 1e10 }, bundle: null },
    pid: 1,
  });
  const file = join(root, `status-${inAccount}-${canRun.length}.json`);
  writeFileSync(file, `${JSON.stringify({ running: true, ...status })}\n`);
  return file;
}

/** The lines after the install's own steps: what it says is left to do. */
const closing = (out) => out.slice(out.lastIndexOf('\n\n') + 2);

test('an upgrade of a node in the account says only what is left: the agents, or nothing', () => {
  const w = world({ active: true });
  try {
    assert.equal(w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34') }).code, 0);
    const some = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.35'), KESTREL_TEST_STATUS: statusFile(w.root, { inAccount: true, canRun: ['claude', 'codex'] }) });
    assert.equal(some.code, 0, some.out);
    assert.doesNotMatch(some.out, /join/);
    assert.equal(closing(some.out), 'This node is in your account and 2 of 3 agents can run. Next: install and sign in the others:\n    kestrel-node agents\n"kestrel-node status" says how it is at any time.\n'.replaceAll('kestrel-node', `${w.home}/.local/bin/kestrel-node`));
    const all = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.36'), KESTREL_TEST_STATUS: statusFile(w.root, { inAccount: true, canRun: ['claude', 'codex', 'opencode'] }) });
    assert.equal(all.code, 0, all.out);
    assert.match(all.out, /This node is in your account and 3 of 3 agents can run\.\n/);
    assert.doesNotMatch(all.out, /Next:|kestrel-node join|kestrel-node agents/);
  } finally {
    w.done();
  }
});

test('an upgrade of a node not yet in the account says join, then the agents, as a first install does', () => {
  const w = world({ active: true });
  try {
    const first = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34') });
    const upgrade = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.35'), KESTREL_TEST_STATUS: statusFile(w.root, { inAccount: false, canRun: [] }) });
    assert.equal(upgrade.code, 0, upgrade.out);
    assert.equal(closing(upgrade.out), closing(first.out));
    assert.ok(upgrade.out.indexOf('kestrel-node join') < upgrade.out.indexOf('kestrel-node agents'));
    // A node that does not answer is told the same.
    const silent = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.36') });
    assert.equal(closing(silent.out), closing(first.out));
  } finally {
    w.done();
  }
});
