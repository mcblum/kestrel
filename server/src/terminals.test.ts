import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scrollback, Terminals, terminalEnv } from './terminals.ts';
import { numberTitles } from './shared/terminals.ts';
import { fakePty } from './terminal-test-support.ts';
import { Refused } from './workspace.ts';

const client = () => {
  const got: string[] = [];
  const exits: number[] = [];
  return { got, exits, data: (t: string) => void got.push(t), exit: (c: number) => void exits.push(c) };
};
/** Title checks on every output, so tests need no clock. */
const make = (env: Record<string, string> = { SHELL: '/bin/zsh' }) => {
  const { spawn, spawned } = fakePty();
  return { terms: new Terminals(spawn, env, { titleCheckMs: 0, titlePollMs: 0 }), spawned };
};

describe('the user\'s terminals', () => {
  it('starts a login shell in the session folder and passes output and input through', () => {
    const { terms, spawned } = make({ SHELL: '/bin/zsh', HOME: '/h' });
    const { id } = terms.open('s1', '/work', { cols: 120, rows: 40 });
    const c = client();
    terms.attach('s1', id, { cols: 120, rows: 40 }, c);
    expect(spawned[0]).toMatchObject({ shell: '/bin/zsh', args: ['-l'], options: { cwd: '/work', cols: 120, rows: 40 } });
    spawned[0]!.emit('hello');
    terms.write('s1', id, 'ls\r');
    expect(c.got).toEqual(['hello']);
    expect(spawned[0]!.written).toEqual(['ls\r']);
  });

  it('keeps several shells per session, each with its own output', () => {
    const { terms, spawned } = make();
    const a = terms.open('s1', '/work', {});
    const b = terms.open('s1', '/work', {});
    terms.open('s2', '/other', {});
    expect(a.id).not.toBe(b.id);
    expect(terms.list('s1').map((t) => t.id)).toEqual([a.id, b.id]);
    expect(terms.list('s2')).toHaveLength(1);
    const ca = client();
    const cb = client();
    terms.attach('s1', a.id, {}, ca);
    terms.attach('s1', b.id, {}, cb);
    spawned[0]!.emit('from a');
    spawned[1]!.emit('from b');
    terms.write('s1', b.id, 'pwd\r');
    expect(ca.got).toEqual(['from a']);
    expect(cb.got).toEqual(['from b']);
    expect(spawned[0]!.written).toEqual([]);
    expect(spawned[1]!.written).toEqual(['pwd\r']);
  });

  it('replays recent output to a client that comes back, and keeps the shell running meanwhile', () => {
    const { terms, spawned } = make();
    const { id } = terms.open('s1', '/work', {});
    const first = client();
    terms.attach('s1', id, {}, first);
    spawned[0]!.emit('one ');
    terms.detach('s1', id, first);
    spawned[0]!.emit('two');
    const second = client();
    terms.attach('s1', id, { cols: 90, rows: 20 }, second);
    expect(spawned).toHaveLength(1);
    expect(first.got).toEqual(['one ']);
    expect(second.got).toEqual(['one two']);
    expect(spawned[0]!.sizes.at(-1)).toEqual([90, 20]);
  });

  it('holds scrollback to its limit, starting the replay on a whole line', () => {
    const scrollback = new Scrollback(20);
    scrollback.add('aaaa\nbbbb\n');
    scrollback.add('cccc\ndddd\n');
    scrollback.add('eeee\n');
    expect(scrollback.text()).toBe('cccc\ndddd\neeee\n');
    const long = new Scrollback(10);
    long.add('x'.repeat(50));
    expect(long.text()).toBe('x'.repeat(10));
  });

  it('refuses a ninth terminal with a reason', () => {
    const { terms } = make();
    for (let i = 0; i < 8; i++) terms.open('s1', '/work', {});
    expect(() => terms.open('s1', '/work', {})).toThrow(Refused);
    expect(() => terms.open('s1', '/work', {})).toThrow(/at most 8 terminals/);
    expect(terms.list('s1')).toHaveLength(8);
    expect(terms.open('s2', '/work', {}).id).toBeTruthy(); // the cap is per session
  });

  it('kills every shell of a session when it is deleted, and says so', () => {
    const { terms, spawned } = make();
    terms.open('s1', '/work', {});
    terms.open('s1', '/work', {});
    const other = terms.open('s2', '/work', {});
    const changes: string[] = [];
    terms.onChange((id) => changes.push(id));
    terms.kill('s1');
    expect(spawned.map((s) => s.killed)).toEqual([true, true, false]);
    expect(terms.list('s1')).toEqual([]);
    expect(terms.list('s2').map((t) => t.id)).toEqual([other.id]);
    expect(changes).toEqual(['s1']);
  });

  it('keeps an exited shell listed as exited until its tab is closed', () => {
    const { terms, spawned } = make();
    const { id } = terms.open('s1', '/work', {});
    const c = client();
    terms.attach('s1', id, {}, c);
    spawned[0]!.emit('bye\r\n');
    spawned[0]!.end(3);
    expect(c.exits).toEqual([3]);
    expect(terms.list('s1')).toMatchObject([{ id, exited: true, exitCode: 3, busy: false }]);
    terms.write('s1', id, 'ignored');
    expect(spawned[0]!.written).toEqual([]);
    // Coming back to it shows what it said and that it ended.
    const later = client();
    expect(terms.attach('s1', id, {}, later)).toBe(true);
    expect(later).toMatchObject({ got: ['bye\r\n'], exits: [3] });
    terms.close('s1', id);
    expect(terms.list('s1')).toEqual([]);
    expect(spawned[0]!.killed).toBe(false); // it had already ended
    expect(terms.attach('s1', id, {}, client())).toBe(false);
  });

  it('closing a tab ends its shell and leaves the others', () => {
    const { terms, spawned } = make();
    const a = terms.open('s1', '/work', {});
    const b = terms.open('s1', '/work', {});
    terms.close('s1', a.id);
    expect(spawned[0]!.killed).toBe(true);
    expect(spawned[1]!.killed).toBe(false);
    expect(terms.list('s1').map((t) => t.id)).toEqual([b.id]);
  });

  it('moves a tab beside another; unknown ids change nothing', () => {
    const { terms } = make();
    const [a, b, c] = [terms.open('s1', '/work', {}), terms.open('s1', '/work', {}), terms.open('s1', '/work', {})];
    const changes: string[] = [];
    terms.onChange((id) => changes.push(id));
    terms.move('s1', c.id, a.id, false);
    expect(terms.list('s1').map((t) => t.id)).toEqual([c.id, a.id, b.id]);
    terms.move('s1', c.id, b.id, true);
    expect(terms.list('s1').map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    terms.move('s1', 'nope', a.id, false);
    terms.move('s2', a.id, b.id, false);
    expect(changes).toEqual(['s1', 's1']);
  });

  it('titles a tab after the program in front, numbering repeats, and keeps a name the user gave', () => {
    const { terms, spawned } = make();
    terms.open('s1', '/work', {});
    const b = terms.open('s1', '/work', {});
    expect(terms.list('s1').map((t) => t.title)).toEqual(['zsh', 'zsh 2']);
    const changes: string[] = [];
    terms.onChange((id) => changes.push(id));
    spawned[0]!.process = 'vim';
    spawned[0]!.emit('~');
    expect(changes).toEqual(['s1']);
    expect(terms.list('s1')).toMatchObject([{ title: 'vim', busy: true }, { title: 'zsh', busy: false }]);
    spawned[0]!.emit('more'); // same program: nothing to say
    expect(changes).toEqual(['s1']);
    terms.rename('s1', b.id, '  dev   server ');
    spawned[1]!.process = 'node';
    spawned[1]!.emit('listening');
    expect(terms.list('s1')).toMatchObject([{ title: 'vim' }, { title: 'dev server', renamed: true, busy: true }]);
    terms.rename('s1', b.id, '');
    expect(terms.list('s1')[1]).toMatchObject({ title: 'node', renamed: false });
  });

  describe('a quiet program (no output)', () => {
    afterEach(() => vi.useRealTimers());
    const quiet = () => {
      vi.useFakeTimers();
      const { spawn, spawned } = fakePty();
      return { terms: new Terminals(spawn, { SHELL: '/bin/zsh' }, { titleCheckMs: 0, titlePollMs: 1000 }), spawned };
    };

    it('still shows in the title while someone watches the terminal', () => {
      const { terms, spawned } = quiet();
      const { id } = terms.open('s1', '/work', {});
      const c = client();
      terms.attach('s1', id, {}, c);
      spawned[0]!.process = 'sleep';
      expect(terms.list('s1')[0]).toMatchObject({ title: 'zsh', busy: false });
      vi.advanceTimersByTime(1000);
      expect(terms.list('s1')[0]).toMatchObject({ title: 'sleep', busy: true });
      spawned[0]!.process = 'zsh';
      vi.advanceTimersByTime(1000);
      expect(terms.list('s1')[0]).toMatchObject({ title: 'zsh', busy: false });
    });

    it('is not checked while nobody watches, and checking stops when the last client leaves or the shell ends', () => {
      const { terms, spawned } = quiet();
      const { id } = terms.open('s1', '/work', {});
      expect(vi.getTimerCount()).toBe(0);
      const a = client();
      const b = client();
      terms.attach('s1', id, {}, a);
      terms.attach('s1', id, {}, b);
      expect(vi.getTimerCount()).toBe(1);
      terms.detach('s1', id, a);
      expect(vi.getTimerCount()).toBe(1);
      terms.forget(b);
      expect(vi.getTimerCount()).toBe(0);
      spawned[0]!.process = 'sleep';
      vi.advanceTimersByTime(5000);
      expect(terms.list('s1')[0]!.title).toBe('zsh');
      terms.attach('s1', id, {}, a);
      expect(vi.getTimerCount()).toBe(1);
      spawned[0]!.end(0);
      expect(vi.getTimerCount()).toBe(0);
      const other = terms.open('s1', '/work', {});
      terms.attach('s1', other.id, {}, b);
      terms.close('s1', other.id);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('falls back to the shell name when node-pty cannot name the program', () => {
    const { terms, spawned } = make({ SHELL: '/usr/local/bin/fish' });
    terms.open('s1', '/work', {});
    spawned[0]!.process = '';
    spawned[0]!.emit('x');
    expect(terms.list('s1')[0]!.title).toBe('fish');
  });

  it('numbers only automatic titles', () => {
    expect(numberTitles([{ custom: null, program: 'zsh' }, { custom: 'zsh', program: 'zsh' }, { custom: null, program: 'zsh' }])).toEqual(['zsh', 'zsh', 'zsh 3']);
  });

  it('holds sizes to sane limits and kills every shell on close', () => {
    const { terms, spawned } = make();
    terms.open('s1', '/work', { cols: 99999, rows: -4 });
    terms.open('s2', '/work', {});
    expect(spawned[0]!.options).toMatchObject({ cols: 500, rows: 2 });
    terms.closeAll();
    expect(spawned.every((s) => s.killed)).toBe(true);
  });

  it('gives the shell the user\'s environment without Kestrel\'s token or Electron\'s switches', () => {
    const env = terminalEnv({ PATH: '/bin', KESTREL_TOKEN: 'secret', KESTREL_PORT: '1', ELECTRON_RUN_AS_NODE: '1', EMPTY: undefined });
    expect(env).toEqual({ PATH: '/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  });
});
