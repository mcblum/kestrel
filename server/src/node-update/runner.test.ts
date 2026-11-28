// The update runner end to end, in a temporary folder, against stand-ins: an install script that switches `current`
// (or fails, before or after switching it), a bundle launcher that answers `node status --json` with its version (or
// does not), and a systemctl that only logs. No network, no systemd, no real install script.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { INSTALL_NO_BUNDLE_EXIT } from '../shared/node-update.ts';
import { readOutcome, takeOutcome, updateFiles, updateRunnerScript } from './runner.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sh(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** A node with 0.0.34 installed and running; the install stand-in does what `install` says. */
function world(install: { code: number; switch: boolean; answers: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'kn-update-'));
  roots.push(root);
  const home = join(root, 'home');
  const data = join(home, '.kestrel');
  const bundles = join(data, 'node');
  const stubs = join(root, 'stubs');
  const log = join(root, 'calls.log');
  for (const version of ['0.0.34', '0.0.35']) {
    mkdirSync(join(bundles, version, 'bin'), { recursive: true });
    mkdirSync(join(bundles, version, 'share'), { recursive: true });
    writeFileSync(join(bundles, version, 'share', 'kestrel-node.service'), `unit of ${version}\n`);
    const answer = version === '0.0.35' && !install.answers ? '{"running":false}' : `{"running":true,"version":"${version}","kind":"node"}`;
    sh(join(bundles, version, 'bin', 'kestrel-node'), `#!/bin/sh\n[ "$*" = "node status --json" ] && echo '${answer}'\n`);
  }
  symlinkSync('0.0.34', join(bundles, 'current'));
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
  mkdirSync(stubs);
  sh(join(stubs, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >> '${log}'\n`);
  const files = updateFiles(data);
  mkdirSync(files.folder, { recursive: true });
  sh(files.installer, `#!/bin/sh\necho "installing $1 on $KESTREL_NODE_CHANNEL"\n${install.switch ? `ln -sfn "$1" '${bundles}/current'\n` : ''}${install.code ? `echo "Kestrel worker node: it went wrong for $1." >&2\nexit ${install.code}\n` : 'exit 0\n'}`);
  sh(files.runner, updateRunnerScript({ home, bundles, target: '0.0.35', from: '0.0.34', channel: 'stable', files, answerSteps: 1 }));
  const run = () => spawnSync('/bin/sh', [files.runner], { env: { PATH: `${stubs}:/usr/bin:/bin` }, encoding: 'utf8' });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  return { data, bundles, home, files, run, calls, current: () => readlinkSync(join(bundles, 'current')) };
}

describe('the update runner', () => {
  test('an update that answers stays, and says so', () => {
    const w = world({ code: 0, switch: true, answers: true });
    expect(w.run().status).toBe(0);
    expect(w.current()).toBe('0.0.35');
    expect(w.calls()).toEqual([]);
    expect(takeOutcome(w.data)).toEqual({ target: '0.0.35', ok: true });
    expect(existsSync(w.files.installer)).toBe(false);
  });

  test('installed but not answering: it goes back to the version that ran, its unit written again and restarted', () => {
    const w = world({ code: 0, switch: true, answers: false });
    w.run();
    expect(w.current()).toBe('0.0.34');
    expect(readFileSync(join(w.home, '.config', 'systemd', 'user', 'kestrel-node.service'), 'utf8')).toBe('unit of 0.0.34\n');
    expect(w.calls()).toEqual(['systemctl --user daemon-reload', 'systemctl --user restart kestrel-node.service']);
    expect(takeOutcome(w.data)).toEqual({ target: '0.0.35', ok: false, failed: { version: '0.0.35', reason: '0.0.35 was installed but did not answer. It went back to 0.0.34.' } });
  });

  test('a failure after current moved goes back too, with the install’s own words', () => {
    const w = world({ code: 1, switch: true, answers: true });
    w.run();
    expect(w.current()).toBe('0.0.34');
    expect(takeOutcome(w.data)).toMatchObject({ ok: false, failed: { reason: 'it went wrong for 0.0.35. It went back to 0.0.34.' } });
  });

  test('a failure before anything moved leaves the node running, unrestarted', () => {
    const w = world({ code: 1, switch: false, answers: true });
    w.run();
    expect(w.current()).toBe('0.0.34');
    expect(w.calls()).toEqual([]);
    expect(takeOutcome(w.data)).toMatchObject({ ok: false, failed: { version: '0.0.35', reason: 'it went wrong for 0.0.35.' } });
    // Read once: the next look finds nothing.
    expect(takeOutcome(w.data)).toBeNull();
  });

  test('a version with no node bundle is said as such, not as a failure', () => {
    const w = world({ code: INSTALL_NO_BUNDLE_EXIT, switch: false, answers: true });
    w.run();
    expect(takeOutcome(w.data)).toEqual({ target: '0.0.35', ok: false, failed: { version: '0.0.35', reason: '0.0.35 has no build for worker nodes.', noBuild: true } });
  });

  test('an outcome file that is not one is ignored, and the runner is written only between two versions', () => {
    expect(readOutcome('nonsense', '')).toBeNull();
    expect(readOutcome('{"target":"latest","from":"0.0.34","ok":true}', '')).toBeNull();
    expect(() => updateRunnerScript({ home: '/h', bundles: '/h/b', target: 'latest', from: '0.0.34', channel: 'stable', files: updateFiles('/h/.kestrel') })).toThrow();
  });
});
