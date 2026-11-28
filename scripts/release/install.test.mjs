// install.sh end to end, in a temporary HOME, against a fake release folder, published copies and package
// registry (file:// URLs), with uname, id, systemctl, loginctl and a package manager replaced by stubs on PATH. No
// network, no systemd, nothing outside the temporary folder. The bundle's command is a stub that says how `node configure`
// was started (its stdin: the terminal, or nothing). Run with the app's tests (node --test).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archOfMachine } from '../../server/src/shared/node-bundle.ts';
import { serviceUnitText } from '../../server/src/shared/node-service.ts';
import { SANDBOX_INSTALL_COMMANDS } from '../../server/src/shared/node-sandbox.ts';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'install.sh');
const FILE = 'kestrel-node-linux-x64.tar.gz';

function sh(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** A bundle of `version` in its own release folder, with its checksum (or a wrong one). */
function release(root, version, { badChecksum = false, arch = 'x64', dir = join(root, `release-${version}-${arch}`) } = {}) {
  const content = join(root, `content-${version}-${arch}`);
  // `node configure` says what it was started as and what its stdin held: the terminal's text, or nothing (/dev/null).
  sh(join(content, 'bin', 'kestrel-node'), '#!/bin/sh\nif [ "$*" = "node configure" ]; then printf "configure as %s, stdin: %s\\n" "$0" "$(cat)"; exit 0; fi\necho "kestrel-node $*"\n');
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
      // No terminal unless a test gives one: the real /dev/tty of whoever runs the tests is never read.
      env: { HOME: home, PATH: `${stubs}:${tools}`, TMPDIR: join(root, 'tmp'), KESTREL_NODE_START_WAIT: '0', KESTREL_NODE_TTY: join(root, 'no-terminal'), ...env },
      encoding: 'utf8',
    });
    const out = `${result.stdout}${result.stderr}`;
    // A tool the script runs that is neither stubbed nor among the plain tools would show here, on any computer.
    assert.doesNotMatch(out, /not found/, `the script ran a program the test's PATH lacks:\n${out}`);
    return { code: result.status, out, err: result.stderr };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  return { root, home, run, calls, path: [stubs, tools], kestrel: join(home, '.kestrel'), done: () => rmSync(root, { recursive: true, force: true }) };
}

/** A terminal for configure to read: a file holding what is typed. */
function terminal(root, typed = 'typed at the terminal') {
  const path = join(root, 'tty');
  writeFileSync(path, typed);
  return path;
}

/** The script as publish.sh writes it for a channel, naming its newest version (scripts/release/publish.sh). */
function published(dir, name, channel, latest) {
  const text = readFileSync(SCRIPT, 'utf8').replace(/^KESTREL_CHANNEL=.*$/m, `KESTREL_CHANNEL=${channel}`).replace(/^KESTREL_LATEST=.*$/m, `KESTREL_LATEST=${latest}`);
  const path = join(dir, name);
  sh(path, text);
  return path;
}

/** The releases project's served files (`-/raw/main/…`) and the package registry (`<version>/…`), as file:// URLs. */
function host(root, { stable = null, beta = null, versions = [] } = {}) {
  const raw = join(root, 'releases', '-', 'raw', 'main');
  mkdirSync(raw, { recursive: true });
  if (stable !== null) published(raw, 'install.sh', 'stable', stable);
  if (beta !== null) published(raw, 'install-beta.sh', 'beta', beta);
  for (const version of versions) release(root, version, { dir: join(root, 'registry', version) });
  return { KESTREL_NODE_RELEASES: `file://${join(root, 'releases')}`, KESTREL_NODE_REGISTRY: `file://${join(root, 'registry')}` };
}

const installedVersion = (w) => readlinkSync(join(w.kestrel, 'node', 'current'));

test('the script sees only the stubs and plain tools, never this computer’s own package manager or services', () => {
  const w = world({ packageManager: null });
  try {
    const [, tools] = w.path;
    for (const name of DECIDED_BY_THE_TEST) assert.ok(!existsSync(join(tools, name)), `${name} must come from a stub or not at all`);
    assert.ok(w.path.every((dir) => !SYSTEM_DIRS.includes(dir)), 'the system’s own folders are not on the script’s PATH');
    const { code, out } = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34') });
    assert.equal(code, 0, out);
  } finally {
    w.done();
  }
});

test('installs into ~/.kestrel, the user’s alone, with both links, the unit and the service started, then sets up', () => {
  const w = world();
  try {
    const { code, out } = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34'), KESTREL_NODE_TTY: terminal(w.root) });
    assert.equal(code, 0, out);
    assert.match(out, /^Kestrel worker node\n\nInstall\n/);
    assert.match(out, /^   ok: Bundle checksum verified$/m);
    assert.match(out, /^   ok: Installed 0\.0\.34 in ~\/\.kestrel\/node$/m);
    assert.match(out, /^   ok: Worker node is running \(kestrel-node\.service\)$|^   The service was started, but the node has not answered yet\.$/m);
    assert.equal(statSync(w.kestrel).mode & 0o777, 0o700);
    assert.equal(installedVersion(w), '0.0.34');
    assert.equal(readFileSync(join(w.kestrel, 'node', '0.0.34', 'VERSION'), 'utf8'), '0.0.34\n');
    for (const name of ['kestrel', 'kestrel-node']) assert.equal(readlinkSync(join(w.home, '.local', 'bin', name)), join(w.kestrel, 'node', 'current', 'bin', 'kestrel-node'));
    assert.equal(readFileSync(join(w.home, '.config', 'systemd', 'user', 'kestrel-node.service'), 'utf8'), serviceUnitText());
    assert.deepEqual(w.calls().filter((c) => c.startsWith('systemctl') && !c.includes('show-environment')), ['systemctl --user daemon-reload', 'systemctl --user enable kestrel-node.service', 'systemctl --user is-active --quiet kestrel-node.service', 'systemctl --user start kestrel-node.service']);
    // `kestrel node configure` starts at once, by the full path (this shell's PATH may not have ~/.local/bin), reading the terminal.
    assert.ok(out.trimEnd().endsWith(`configure as ${join(w.home, '.local', 'bin', 'kestrel')}, stdin: typed at the terminal`), out);
  } finally {
    w.done();
  }
});

test('with no terminal, configure asks nothing: it is started with no input, and says what is left itself', () => {
  const w = world();
  try {
    const { code, out } = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34') });
    assert.equal(code, 0, out);
    assert.ok(out.trimEnd().endsWith(`configure as ${join(w.home, '.local', 'bin', 'kestrel')}, stdin:`), out);
  } finally {
    w.done();
  }
});

test('lingering is tried as the user; where it is refused nothing is printed here (configure shows the command)', () => {
  const w = world();
  try {
    const { code, out } = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34') });
    assert.equal(code, 0, out);
    assert.ok(w.calls().includes('loginctl enable-linger nodeuser'));
    assert.doesNotMatch(out, /Access denied|sudo/);
    // Nor the sandbox's install command: the install itself never says or runs sudo.
    for (const { command } of SANDBOX_INSTALL_COMMANDS) assert.ok(!out.includes(command), out);
  } finally {
    w.done();
  }
});

test('~/.local/bin not on PATH: one marked line in the shell’s profile, added once, and the full path meanwhile', () => {
  for (const [shell, profile] of [['/bin/bash', '.bashrc'], ['/usr/bin/zsh', '.zshrc'], ['/bin/sh', '.profile'], ['', '.profile']]) {
    const w = world();
    try {
      // SHELL empty, not unset: bash running as sh fills an unset SHELL in from the login shell of whoever runs the tests.
      const env = { KESTREL_NODE_URL: release(w.root, '0.0.34'), SHELL: shell };
      const first = w.run([], env);
      assert.equal(first.code, 0, first.out);
      assert.ok(first.out.includes(`   ok: Added ~/.local/bin to PATH in ~/${profile} (one marked line)\n`), first.out);
      // The command to type stands on a line of its own, whole, to copy.
      assert.match(first.out, /^ {7}export PATH="\$HOME\/\.local\/bin:\$PATH"$/m);
      const second = w.run([], env);
      assert.match(second.out, /is put on PATH by .* already/);
      const lines = readFileSync(join(w.home, profile), 'utf8').split('\n').filter((l) => l.includes('.local/bin'));
      assert.deepEqual(lines, ['export PATH="$HOME/.local/bin:$PATH" # added by Kestrel\'s worker node install'], `${shell}: ${profile}`);
    } finally {
      w.done();
    }
  }
  // Already on PATH: no profile is touched.
  const w = world();
  try {
    const { out } = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34'), PATH: `${w.path.join(':')}:${join(w.home, '.local', 'bin')}` });
    assert.doesNotMatch(out, /to PATH in/);
    for (const profile of ['.bashrc', '.zshrc', '.profile']) assert.equal(existsSync(join(w.home, profile)), false);
  } finally {
    w.done();
  }
});

test('a kestrel on PATH that is not Kestrel’s is left alone, and configure runs by the bundle’s own path', () => {
  const w = world();
  try {
    mkdirSync(join(w.home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(w.home, '.local', 'bin', 'kestrel'), '#!/bin/sh\necho another program\n');
    const { code, out } = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34') });
    assert.equal(code, 0, out);
    assert.match(out, /\.local\/bin\/kestrel is there and is not Kestrel's link, so it was left alone\./);
    assert.equal(readFileSync(join(w.home, '.local', 'bin', 'kestrel'), 'utf8'), '#!/bin/sh\necho another program\n');
    assert.ok(out.includes(`configure as ${join(w.kestrel, 'node', 'current', 'bin', 'kestrel-node')}, stdin:`), out);
  } finally {
    w.done();
  }
});

test('a checksum that does not match refuses and leaves nothing behind', () => {
  const w = world();
  try {
    const { code, out, err } = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34', { badChecksum: true }) });
    assert.equal(code, 1);
    // The failure and what to do go to the error output, set off by a blank line; nothing claims it was verified.
    assert.match(err, /^\nThe checksum of kestrel-node-linux-x64\.tar\.gz does not match/);
    assert.doesNotMatch(out, /ok: Bundle checksum verified/);
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
    assert.match(out, /ok: Upgraded from 0\.0\.34 to 0\.0\.35/);
    assert.match(out, /Restarting the node so it runs 0\.0\.35/);
    assert.equal(installedVersion(w), '0.0.35');
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

test('with no systemd user manager, it says how to run the node by hand and configure it, writes no unit, and runs no configure', () => {
  const w = world({ userManager: false });
  try {
    const { code, out } = w.run([], { KESTREL_NODE_URL: release(w.root, '0.0.34'), KESTREL_NODE_TTY: terminal(w.root) });
    assert.equal(code, 0, out);
    assert.match(out, /systemd --user is not available here/);
    assert.ok(out.includes(`\n       ${join(w.home, '.local', 'bin', 'kestrel')} node run\n`), out);
    assert.ok(out.includes(`\n       ${join(w.home, '.local', 'bin', 'kestrel')} node configure\n`), out);
    assert.doesNotMatch(out, /configure as /);
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

describe('which version: each published copy names its channel’s newest', () => {
  /** Runs a script other than the checkout's: the copy publish.sh would write. */
  const runCopy = (w, script, args, env) => {
    const result = spawnSync('/bin/sh', [script, ...args], { env: { HOME: w.home, PATH: w.path.join(':'), TMPDIR: join(w.root, 'tmp'), KESTREL_NODE_START_WAIT: '0', KESTREL_NODE_TTY: join(w.root, 'no-terminal'), ...env }, encoding: 'utf8' });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  };

  test('the beta installer installs the beta it names, from the package registry, checksum first', () => {
    const w = world();
    try {
      const env = host(w.root, { versions: ['0.0.40-beta.2'] });
      const copy = published(w.root, 'install-beta.sh', 'beta', '0.0.40-beta.2');
      const { code, out } = runCopy(w, copy, [], env);
      assert.equal(code, 0, out);
      assert.match(out, /^ {3}The newest beta is 0\.0\.40-beta\.2\.$/m);
      // The address stands on a line of its own under what is being fetched.
      assert.ok(out.includes(`   Fetching 0.0.40-beta.2 for linux-x64:\n       ${env.KESTREL_NODE_REGISTRY}/0.0.40-beta.2/kestrel-node-linux-x64.tar.gz\n`), out);
      assert.ok(out.indexOf('ok: Bundle checksum verified') < out.indexOf('ok: Installed'), out);
      assert.equal(installedVersion(w), '0.0.40-beta.2');
    } finally {
      w.done();
    }
  });

  test('the release installer installs the release it names; a version given wins', () => {
    const w = world();
    try {
      const env = host(w.root, { versions: ['0.0.39', '0.0.38'] });
      const copy = published(w.root, 'install.sh', 'stable', '0.0.39');
      const first = runCopy(w, copy, [], env);
      assert.equal(first.code, 0, first.out);
      assert.match(first.out, /^ {3}The newest release is 0\.0\.39\.$/m);
      assert.equal(installedVersion(w), '0.0.39');
      const pinned = runCopy(w, copy, ['0.0.38'], env);
      assert.equal(pinned.code, 0, pinned.out);
      assert.doesNotMatch(pinned.out, /The newest/);
      assert.equal(installedVersion(w), '0.0.38');
    } finally {
      w.done();
    }
  });

  test('a copy that names no version (a checkout, or the one kestrel upgrade runs) reads its channel’s published copy', () => {
    const w = world();
    try {
      const env = host(w.root, { stable: '0.0.39', beta: '0.0.41-beta.1', versions: ['0.0.39', '0.0.41-beta.1'] });
      const beta = w.run([], { ...env, KESTREL_NODE_CHANNEL: 'beta' });
      assert.equal(beta.code, 0, beta.out);
      assert.match(beta.out, /^ {3}The newest beta is 0\.0\.41-beta\.1\.$/m);
      assert.equal(installedVersion(w), '0.0.41-beta.1');
      const stable = w.run([], env);
      assert.equal(stable.code, 0, stable.out);
      assert.match(stable.out, /^ {3}The newest release is 0\.0\.39\.$/m);
      assert.equal(installedVersion(w), '0.0.39');
    } finally {
      w.done();
    }
  });

  test('a published copy that names no version, or a channel that is not one, is refused and installs nothing', () => {
    const w = world();
    try {
      const env = host(w.root, { beta: '' });
      const none = w.run([], { ...env, KESTREL_NODE_CHANNEL: 'beta' });
      assert.equal(none.code, 1);
      assert.match(none.out, /install-beta\.sh does not name the newest beta\. Nothing was installed\./);
      const missing = w.run([], env);
      assert.equal(missing.code, 1);
      assert.match(missing.out, /Could not fetch .*install\.sh to find the newest release\. Nothing was installed\./);
      assert.match(w.run([], { KESTREL_NODE_CHANNEL: 'nightly' }).out, /"nightly" is not a channel: stable or beta\./);
      assert.equal(existsSync(w.kestrel), false);
    } finally {
      w.done();
    }
  });
});
