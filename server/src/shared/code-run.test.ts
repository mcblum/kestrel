import { describe, expect, it } from 'vitest';
import { MAX_RUN_SCRIPT_CHARS, runEndMarker, runnableBlock, scanRunEnd, shellQuote } from './code-run.ts';

describe('which code blocks can run', () => {
  it('runs shell languages as they are, zsh in zsh and the rest in bash', () => {
    expect(runnableBlock('bash', 'echo hi\n')).toEqual({ script: 'echo hi', shell: 'bash' });
    expect(runnableBlock('sh', 'ls')).toEqual({ script: 'ls', shell: 'bash' });
    expect(runnableBlock('Shell', 'ls')).toEqual({ script: 'ls', shell: 'bash' });
    expect(runnableBlock('zsh', 'print -l a b')).toEqual({ script: 'print -l a b', shell: 'zsh' });
  });

  it('keeps a multi-line block whole and in order', () => {
    expect(runnableBlock('bash', 'cd app\npnpm install\npnpm test\n')?.script).toBe('cd app\npnpm install\npnpm test');
  });

  it('gives other languages and blocks with no language nothing to run', () => {
    expect(runnableBlock('ts', 'const a = 1')).toBeNull();
    expect(runnableBlock('', 'echo hi')).toBeNull();
    expect(runnableBlock(undefined, 'echo hi')).toBeNull();
    expect(runnableBlock('python', 'print(1)')).toBeNull();
  });

  it('runs only the prompted lines of a console transcript, prompt removed', () => {
    const transcript = '$ echo one\none\n$ ls -a\n.  ..\n';
    expect(runnableBlock('console', transcript)).toEqual({ script: 'echo one\nls -a', shell: 'bash' });
    expect(runnableBlock('shell-session', '$ pwd\n/home')?.script).toBe('pwd');
  });

  it('runs a transcript with no prompts as it is', () => {
    expect(runnableBlock('console', 'make build')?.script).toBe('make build');
  });

  it('offers nothing for an empty or oversized block', () => {
    expect(runnableBlock('bash', '\n  \n')).toBeNull();
    expect(runnableBlock('bash', 'x'.repeat(MAX_RUN_SCRIPT_CHARS))).toBeNull();
  });
});

describe('the end of a run', () => {
  it('finds the marker and its exit code', () => {
    expect(scanRunEnd('', `done\r\n${runEndMarker('abc', 0)}$ `, 'abc').code).toBe(0);
    expect(scanRunEnd('', runEndMarker('abc', 130), 'abc').code).toBe(130);
  });

  it('ignores another run\'s marker and ordinary output', () => {
    expect(scanRunEnd('', runEndMarker('other', 0), 'abc').code).toBeNull();
    expect(scanRunEnd('', 'kestrel-run abc 0', 'abc').code).toBeNull();
  });

  it('finds a marker split across chunks', () => {
    const marker = runEndMarker('abc', 2);
    for (let cut = 1; cut < marker.length; cut++) {
      const first = scanRunEnd('', `output ${marker.slice(0, cut)}`, 'abc');
      expect(first.code).toBeNull();
      expect(scanRunEnd(first.carry, marker.slice(cut), 'abc').code).toBe(2);
    }
  });

  it('keeps only a short tail between chunks', () => {
    expect(scanRunEnd('', 'x'.repeat(10_000), 'abc').carry.length).toBeLessThan(64);
  });
});

describe('shell quoting', () => {
  it('quotes single quotes so the shell reads the value back unchanged', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('/a b/c')).toBe(`'/a b/c'`);
  });
});
