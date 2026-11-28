// Drives the real `kestrel node configure` entry point (src/node.ts) in a pseudo-terminal, against a fake running node
// (the real control socket, answering from fixtures) and stub sudo, loginctl and apt-get on PATH, and prints each
// transcript with what it checked. It also pipes the install script into sh under a terminal, to show the /dev/tty
// handoff. Nothing outside a temporary folder is touched and nothing reaches the network. Unix sockets are needed, so
// run it outside a sandbox:
//
//   pnpm --filter @kestrel/server exec tsx scripts/node-configure-pty.ts            (every scenario)
//   pnpm --filter @kestrel/server exec tsx scripts/node-configure-pty.ts narrow     (those whose name has "narrow")
//
// What it cannot show here: a real systemd restart (on a Mac the restart says the node was started by hand) and a real
// sudo password check (the stub asks on the terminal the way sudo does and accepts anything but "wrong").
import { spawn as spawnChild } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import stringWidth from 'string-width';
import { listenControl } from '../src/node-control/control-socket.ts';
import { nodeSocketPath } from '../src/node-control/socket-path.ts';
import type { JoinIo } from '../src/node-control/join-socket.ts';
import { statusFor } from '../src/shared/node-status-fixture.ts';

/**
 * A program in a pseudo-terminal of `cols` columns, through the system's script(1) (node-pty's helper is not always
 * executable in a checkout). Input written goes to the terminal; output comes back as the terminal shows it.
 */
const EXIT_MARK = '__exit:';

function spawnPty(file: string, args: string[], o: { cols: number; rows: number; cwd: string; env: Record<string, string> }) {
  const quote = (w: string) => `'${w.replaceAll("'", "'\\''")}'`;
  const inner = `/bin/stty cols ${o.cols} rows ${o.rows}; ${[file, ...args].map(quote).join(' ')}; echo "${EXIT_MARK}$?"`;
  // Node's pipes are sockets on a Mac, which script(1) refuses as its input: cat gives it a real pipe.
  const child = spawnChild('/bin/sh', ['-c', `/bin/cat | /usr/bin/script -q /dev/null /bin/sh -c ${quote(inner)}`], { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let all = '';
  let exitCode: number | undefined;
  child.stderr.on('data', (d) => process.stderr.write(`[script] ${d}`));
  return {
    onData: (listener: (d: string) => void) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        all += d;
        const at = all.indexOf(EXIT_MARK);
        if (at >= 0 && exitCode === undefined) {
          exitCode = Number.parseInt(all.slice(at + EXIT_MARK.length), 10);
          child.stdin.end();
          return listener(d.slice(0, Math.max(0, d.length - (all.length - at))));
        }
        if (exitCode === undefined) listener(d);
      });
    },
    write: (d: string) => child.stdin.write(d),
    kill: () => child.kill('SIGKILL'),
    onExit: (listener: (e: { exitCode: number | null }) => void) => child.on('close', () => listener({ exitCode: exitCode ?? null })),
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..');
const TSX = join(SERVER, 'node_modules', '.bin', 'tsx');
const INSTALL = join(SERVER, '..', 'scripts', 'release', 'install.sh');

type State = Parameters<typeof statusFor>[0] & {};

interface Scenario {
  name: string;
  cols: number;
  env?: Record<string, string>;
  start: State;
  /** Whether stub sudo is on PATH. */
  sudo?: boolean;
  /** Answers, each typed once its prompt shows. `\x03` is Ctrl-C. */
  answers: [RegExp, string][];
  /** Run with pipes, not a terminal. */
  piped?: boolean;
  /** The interactive screen draws it (worker-onboarding/): answers are keys, and the cursor comes back at the end. */
  ink?: boolean;
}

function sh(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** Stub programs: sudo asks on the terminal like sudo; apt-get installs stub bwrap and socat; loginctl leaves a mark. */
function stubs(root: string, withSudo: boolean): string {
  const bin = join(root, 'bin');
  if (withSudo) {
    sh(join(bin, 'sudo'), `#!/bin/sh
if [ "$1" = -v ]; then
  printf '[sudo] password for nodeuser: ' >/dev/tty
  stty -echo </dev/tty 2>/dev/null; read pw </dev/tty; stty echo </dev/tty 2>/dev/null; printf '\\n' >/dev/tty
  [ "$pw" != wrong ] || { echo "Sorry, try again." >/dev/tty; exit 1; }
  exit 0
fi
exec "$@"
`);
  }
  sh(join(bin, 'loginctl'), `#!/bin/sh\ntouch "${root}/lingering-on"\n`);
  sh(join(bin, 'apt-get'), `#!/bin/sh\necho "Reading package lists..."\nsleep 0.3\nprintf '#!/bin/sh\\n' > "${bin}/bwrap"; chmod +x "${bin}/bwrap"\nprintf '#!/bin/sh\\n' > "${bin}/socat"; chmod +x "${bin}/socat"\necho "Setting up socat"\n`);
  return bin;
}

/** A folder of links to the programs in /usr/bin and /bin, less sudo. */
function withoutSudo(root: string): string {
  const dir = join(root, 'system');
  mkdirSync(dir, { recursive: true });
  for (const from of ['/usr/bin', '/bin']) {
    for (const name of readdirSync(from)) {
      if (name === 'sudo' || existsSync(join(dir, name))) continue;
      symlinkSync(join(from, name), join(dir, name));
    }
  }
  return dir;
}

/** A join the fake node holds with the terminal, as join-flow.ts words it. */
async function scriptedJoin(io: JoinIo, joined: () => void) {
  io.say({ step: 0, kind: 'heading', text: 'Kestrel worker node: join Worker node 1 to your account' });
  io.say({ step: 1, kind: 'heading', text: 'Sign in' });
  io.say({ step: 1, kind: 'field', label: 'Open', value: 'https://id.example.test/realms/kestrel/protocol/openid-connect/auth/device' });
  io.say({ step: 1, kind: 'field', label: 'Code', value: 'WDJB-MJHT', note: 'works for 10 minutes' });
  io.say({ step: 1, kind: 'wait', text: 'Waiting for you to sign in…' });
  io.say({ step: 1, kind: 'done', text: 'Signed in as person@example.com' });
  io.say({ step: 2, kind: 'heading', text: 'Let this node in' });
  io.say({ step: 2, kind: 'line', text: "Kestrel on your other devices is showing a request. Choose Let in on Worker node 1's request there, or find it in Settings → Connections." });
  io.say({ step: 2, kind: 'line', text: 'MacBook Pro opened it. Type this code on MacBook Pro:' });
  io.say({ step: 2, kind: 'code', code: '731188' });
  io.say({ step: 2, kind: 'done', text: 'MacBook Pro let it in' });
  io.say({ step: 3, kind: 'heading', text: 'Confirm' });
  io.say({ step: 3, kind: 'line', text: 'MacBook Pro now shows a code of its own. Type it here, so this node knows it was let in by your device.' });
  const code = await io.ask(3, 'Code from MacBook Pro: ');
  if (code.replace(/\s/g, '') !== '442999') return { ok: false, text: 'That is not the code MacBook Pro shows.' };
  joined();
  return { ok: true, text: 'Worker node 1 is in your account and connected to Kestrel Connect.', next: 'kestrel node status' };
}

async function run(s: Scenario): Promise<{ text: string; raw: string; code: number | null }> {
  const root = mkdtempSync('/tmp/kc-');
  const data = join(root, 'd');
  mkdirSync(data, { recursive: true });
  const bin = stubs(root, s.sudo !== false);
  let state: State = { ...s.start };
  const socket = await listenControl(nodeSocketPath(data), {
    status: async () => statusFor({ ...state, lingering: existsSync(join(root, 'lingering-on')) ? 'on' : state.lingering }),
    stop: () => undefined,
    join: (io) => scriptedJoin(io, () => (state = { ...state, inAccount: true })),
    uninstall: async () => ({ ok: false, reason: 'not here' }),
    agents: async () => [],
    git: async () => ({ name: 'Worker node 1', repositories: [], accountUnknown: null, others: [], othersUnknown: null }),
  });
  // With no sudo, the system's folders are replaced by links to everything in them but sudo (they have a real one).
  const env = { HOME: join(root, 'home'), KESTREL_DATA_DIR: data, PATH: s.sudo === false ? `${bin}:${withoutSudo(root)}` : `${bin}:/usr/bin:/bin`, TERM: 'xterm-256color', ...s.env };
  mkdirSync(env.HOME, { recursive: true });
  // KESTREL_PTY_BUNDLE: a server bundled as the node's is (app/scripts/package/build-server.mjs), run by this Node.
  const bundled = process.env.KESTREL_PTY_BUNDLE;
  const args = [bundled ?? join(SERVER, 'src', 'node.ts'), 'node', 'configure'];
  const program = bundled ? process.execPath : TSX;
  try {
    if (s.piped) {
      const child = spawnChild(program, args, { env: { ...env, PATH: `${env.PATH}:${dirname(process.execPath)}` }, stdio: ['ignore', 'pipe', 'pipe'] });
      let raw = '';
      child.stdout.on('data', (d) => (raw += d));
      let all = '';
  let exitCode: number | undefined;
  child.stderr.on('data', (d) => (raw += d));
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      return { text: raw, raw, code };
    }
    const pty = spawnPty(program, args, { cols: s.cols, rows: 50, cwd: root, env: { ...env, PATH: `${env.PATH}:${dirname(process.execPath)}` } });
    let raw = '';
    let typedAt = 0;
    const answers = [...s.answers];
    pty.onData((d) => {
      raw += d;
      const next = answers[0];
      if (next && next[0].test(stripVTControlCharacters(raw.slice(typedAt)).replace(/\r/g, ''))) {
        answers.shift();
        typedAt = raw.length;
        setTimeout(() => pty.write(next[1] === '\x03' ? '\x03' : `${next[1]}\r`), 50);
      }
    });
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => (pty.kill(), resolve(null)), 60_000);
      pty.onExit((e) => (clearTimeout(timer), resolve(e.exitCode)));
    });
    return { text: stripVTControlCharacters(raw).replace(/\r/g, ''), raw, code };
  } finally {
    await socket.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** The installer piped into sh under a terminal: configure must get the terminal as its input, not the pipe. */
async function installerPipe(cols: number, shell: string): Promise<{ text: string; code: number | null }> {
  const root = mkdtempSync('/tmp/ki-');
  const content = join(root, 'content');
  sh(join(content, 'bin', 'kestrel-node'), '#!/bin/sh\nif [ "$*" = "node configure" ]; then if [ -t 0 ]; then echo "configure: input is the terminal"; else echo "configure: input is not a terminal"; fi; exit 0; fi\n');
  sh(join(content, 'node', 'bin', 'node'), '#!/bin/sh\n');
  writeFileSync(join(content, 'VERSION'), '0.0.35\n');
  sh(join(content, 'share', 'kestrel-node.service'), '[Unit]\n');
  const dist = join(root, 'dist');
  mkdirSync(dist);
  const tar = spawnChild('tar', ['-czf', join(dist, 'kestrel-node-linux-x64.tar.gz'), '-C', content, '.']);
  await new Promise((resolve) => tar.on('close', resolve));
  const shasum = spawnChild('shasum', ['-a', '256', 'kestrel-node-linux-x64.tar.gz'], { cwd: dist });
  let sum = '';
  shasum.stdout.on('data', (d) => (sum += d));
  await new Promise((resolve) => shasum.on('close', resolve));
  writeFileSync(join(dist, 'kestrel-node-linux-x64.tar.gz.sha256'), sum);
  const bin = join(root, 'stubs');
  sh(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -m) echo x86_64 ;; *) echo Linux ;; esac\n');
  sh(join(bin, 'systemctl'), `#!/bin/sh\ncase "$*" in *is-active*) exit 3 ;; *start*) mkdir -p "$HOME/.kestrel"; perl -MIO::Socket::UNIX -e 'IO::Socket::UNIX->new(Type=>SOCK_STREAM(),Local=>"$ENV{HOME}/.kestrel/node.sock",Listen=>1); sleep 2' & sleep 0.5 ;; esac\nexit 0\n`);
  sh(join(bin, 'loginctl'), '#!/bin/sh\nexit 1\n');
  const home = join(root, 'home');
  mkdirSync(home);
  const pty = spawnPty('/bin/sh', ['-c', `/bin/cat "${INSTALL}" | ${shell}`], { cols, rows: 40, cwd: root, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TERM: 'xterm', SHELL: '/bin/sh', KESTREL_NODE_URL: `file://${dist}`, KESTREL_NODE_START_WAIT: '3' } });
  let raw = '';
  pty.onData((d) => (raw += d));
  const code = await new Promise<number | null>((resolve) => pty.onExit((e) => resolve(e.exitCode)));
  rmSync(root, { recursive: true, force: true });
  return { text: stripVTControlCharacters(raw).replace(/\r/g, ''), code };
}

const FRESH: State = { inAccount: false, canRun: ['claude'], lingering: 'off', sandbox: false };
const ALL_YES: [RegExp, string][] = [[/Run them now\?.*\[Y\/n\] ?(\n.*> )?$/s, ''], [/password for nodeuser: $/, 'secret'], [/Sign in and join now\? \[Y\/n\] ?(\n.*> )?$/s, ''], [/Code from MacBook Pro: ?(\n.*> )?$/s, '442 999']];

/** On the screen: Enter takes each default (Run them with sudo, Sign in and join), the code is typed into its input. */
const SCREEN_YES: [RegExp, string][] = [[/Run them with sudo/, ''], [/password for nodeuser: $/, 'secret'], [/Sign in and join/, ''], [/Code from MacBook Pro/, '442 999']];
/** The screen reader's setting keeps the plain transcript at a real terminal. */
const READER = { INK_SCREEN_READER: 'true' };

const SCENARIOS: Scenario[] = [
  { name: 'screen, wide terminal', cols: 80, ink: true, start: FRESH, answers: SCREEN_YES },
  { name: 'screen, narrow terminal', cols: 32, ink: true, start: FRESH, answers: SCREEN_YES },
  { name: 'screen, Ctrl-C while pairing', cols: 80, ink: true, start: { ...FRESH, lingering: 'on', sandbox: true }, answers: [[/Sign in and join/, ''], [/Code from MacBook Pro/, '\x03']] },
  { name: 'wide terminal, everything at once', cols: 80, env: READER, start: FRESH, answers: ALL_YES },
  { name: 'narrow terminal (32 columns)', cols: 32, env: READER, start: FRESH, answers: ALL_YES },
  { name: 'NO_COLOR=1', cols: 80, env: { NO_COLOR: '1' }, start: FRESH, answers: ALL_YES },
  { name: 'TERM=dumb', cols: 80, env: { TERM: 'dumb' }, start: FRESH, answers: ALL_YES },
  { name: 'administrator steps skipped', cols: 80, env: READER, start: FRESH, answers: [[/Run them now\?.*\[Y\/n\] ?(\n.*> )?$/s, 'n'], [/Sign in and join now\?.*\[Y\/n\] ?(\n.*> )?$/s, 'n']] },
  { name: 'sudo refuses the password', cols: 80, env: READER, start: { ...FRESH, inAccount: true }, answers: [[/Run them now\?.*\[Y\/n\] ?(\n.*> )?$/s, ''], [/password for nodeuser: $/, 'wrong']] },
  { name: 'no sudo here', cols: 80, env: READER, sudo: false, start: { ...FRESH, inAccount: true }, answers: [[/check again.*: ?(\n.*> )?$/s, 'n']] },
  { name: 'Ctrl-C while pairing', cols: 80, env: READER, start: { ...FRESH, lingering: 'on', sandbox: true }, answers: [[/Sign in and join now\?.*\[Y\/n\] ?(\n.*> )?$/s, ''], [/Code from MacBook Pro: ?(\n.*> )?$/s, '\x03']] },
  { name: 'output piped (no terminal)', cols: 80, piped: true, start: FRESH, answers: [] },
];

/** The screen: what it showed, that it let go of the terminal, and the same order and outcomes as the transcript. */
function checkScreen(s: Scenario, text: string, raw: string, code: number | null): void {
  const hidden = raw.lastIndexOf('\u001b[?25l');
  check(hidden < 0 || raw.lastIndexOf('\u001b[?25h') > hidden, 'the cursor is shown again at the end');
  check(raw.includes('\u001b[?1049h') === false, 'no alternate screen: the final frame stays above the prompt');
  if (s.name.includes('Ctrl-C')) {
    check(code === 130, 'Ctrl-C exits 130');
    check(text.includes('Stopped. The join was withdrawn.') || text.includes('picks up where you left off'), 'Ctrl-C says what stopped');
    return;
  }
  const at = (needle: string) => text.indexOf(needle);
  check(at('Administrator changes') >= 0 && at('sudo loginctl enable-linger') >= 0, 'the administrator commands are shown before the yes');
  check(at('sudo has this terminal now') > at('Administrator changes'), 'sudo gets the terminal with its notice');
  check(at('sudo has this terminal now') < at('Connect to your account'), 'the administrator steps run before the account');
  check(at('Connect to your account') >= 0, 'the account step asks with its trust detail');
  check(/is set up\.|left\. Run/.test(text), 'the closing frame says how it ended');
  check(code === 0 || code === 1, `exits 0 or 1 (was ${code})`);
}

const filter = process.argv[2];
let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};

for (const s of SCENARIOS.filter((x) => !filter || x.name.includes(filter))) {
  const { text, raw, code } = await run(s);
  if (process.env.KESTREL_PTY_OUT) writeFileSync(join(process.env.KESTREL_PTY_OUT, `${s.name.replace(/[^a-z0-9]+/gi, '-')}.ansi`), raw);
  console.log(`\n=== ${s.name} (${s.piped ? 'piped' : `${s.cols} columns`}${s.env ? `, ${Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}) exit ${code} ===`);
  console.log(text.trimEnd().split('\n').map((l) => `| ${l}`).join('\n'));
  if (s.ink) {
    checkScreen(s, text, raw, code);
    continue;
  }
  const lines = text.split('\n');
  // A line may pass the width only when it is one literal: a command, an address, a key.
  // A literal (a command, an address) is indented past the prose and never wrapped, so it stays one line to copy.
  const literal = (l: string) => /^ {5,}\S/.test(l) || /^ {3}(Open|Code) /.test(l);
  const tooWide = lines.filter((l) => stringWidth(l) > s.cols && !literal(l));
  if (!s.piped) check(tooWide.length === 0, `no prose line wider than ${s.cols} columns${tooWide.length ? `: ${JSON.stringify(tooWide)}` : ''}`);
  check(!raw.includes('\u001b[?25l'), 'the cursor is never hidden');
  const plain = s.piped || s.env?.NO_COLOR !== undefined || s.env?.TERM === 'dumb';
  if (plain) check(!/\u001b\[[0-9;]*m/.test(raw), 'no colour escapes');
  if (s.name.startsWith('wide')) {
    const at = (needle: string) => text.indexOf(needle);
    check(at('Installing bubblewrap and socat') < at('2  Account'), 'the administrator steps run before the account');
    check(text.includes('sudo loginctl enable-linger nodeuser') && text.includes('sudo apt-get install -y bubblewrap socat'), 'the exact commands are shown before the yes');
    check(/(ok:|✓) Lingering is on\./.test(text), 'lingering is on afterwards');
    check(!text.includes('Kestrel worker node: join'), 'the nested join has no second title');
  }
  if (s.name.startsWith('Ctrl-C')) check(code === 130, 'Ctrl-C exits 130');
  if (s.piped) check(!text.includes('[Y/n]'), 'nothing is asked');
}

for (const [cols, shell] of filter ? [] : ([[32, 'sh'], [80, 'sh'], [32, '/bin/dash']] as const)) {
  const { text, code } = await installerPipe(cols, shell);
  console.log(`\n=== curl | ${shell} under a terminal (${cols} columns) exit ${code} ===`);
  console.log(text.trimEnd().split('\n').map((l) => `| ${l}`).join('\n'));
  check(text.includes('configure: input is the terminal'), 'configure reads the terminal, not the pipe');
  check(text.includes('ok: Bundle checksum verified'), 'the checksum is verified before install');
  const wide = text.split('\n').filter((l) => stringWidth(l) > cols && !/^ {7}\S/.test(l));
  check(wide.length === 0, `no prose line wider than ${cols} columns${wide.length ? `: ${JSON.stringify(wide)}` : ''}`);
}

console.log(failed ? `\n${failed} check(s) failed.` : '\nEvery check passed.');
process.exitCode = failed ? 1 : 0;
