import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EMPTY_GIT_SETTINGS, nodeGitPaths, nodeGitSettingsText } from '../shared/node-git.ts';
import { applyNodeGitEnv, readNodeGitSettings } from './node-git-env.ts';

let dataDir: string;
beforeEach(() => void (dataDir = mkdtempSync(join(tmpdir(), 'kestrel-git-env-'))));
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const keep = (settings: object) => {
  mkdirSync(join(dataDir, 'git'), { recursive: true });
  writeFileSync(nodeGitPaths(dataDir).settings, nodeGitSettingsText({ ...EMPTY_GIT_SETTINGS, ...settings }));
};

describe("the node's git settings in the environment its git and agents run in", () => {
  test('nothing kept is no settings; a broken file too', () => {
    expect(readNodeGitSettings(dataDir)).toEqual(EMPTY_GIT_SETTINGS);
    mkdirSync(join(dataDir, 'git'));
    writeFileSync(nodeGitPaths(dataDir).settings, '{oops');
    expect(readNodeGitSettings(dataDir)).toEqual(EMPTY_GIT_SETTINGS);
  });

  test('applied in place, so every holder of the environment sees it; changed again, what went is taken away', () => {
    const env: Record<string, string | undefined> = { PATH: '/bin', GIT_AUTHOR_NAME: 'left from before' };
    const holder = env;
    keep({ key: { fingerprint: 'SHA256:abc', madeAt: 1 }, name: 'Sam Rivera', email: 'sam@example.com', signing: 'node-key' });
    expect(applyNodeGitEnv(env, dataDir, 'node', () => true)).toEqual(expect.arrayContaining(['GIT_SSH_COMMAND', 'GIT_CONFIG_COUNT']));
    // The identity is given as git settings, so a repository's host can change it (per-host identity); the old variables are gone.
    expect(holder.GIT_AUTHOR_NAME).toBeUndefined();
    expect([holder.GIT_CONFIG_KEY_0, holder.GIT_CONFIG_VALUE_0, holder.GIT_CONFIG_KEY_1, holder.GIT_CONFIG_VALUE_1]).toEqual(['user.name', 'Sam Rivera', 'user.email', 'sam@example.com']);
    expect(holder.GIT_CONFIG_VALUE_2).toBe('ssh');
    keep({ key: { fingerprint: 'SHA256:abc', madeAt: 1 }, name: null, email: null, signing: null });
    applyNodeGitEnv(env, dataDir, 'node', () => true);
    expect(holder.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(holder.GIT_CONFIG_COUNT).toBeUndefined();
    expect(holder.GIT_SSH_COMMAND).toContain(nodeGitPaths(dataDir).key);
    expect(holder.PATH).toBe('/bin');
  });

  test('the app is never given any of it', () => {
    keep({ name: 'Sam Rivera', email: 'sam@example.com' });
    const env: Record<string, string | undefined> = { PATH: '/bin' };
    expect(applyNodeGitEnv(env, dataDir, 'app', () => true)).toEqual([]);
    expect(env).toEqual({ PATH: '/bin' });
  });
});
