import { describe, expect, it } from 'vitest';
import { claudeInstalled, claudeProgram, claudeSignedIn, claudeSignInAdvice, signedInFromStatus } from './sign-in.ts';

describe('what `claude auth status` says', () => {
  it('reads signed in and signed out', () => {
    expect(signedInFromStatus('{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty"}')).toBe(true);
    expect(signedInFromStatus('{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}')).toBe(false);
    expect(signedInFromStatus('{"loggedIn": false}')).toBe(false);
  });

  it('cannot tell for another provider, or an answer it cannot read', () => {
    expect(signedInFromStatus('{"loggedIn": false, "apiProvider": "bedrock"}')).toBeNull();
    expect(signedInFromStatus('Not logged in')).toBeNull();
    expect(signedInFromStatus('')).toBeNull();
    expect(signedInFromStatus('null')).toBeNull();
  });
});

describe('whether Claude is signed in', () => {
  it('asks the program, with nothing in the environment that would change the sign-in', async () => {
    const asked: { program: string; env: Record<string, string | undefined> }[] = [];
    const run = async (program: string, env: Record<string, string | undefined>) => (asked.push({ program, env }), '{"loggedIn": false, "apiProvider": "firstParty"}');
    expect(await claudeSignedIn({ HOME: '/home/someone', ANTHROPIC_API_KEY: 'a-key', CLAUDECODE: '1' }, '/app/bin/claude', run)).toBe(false);
    expect(asked).toEqual([{ program: '/app/bin/claude', env: { HOME: '/home/someone' } }]);
  });

  it('cannot tell without a program', async () => {
    expect(await claudeSignedIn({}, null, async () => '{"loggedIn": true}')).toBeNull();
  });
});

describe('the Claude Code program Kestrel runs', () => {
  const none = () => null;

  it('is the one the app ships, when it is there', () => {
    const env = { KESTREL_CLAUDE_EXECUTABLE: '/app/bin/claude' };
    expect(claudeProgram(env, 'mac', 'arm64', () => true, none)).toBe('/app/bin/claude');
    expect(claudeProgram(env, 'mac', 'arm64', () => false, none)).toBeNull();
  });

  it("is the SDK's own from a checkout, named for each kind of computer", () => {
    const sdk = () => '/sdk';
    expect(claudeProgram({}, 'mac', 'arm64', () => true, sdk)).toBe('/sdk/claude');
    expect(claudeProgram({}, 'linux', 'x64', () => true, sdk)).toBe('/sdk/claude');
    expect(claudeProgram({}, 'windows', 'x64', () => true, sdk)).toMatch(/claude\.exe$/);
    expect(claudeProgram({}, 'mac', 'arm64', () => true, none)).toBeNull();
  });
});

describe("what of Claude's is on this computer", () => {
  it('finds the desktop app and a `claude` command on each kind of computer', () => {
    const has = (...paths: string[]) => (path: string) => paths.includes(path);
    expect(claudeInstalled({ PATH: '/usr/bin' }, 'mac', has('/Applications/Claude.app'), '/home/someone')).toEqual({ desktop: true, cli: false });
    expect(claudeInstalled({ PATH: '/usr/bin' }, 'mac', has('/usr/bin/claude'), '/home/someone')).toEqual({ desktop: false, cli: true });
    expect(claudeInstalled({ PATH: '' }, 'linux', has('/home/someone/.local/bin/claude'), '/home/someone')).toEqual({ desktop: false, cli: true });
    expect(claudeInstalled({ PATH: '' }, 'linux', has('/Applications/Claude.app'), '/home/someone')).toEqual({ desktop: false, cli: false });
  });
});

describe('the sign-in advice', () => {
  it('says the desktop sign-in is not shared when that is all there is', () => {
    expect(claudeSignInAdvice({ desktop: true, cli: false })).toContain('Signing in to the Claude desktop app does not sign Kestrel in');
  });

  it('names the terminal way too when there is a `claude` command, or no desktop app', () => {
    expect(claudeSignInAdvice({ desktop: true, cli: true })).toContain('run `claude` in a terminal');
    expect(claudeSignInAdvice({ desktop: false, cli: false })).toContain('choose Sign in');
    expect(claudeSignInAdvice({ desktop: false, cli: false })).not.toContain('send again');
  });

  it('always reads as not signed in', () => {
    for (const installed of [{ desktop: true, cli: false }, { desktop: false, cli: true }]) expect(claudeSignInAdvice(installed)).toMatch(/^Claude is not signed in/);
  });
});
