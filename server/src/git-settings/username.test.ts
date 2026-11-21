// "Your username": gh's GitHub login first, else glab's GitLab username for glab's default host, else
// both reasons. glab and gh are never run: the runner and the sign-in check are stand-ins.
import { describe, expect, it } from 'vitest';
import type { GlabSignIn } from '../pull-requests/glab.ts';
import type { CommandRunner } from '../pull-requests/types.ts';
import type { AccountLogin } from './github-login.ts';
import { gitlabLoginFromOutput, gitlabLoginLookup, hostFromConfig } from './gitlab-login.ts';
import { usernameLookup } from './username.ts';

const github = (answer: AccountLogin) => async () => answer;
const gh = { available: true as const, login: 'octo', service: 'GitHub' };
const ghOut = { available: false as const, reason: 'gh is not signed in to GitHub (run gh auth login)' };

function glab(answers: Record<string, string | object>) {
  const calls: string[] = [];
  const run: CommandRunner = async (bin, args) => {
    const key = [bin, ...args].join(' ');
    calls.push(key);
    const answer = answers[key];
    if (answer === undefined) throw new Error(`unexpected command: ${key}`);
    if (typeof answer !== 'string') throw answer;
    return { stdout: answer };
  };
  return { run, calls };
}
const signedIn = async (): Promise<GlabSignIn> => ({ signedIn: true });

describe('usernameLookup', () => {
  it('uses the GitHub login when gh has one, without asking glab', async () => {
    let askedGlab = false;
    const lookup = usernameLookup(github(gh), async () => ((askedGlab = true), { available: true, login: 'x', service: 'GitLab' }));
    expect(await lookup()).toEqual(gh);
    expect(askedGlab).toBe(false);
  });
  it('falls back to the GitLab username, else says both reasons', async () => {
    const lab: AccountLogin = { available: true, login: 'mcblum', service: 'starfish.example.io' };
    expect(await usernameLookup(github(ghOut), github(lab))()).toEqual(lab);
    expect(await usernameLookup(github(ghOut), github({ available: false, reason: 'glab is not there' }))()).toEqual({ available: false, reason: 'gh is not signed in to GitHub (run gh auth login); glab is not there' });
  });
});

describe('gitlabLoginLookup', () => {
  it('reads glab’s default host, checks it is signed in, then asks for the user, once', async () => {
    const { run, calls } = glab({ 'glab config get host --global': 'starfish.example.io\n', 'glab api --hostname starfish.example.io user': JSON.stringify({ id: 3, username: 'mcblum' }) });
    const checked: string[] = [];
    const lookup = gitlabLoginLookup(run, async (host) => (checked.push(host), { signedIn: true }), '/home');
    expect(await lookup()).toEqual({ available: true, login: 'mcblum', service: 'starfish.example.io' });
    expect(await lookup()).toEqual({ available: true, login: 'mcblum', service: 'starfish.example.io' });
    expect(calls).toEqual(['glab config get host --global', 'glab api --hostname starfish.example.io user']);
    expect(checked).toEqual(['starfish.example.io']);
  });
  it('uses gitlab.com when no host is set, and says so plainly when glab is missing or signed out', async () => {
    const unset = glab({ 'glab config get host --global': '', 'glab api --hostname gitlab.com user': JSON.stringify({ username: 'me' }) });
    expect(await gitlabLoginLookup(unset.run, signedIn, '/home')()).toEqual({ available: true, login: 'me', service: 'GitLab' });
    const missing = glab({ 'glab config get host --global': { code: 'ENOENT' } });
    expect(await gitlabLoginLookup(missing.run, signedIn, '/home')()).toEqual({ available: false, reason: 'The glab command is not installed (or not on Kestrel’s PATH)' });
    const out = glab({ 'glab config get host --global': 'gitlab.com' });
    expect(await gitlabLoginLookup(out.run, async () => ({ signedIn: false, reason: 'not signed in' }), '/home')()).toEqual({ available: false, reason: 'not signed in' });
    expect(out.calls).toEqual(['glab config get host --global']);
  });
  it('refuses an unreadable or unusable answer', () => {
    expect(gitlabLoginFromOutput('nope', 'gitlab.com')).toMatchObject({ available: false });
    expect(gitlabLoginFromOutput('{}', 'gitlab.com')).toMatchObject({ available: false });
    expect(gitlabLoginFromOutput('{"username":"two words"}', 'gitlab.com')).toMatchObject({ available: false });
    expect(hostFromConfig('https://starfish.example.io/\n')).toBe('starfish.example.io');
  });
});
