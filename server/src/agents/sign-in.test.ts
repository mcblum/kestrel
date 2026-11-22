import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliSignIn, signInFailure, signInPage, type AgentSignIn } from './sign-in.ts';

const PAGE = 'https://sign-in.example/authorize?code=true&state=abc';

/** A program that behaves like an agent's login command, run with Node. */
function fakeLogin(body: string, options: { onDone?: () => void; limitMs?: number; urlWaitMs?: number } = {}): AgentSignIn {
  const script = join(mkdtempSync(join(tmpdir(), 'kestrel-sign-in-')), 'login.mjs');
  writeFileSync(script, body);
  return cliSignIn({ command: () => ({ file: process.execPath, args: [script], env: process.env }), missing: 'none', ...options });
}

const PRINTS_PAGE = `console.log('Opening browser to sign in…'); console.log("If the browser didn't open, visit: ${PAGE}"); process.stdout.write('Paste code here if prompted > ');`;
const THEN_WAITS_FOR_A_CODE = `process.stdin.once('data', (d) => process.exit(String(d).trim() === 'the-code' ? 0 : 3));`;

describe('reading a sign-in program', () => {
  it('finds the page it asks the user to open', () => {
    expect(signInPage(`Starting local login server on http://localhost:1455.\nnavigate to this URL:\n\n${PAGE}\n`)).toBe(PAGE);
    expect(signInPage('\u001b[1mvisit\u001b[0m https://a.example/x\u001b[0m')).toBe('https://a.example/x');
    expect(signInPage('Opening browser…')).toBeNull();
  });

  it('gives its last words as the reason it failed, never the page or a prompt', () => {
    expect(signInFailure(`visit: ${PAGE}\nPaste code here if prompted > \nLogin failed: the code was not accepted\n`, 1)).toBe('Login failed: the code was not accepted');
    expect(signInFailure('Paste code here if prompted > Login failed: that code was not accepted\n', 1)).toBe('Login failed: that code was not accepted');
    expect(signInFailure('', 2)).toBe('The sign-in program ended with exit code 2.');
  });
});

describe('signing in with the agent\'s own login command', () => {
  it('answers with the page, takes a code, and is done when the program ends well', async () => {
    let done = 0;
    const signIn = fakeLogin(PRINTS_PAGE + THEN_WAITS_FOR_A_CODE, { onDone: () => done++ });
    expect(await signIn.start()).toEqual({ state: 'waiting', url: PAGE });
    // A second start joins the one under way.
    expect(await signIn.start()).toEqual({ state: 'waiting', url: PAGE });
    const ended = signIn.wait();
    signIn.code('  the-code  ');
    expect(await ended).toEqual({ state: 'done' });
    expect(done).toBe(1);
    expect(await signIn.wait()).toEqual({ state: 'done' });
  });

  it('says why when the program ends badly', async () => {
    const signIn = fakeLogin(`console.error('Login failed: no account'); process.exit(1);`);
    await signIn.start();
    expect(await signIn.wait()).toEqual({ state: 'failed', reason: 'Login failed: no account' });
  });

  it('is idle again after it is cancelled, and can start again', async () => {
    const signIn = fakeLogin(PRINTS_PAGE + `setInterval(() => undefined, 1000);`);
    expect(await signIn.start()).toEqual({ state: 'waiting', url: PAGE });
    signIn.cancel();
    expect(await signIn.wait()).toEqual({ state: 'idle' });
    expect(await signIn.start()).toEqual({ state: 'waiting', url: PAGE });
    signIn.cancel();
    await signIn.wait();
  });

  it('answers without a page when the program names none, and gives up after the limit', async () => {
    const signIn = fakeLogin(`setInterval(() => undefined, 1000);`, { urlWaitMs: 50, limitMs: 300 });
    expect(await signIn.start()).toEqual({ state: 'waiting', url: null });
    expect(await signIn.wait()).toEqual({ state: 'failed', reason: 'The sign-in was not finished in time. Start it again.' });
  });

  it('says so when there is no program to run', async () => {
    const signIn = cliSignIn({ command: () => null, missing: 'It is not installed.' });
    expect(await signIn.start()).toEqual({ state: 'failed', reason: 'It is not installed.' });
  });

  it('never hands the program a code with a line break in it', async () => {
    const signIn = fakeLogin(PRINTS_PAGE + THEN_WAITS_FOR_A_CODE);
    await signIn.start();
    signIn.code('the-code\nmore');
    signIn.code('the-code');
    expect(await signIn.wait()).toEqual({ state: 'done' });
  });
});
