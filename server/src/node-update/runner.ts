// How a worker node updates itself (worker-nodes.md 4.2): `kestrel upgrade <version>`'s own path, with no terminal.
// The bundle's install script (found and planned by `upgradePlan`, node-control/upgrade.ts) is copied out of the bundle
// it is about to replace and run for exactly the target version, checksum before anything is unpacked, data and the
// version before kept. It is run by a small runner started apart from the node's unit (`systemd-run --user`, a
// transient unit of its own), because the install restarts the node's unit and that ends everything in it.
//
// The runner adds only what the install script does not do: it waits for the new version to answer (`kestrel node
// status --json` names it), and when it does not, or the install failed after it moved `current`, it points `current`
// back at the version that ran, writes that version's unit again and restarts it. Either way it writes what happened
// (`outcome.json`, with the install's output beside it in `install.log`) into Kestrel's folder, where the node reads it
// (at start, and when the runner ends while it is still running) and remembers a failure through the Persistence facade.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_UNIT_NAME } from '../shared/node-service.ts';
import { INSTALL_NO_BUNDLE_EXIT, isVersion, noBuildText, type FailedUpdate } from '../shared/node-update.ts';
import { upgradePlan, type InstalledBundle } from '../node-control/upgrade.ts';

/** The folder in Kestrel's folder the runner works in. */
export const UPDATE_FOLDER = 'node-update';
/** The transient unit the runner is: one at a time, since systemd refuses a second of the same name while it runs. */
export const UPDATE_UNIT = 'kestrel-node-update';
/** How long the runner waits for the new version to answer, in two-second steps. */
export const ANSWER_WAIT_STEPS = 45;

export interface UpdateFiles {
  folder: string;
  installer: string;
  runner: string;
  outcome: string;
  log: string;
}

export const updateFiles = (dataDir: string): UpdateFiles => {
  const folder = join(dataDir, UPDATE_FOLDER);
  return { folder, installer: join(folder, 'install.sh'), runner: join(folder, 'run.sh'), outcome: join(folder, 'outcome.json'), log: join(folder, 'install.log') };
};

/** A value in single quotes for sh. */
const shq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export interface RunnerInput {
  home: string;
  /** `~/.kestrel/node`: the bundles and `current`. */
  bundles: string;
  target: string;
  /** The version that runs now. */
  from: string;
  channel: 'stable' | 'beta';
  files: UpdateFiles;
  answerSteps?: number;
}

/** The runner's text. Pure: a test runs it against stand-ins. */
export function updateRunnerScript(r: RunnerInput): string {
  if (!isVersion(r.target) || !isVersion(r.from)) throw new Error('An update runs between two versions.');
  return `#!/bin/sh
# Kestrel worker node: an update to ${r.target}, started by the node apart from its own unit. Written by the node
# (server/src/node-update/runner.ts); it runs the bundle's install script and goes back to ${r.from} if ${r.target}
# does not answer.
set -u
export HOME=${shq(r.home)}
export KESTREL_NODE_CHANNEL=${shq(r.channel)}
BUNDLES=${shq(r.bundles)}
TARGET=${shq(r.target)}
FROM=${shq(r.from)}
OUT=${shq(r.files.outcome)}
LOG=${shq(r.files.log)}
UNIT=${shq(NODE_UNIT_NAME)}
previous="$(readlink "$BUNDLES/current" 2>/dev/null || true)"
rm -f "$OUT"
/bin/sh ${shq(r.files.installer)} "$TARGET" </dev/null >"$LOG" 2>&1
code=$?
answered=0
if [ "$code" = 0 ]; then
  i=0
  while [ "$i" -lt ${r.answerSteps ?? ANSWER_WAIT_STEPS} ]; do
    if "$BUNDLES/current/bin/kestrel-node" node status --json 2>/dev/null | grep -q "^{\\"running\\":true,\\"version\\":\\"$TARGET\\""; then answered=1; break; fi
    sleep 2
    i=$((i + 1))
  done
fi
if [ "$answered" = 1 ]; then
  printf '{"target":"%s","from":"%s","ok":true}\\n' "$TARGET" "$FROM" >"$OUT"
else
  back=0
  now="$(readlink "$BUNDLES/current" 2>/dev/null || true)"
  if [ -n "$previous" ] && [ -d "$BUNDLES/$previous" ] && [ "$now" != "$previous" ]; then back=1; fi
  # Written before the restart, so the version that comes back reads it as it starts.
  printf '{"target":"%s","from":"%s","ok":false,"code":%s,"back":%s}\\n' "$TARGET" "$FROM" "$code" "$back" >"$OUT"
  if [ "$back" = 1 ]; then
    ln -sfn "$previous" "$BUNDLES/current"
    if [ -f "$BUNDLES/$previous/share/$UNIT" ]; then cp "$BUNDLES/$previous/share/$UNIT" "$HOME/.config/systemd/user/$UNIT"; fi
    systemctl --user daemon-reload
    systemctl --user restart "$UNIT"
  fi
fi
rm -f ${shq(r.files.installer)}
`;
}

/** What the runner left, read: the update arrived, or why it did not. */
export type UpdateOutcome = { target: string; ok: true } | { target: string; ok: false; failed: FailedUpdate };

/** The install's last words worth showing: its own refusal ("Kestrel worker node: …"), else its last line. */
function lastWords(log: string): string {
  const lines = log.split('\n').map((l) => l.trim()).filter(Boolean);
  const refusal = [...lines].reverse().find((l) => l.startsWith('Kestrel worker node:'));
  return (refusal ? refusal.slice('Kestrel worker node:'.length).trim() : (lines[lines.length - 1] ?? '')).slice(0, 500);
}

/** The outcome file and the install's output, as what happened. Pure. Null when the file is not an outcome. */
export function readOutcome(json: string, log: string): UpdateOutcome | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (!isVersion(o.target) || !isVersion(o.from)) return null;
  if (o.ok === true) return { target: o.target, ok: true };
  if (o.code === INSTALL_NO_BUNDLE_EXIT) return { target: o.target, ok: false, failed: { version: o.target, reason: noBuildText(o.target), noBuild: true } };
  const back = o.back === 1 ? ` It went back to ${o.from}.` : '';
  const said = lastWords(log);
  const why = o.code === 0 ? `${o.target} was installed but did not answer.` : said || `The install stopped (exit ${String(o.code)}).`;
  return { target: o.target, ok: false, failed: { version: o.target, reason: `${why.replace(/\.?$/, '.')}${back}` } };
}

/** Reads and removes what an update left in Kestrel's folder; null when nothing is there. */
export function takeOutcome(dataDir: string): UpdateOutcome | null {
  const files = updateFiles(dataDir);
  if (!existsSync(files.outcome)) return null;
  const read = (path: string) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  };
  const outcome = readOutcome(read(files.outcome), read(files.log));
  rmSync(files.outcome, { force: true });
  return outcome;
}

/**
 * How the runner is started, so a test stands in for systemd-run. Resolves when the runner has ended (when the update
 * restarted the node, the node ends first): `ok` once it ran and left its outcome, else why it could not be started.
 */
export type StartRunner = (runner: string, outcome: string) => Promise<{ ok: true } | { ok: false; reason: string }>;

/** The real one: a transient user unit of its own, which outlives the node's unit; waited for, so a failure that leaves the node running is read at once. */
export const systemdRunner: StartRunner = (runner, outcome) =>
  new Promise((resolve) => {
    const child = spawn('systemd-run', ['--user', '--wait', '--collect', '--quiet', `--unit=${UPDATE_UNIT}`, '/bin/sh', runner], { stdio: ['ignore', 'ignore', 'pipe'] });
    let said = '';
    child.stderr?.on('data', (chunk: Buffer) => void (said += chunk.toString('utf8')));
    child.once('error', (error) => resolve({ ok: false, reason: `Could not start the update: ${error.message}` }));
    // The runner's own result is in its outcome file; with none, systemd-run could not start it, and says why.
    child.once('close', () => resolve(existsSync(outcome) ? { ok: true } : { ok: false, reason: `Could not start the update: ${said.trim().split('\n')[0] || 'systemd-run did not say why.'}` }));
  });

export interface PrepareInput {
  dataDir: string;
  home: string;
  bundles: string;
  installed: InstalledBundle;
  target: string;
}

/** Copies the bundle's install script out and writes the runner; the plan's refusal when there is nothing to run it with. */
export function prepareUpdate(p: PrepareInput): { ok: true; runner: string } | { ok: false; reason: string } {
  const plan = upgradePlan(p.installed, p.target);
  if (!plan.ok) return plan;
  if (!p.installed.version) return { ok: false, reason: 'This node does not know its installed version.' };
  const files = updateFiles(p.dataDir);
  mkdirSync(files.folder, { recursive: true, mode: 0o700 });
  copyFileSync(plan.script, files.installer);
  writeFileSync(files.runner, updateRunnerScript({ home: p.home, bundles: p.bundles, target: p.target, from: p.installed.version, channel: plan.channel, files }), { mode: 0o700 });
  return { ok: true, runner: files.runner };
}
