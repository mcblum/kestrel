import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { wrapperText } from './code-run.ts';
import { runEndMarker } from './shared/code-run.ts';
import { fakePty } from './terminal-test-support.ts';
import { Terminals } from './terminals.ts';
import { Refused } from './workspace.ts';

const make = () => {
  const { spawn, spawned } = fakePty();
  return { terms: new Terminals(spawn, { SHELL: '/bin/zsh' }, { titleCheckMs: 0, titlePollMs: 0 }), spawned };
};
const bash = (script: string) => ({ script, shell: 'bash' as const });
/** Run folders seen; a fake shell never runs the wrapper that would remove them. */
const made: string[] = [];
afterEach(() => made.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
/** The wrapper path typed into the shell, and the nonce inside it. */
const typed = (written: string) => {
  const path = /sh '([^']+)'\r$/.exec(written)![1]!;
  const nonce = /kestrel-run;([0-9a-f]+);/.exec(readFileSync(path, 'utf8'))![1]!;
  made.push(join(path, '..'));
  return { path, nonce, dir: join(path, '..') };
};

describe('running a code block', () => {
  it('opens a Run terminal in the folder and types one command that runs the block from a file', () => {
    const { terms, spawned } = make();
    const id = terms.run('s1', '/work', bash('echo hello'), { cols: 90, rows: 20 });
    expect(spawned[0]!.options).toMatchObject({ cwd: '/work', cols: 90, rows: 20 });
    expect(terms.list('s1')).toEqual([expect.objectContaining({ id, title: 'Run', runner: true, running: 'echo hello' })]);
    const { path, dir } = typed(spawned[0]!.written[0]!);
    expect(spawned[0]!.written[0]!.startsWith('\x15 sh ')).toBe(true);
    expect(readFileSync(join(dir, 'block.sh'), 'utf8')).toBe('echo hello\n');
    expect(readFileSync(path, 'utf8')).toContain("bash -e '");
    terms.closeAll();
  });

  it('ends the run when the wrapper prints its marker, and not before', () => {
    const { terms, spawned } = make();
    terms.run('s1', '/work', bash('sleep 30'), {});
    const { nonce } = typed(spawned[0]!.written[0]!);
    spawned[0]!.emit(' sh /tmp/kestrel-run-x/run.sh\r\n$ sleep 30\r\n');
    expect(terms.list('s1')[0]!.running).toBe('sleep 30');
    const marker = runEndMarker(nonce, 130);
    spawned[0]!.emit(`[stopped]\r\n${marker.slice(0, 9)}`);
    expect(terms.list('s1')[0]!.running).toBe('sleep 30');
    spawned[0]!.emit(`${marker.slice(9)}% `);
    expect(terms.list('s1')[0]!.running).toBeNull();
  });

  it('reuses the Run terminal for the next block and refuses a second while one runs', () => {
    const { terms, spawned } = make();
    const first = terms.run('s1', '/work', bash('echo one'), {});
    expect(() => terms.run('s1', '/work', bash('echo two'), {})).toThrow(Refused);
    spawned[0]!.emit(runEndMarker(typed(spawned[0]!.written[0]!).nonce, 0));
    expect(terms.run('s1', '/work', bash('echo two'), {})).toBe(first);
    expect(spawned).toHaveLength(1);
    expect(terms.list('s1')[0]!.running).toBe('echo two');
    terms.closeAll();
  });

  it('leaves the user\'s own terminals alone', () => {
    const { terms, spawned } = make();
    const own = terms.open('s1', '/work', {});
    const run = terms.run('s1', '/work', bash('ls'), {});
    expect(run).not.toBe(own.id);
    expect(spawned[0]!.written).toEqual([]);
    expect(terms.list('s1').map((t) => t.runner)).toEqual([false, true]);
    terms.closeAll();
  });

  it('refuses while the user has a program in front in the Run terminal', () => {
    const { terms, spawned } = make();
    terms.run('s1', '/work', bash('ls'), {});
    spawned[0]!.emit(runEndMarker(typed(spawned[0]!.written[0]!).nonce, 0));
    spawned[0]!.process = 'vim';
    expect(() => terms.run('s1', '/work', bash('ls'), {})).toThrow(/busy with vim/);
  });

  it('stops a run with Ctrl-C, and does nothing when nothing runs', () => {
    const { terms, spawned } = make();
    terms.stopRun('s1');
    terms.run('s1', '/work', bash('sleep 30'), {});
    terms.stopRun('s1');
    expect(spawned[0]!.written.at(-1)).toBe('\x03');
    terms.closeAll();
  });

  it('forgets the run and removes its files when the shell ends first, and opens a fresh Run terminal next time', () => {
    const { terms, spawned } = make();
    terms.run('s1', '/work', bash('exit'), {});
    const { dir } = typed(spawned[0]!.written[0]!);
    spawned[0]!.end(0);
    expect(existsSync(dir)).toBe(false);
    expect(terms.list('s1')[0]!).toMatchObject({ exited: true, running: null });
    terms.run('s1', '/work', bash('ls'), {});
    expect(spawned).toHaveLength(2);
    expect(terms.list('s1')).toHaveLength(1);
    terms.closeAll();
  });
});

describe('the run wrapper', () => {
  it('shows the block, runs it in the folder stopping at the first failure, cleans up and prints the marker with the code', () => {
    const text = wrapperText('/tmp/d', "/my folder/it's", { script: 'echo a\necho b', shell: 'zsh' }, 'n1');
    expect(text).toContain("'$ echo a' '$ echo b'");
    expect(text).toContain(`if cd -- '/my folder/it'\\''s'; then zsh -e '/tmp/d/block.sh'; code=$?; else code=1; fi`);
    expect(text).toContain('trap : INT');
    expect(text).toContain("rm -rf -- '/tmp/d'");
    expect(text).toContain(`printf '\\033]777;kestrel-run;n1;%d\\007' "$code"`);
  });
});

describe('on Windows', () => {
  const windows = () => {
    const { spawn, spawned } = fakePty();
    return { terms: new Terminals(spawn, { SHELL: '/bin/zsh' }, { titleCheckMs: 0, titlePollMs: 0, platform: 'windows' }), spawned };
  };

  it('a terminal is PowerShell, with no login flag', () => {
    const { terms, spawned } = windows();
    terms.open('s1', 'C:\\work', { cols: 90, rows: 20 });
    expect(spawned[0]).toMatchObject({ shell: 'powershell.exe', args: [] });
  });

  it('running a code block is refused with the reason, and opens no terminal', () => {
    const { terms, spawned } = windows();
    expect(() => terms.run('s1', 'C:\\work', bash('echo hello'), { cols: 90, rows: 20 })).toThrow(Refused);
    expect(() => terms.run('s1', 'C:\\work', bash('echo hello'), { cols: 90, rows: 20 })).toThrow(/not available on Windows yet/);
    expect(spawned).toHaveLength(0);
  });
});
