// Settings → Git on the server: the cached gh and glab login lookups and "Your username" falling back
// from one to the other, storing and checking the branch prefix, the prefix a new branch gets (with
// its fallbacks), and the HTTP route. gh and glab are never run: the runner is a stand-in.
import { describe, expect, it } from 'vitest';
import { memorySettings } from '../suggestions/prefs.ts';
import type { CommandRunner } from '../pull-requests/types.ts';
import { gitSettingsRoute } from './api.ts';
import { githubLoginLookup, loginFromOutput, LOGIN_ARGS, type AccountLogin } from './github-login.ts';
import { GIT_PREFS_KEY, GitPrefs } from './prefs.ts';

const signedIn = (login = 'mcblum') => async (): Promise<AccountLogin> => ({ available: true, login, service: 'GitHub' });
const signedOut = async (): Promise<AccountLogin> => ({ available: false, reason: 'gh is not signed in to GitHub (run gh auth login)' });

describe('githubLoginLookup', () => {
  it('asks gh once with an argument list and a time limit, then answers from memory', async () => {
    const calls: { command: string; args: readonly string[]; timeoutMs: number }[] = [];
    const run: CommandRunner = async (command, args, { timeoutMs }) => {
      calls.push({ command, args, timeoutMs });
      return { stdout: 'mcblum\n' };
    };
    const lookup = githubLoginLookup(run, '/tmp');
    expect(await lookup()).toEqual({ available: true, login: 'mcblum', service: 'GitHub' });
    expect(await lookup()).toEqual({ available: true, login: 'mcblum', service: 'GitHub' });
    expect(calls).toEqual([{ command: 'gh', args: LOGIN_ARGS, timeoutMs: expect.any(Number) }]);
    expect(calls[0]!.timeoutMs).toBeGreaterThan(0);
  });

  it('says why when gh is missing or signed out', async () => {
    const missing = githubLoginLookup(async () => Promise.reject(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })), '/tmp');
    expect(await missing()).toEqual({ available: false, reason: expect.stringMatching(/not installed/) });
    const out = githubLoginLookup(async () => Promise.reject(Object.assign(new Error('exit 4'), { stderr: 'To get started with GitHub CLI, please run:  gh auth login' })), '/tmp');
    expect(await out()).toEqual({ available: false, reason: expect.stringMatching(/not signed in/) });
  });

  it('refuses an empty or unusable answer', () => {
    expect(loginFromOutput('  ')).toMatchObject({ available: false });
    expect(loginFromOutput('two words')).toMatchObject({ available: false });
  });
});

describe('GitPrefs', () => {
  it('starts on kestrel, and keeps what is saved', async () => {
    const store = memorySettings();
    const prefs = new GitPrefs({ settings: store, username: signedIn() });
    expect(await prefs.view()).toEqual({ branchPrefix: { choice: 'kestrel', custom: '' }, startFromLatest: true, username: { available: true, login: 'mcblum', service: 'GitHub' } });
    await prefs.setBranchPrefix({ choice: 'custom', custom: 'team/me' });
    expect(await new GitPrefs({ settings: store, username: signedIn() }).branchPrefix()).toEqual({ choice: 'custom', custom: 'team/me' });
  });

  it('refuses an invalid custom prefix and keeps the old setting', async () => {
    const prefs = new GitPrefs({ username: signedIn() });
    await prefs.setBranchPrefix({ choice: 'none', custom: '' });
    await expect(prefs.setBranchPrefix({ choice: 'custom', custom: 'my prefix' })).rejects.toThrow(/spaces/);
    await expect(prefs.setBranchPrefix({ choice: 'custom', custom: '' })).rejects.toThrow(/Enter a prefix/);
    await expect(prefs.setBranchPrefix({ choice: 'sideways', custom: '' })).rejects.toThrow(/choice/);
    expect(await prefs.branchPrefix()).toEqual({ choice: 'none', custom: '' });
  });

  it('refuses the username choice while neither gh nor glab can say who is signed in', async () => {
    const prefs = new GitPrefs({ username: signedOut });
    await expect(prefs.setBranchPrefix({ choice: 'username', custom: '' })).rejects.toThrow(/Your username is not available: gh is not signed in/);
  });

  it('still takes the choice by its old name, github, and stores it as username', async () => {
    const store = memorySettings();
    const prefs = new GitPrefs({ settings: store, username: signedIn() });
    expect((await prefs.setBranchPrefix({ choice: 'github', custom: '' })).branchPrefix).toEqual({ choice: 'username', custom: '' });
    await store.putSetting(GIT_PREFS_KEY, JSON.stringify({ branchPrefix: { choice: 'github', custom: '' } }));
    expect(await prefs.prefixForNewBranch()).toBe('mcblum');
  });

  it('resolves the prefix for a new branch, falling back to kestrel', async () => {
    const store = memorySettings();
    const prefs = new GitPrefs({ settings: store, username: signedIn() });
    expect(await prefs.prefixForNewBranch()).toBe('kestrel');
    await prefs.setBranchPrefix({ choice: 'username', custom: '' });
    expect(await prefs.prefixForNewBranch()).toBe('mcblum');
    // Saved while signed in, signed out since: the default.
    expect(await new GitPrefs({ settings: store, username: signedOut }).prefixForNewBranch()).toBe('kestrel');
    await prefs.setBranchPrefix({ choice: 'none', custom: '' });
    expect(await prefs.prefixForNewBranch()).toBe('');
  });

  it('reads an unreadable stored value as the default, and never throws when resolving', async () => {
    const store = memorySettings();
    await store.putSetting(GIT_PREFS_KEY, '{not json');
    expect(await new GitPrefs({ settings: store, username: signedIn() }).branchPrefix()).toEqual({ choice: 'kestrel', custom: '' });
    const broken = new GitPrefs({ settings: { getSetting: () => Promise.reject(new Error('disk gone')), putSetting: async () => undefined }, username: signedIn() });
    const quiet = console.error;
    console.error = () => undefined;
    try {
      expect(await broken.prefixForNewBranch()).toBe('kestrel');
    } finally {
      console.error = quiet;
    }
  });
});

describe('Start new sessions from the latest base branch', () => {
  it('is on by default, keeps a change, and keeps the branch prefix beside it', async () => {
    const store = memorySettings();
    const prefs = new GitPrefs({ settings: store, username: signedIn() });
    expect(await prefs.startFromLatest()).toBe(true);
    await prefs.setBranchPrefix({ choice: 'none', custom: '' });
    expect((await prefs.setStartFromLatest(false)).startFromLatest).toBe(false);
    await prefs.setBranchPrefix({ choice: 'custom', custom: 'me' });
    const again = new GitPrefs({ settings: store, username: signedIn() });
    expect(await again.startFromLatest()).toBe(false);
    expect(await again.branchPrefix()).toEqual({ choice: 'custom', custom: 'me' });
  });

  it('refuses anything but true or false, and reads a broken store as on', async () => {
    const prefs = new GitPrefs({ username: signedIn() });
    await expect(prefs.setStartFromLatest('no')).rejects.toThrow(/true or false/);
    const broken = new GitPrefs({ settings: { getSetting: () => Promise.reject(new Error('disk gone')), putSetting: async () => undefined }, username: signedIn() });
    const quiet = console.error;
    console.error = () => undefined;
    try {
      expect(await broken.startFromLatest()).toBe(true);
    } finally {
      console.error = quiet;
    }
  });
});

describe('gitSettingsRoute', () => {
  it('changes startFromLatest alone, and refuses a value that is not a boolean', async () => {
    const prefs = new GitPrefs({ username: signedIn() });
    const body = (value: Record<string, unknown>) => async () => value;
    expect(await gitSettingsRoute(['api', 'git-settings'], 'PATCH', body({ startFromLatest: false }), prefs)).toMatchObject({ status: 200, body: { startFromLatest: false, branchPrefix: { choice: 'kestrel' } } });
    expect(await gitSettingsRoute(['api', 'git-settings'], 'PATCH', body({ startFromLatest: 1 }), prefs)).toEqual({ status: 400, body: { error: 'startFromLatest must be true or false.' } });
  });

  const body = (value: Record<string, unknown>) => async () => value;

  it('answers GET and PATCH, refuses a bad prefix with the reason, ignores other paths', async () => {
    const prefs = new GitPrefs({ username: signedIn() });
    expect(await gitSettingsRoute(['api', 'git-settings'], 'GET', body({}), prefs)).toEqual({ status: 200, body: { branchPrefix: { choice: 'kestrel', custom: '' }, startFromLatest: true, username: { available: true, login: 'mcblum', service: 'GitHub' } } });
    expect(await gitSettingsRoute(['api', 'git-settings'], 'PATCH', body({ branchPrefix: { choice: 'custom', custom: 'me' } }), prefs)).toMatchObject({ status: 200, body: { branchPrefix: { choice: 'custom', custom: 'me' } } });
    expect(await gitSettingsRoute(['api', 'git-settings'], 'PATCH', body({ branchPrefix: { choice: 'custom', custom: 'a..b' } }), prefs)).toEqual({ status: 400, body: { error: expect.stringMatching(/\.\./) } });
    expect(await gitSettingsRoute(['api', 'git-settings'], 'PATCH', body({}), prefs)).toMatchObject({ status: 400 });
    expect(await gitSettingsRoute(['api', 'other'], 'GET', body({}), prefs)).toBeNull();
    expect(await gitSettingsRoute(['api', 'git-settings'], 'DELETE', body({}), prefs)).toBeNull();
  });
});
