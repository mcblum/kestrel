import { expect, test } from 'vitest';
import { chosenFolderHere, folderHere, remotesOfConfig, type HereDeps } from './account-project-here.ts';

const where = (repos: string[], paths: (string | undefined)[]) => ({
  elsewhere: { machines: [{ id: 'm1', name: 'Laptop' }], repos, folders: paths.map((path, i) => ({ name: `f${i}`, isGit: true, ...(path ? { path } : {}) })) },
});
const deps = (remotes: Record<string, string[]>): HereDeps => ({
  home: '/home/me',
  isFolder: async (path) => path in remotes,
  remotes: async (path) => remotes[path] ?? [],
  clonesIn: async (dir) => Object.entries(remotes).filter(([path]) => path.slice(0, path.lastIndexOf('/')) === dir).map(([path, r]) => ({ path, remotes: r })),
});

test('finds the folder the other computer has it in, when it is that repository here', async () => {
  const found = await folderHere(where(['git.example.com/team/core'], ['~/Code/core']), [], deps({ '/home/me/Code/core': ['git@git.example.com:team/core.git'] }));
  expect(found).toEqual({ path: '/home/me/Code/core', shown: '~/Code/core' });
});

test('counts a clone made from another remote of the same project', async () => {
  const found = await folderHere(where(['git.example.com/team/core', 'mirror.example.com/me/core'], ['~/Code/core']), [], deps({ '/home/me/Code/core': ['https://mirror.example.com/me/core'] }));
  expect(found?.path).toBe('/home/me/Code/core');
});

test('finds nothing when the folder is missing, is another repository, or has no remote', async () => {
  const project = where(['git.example.com/team/core'], ['~/Code/core']);
  expect(await folderHere(project, [], deps({}))).toBeNull();
  expect(await folderHere(project, [], deps({ '/home/me/Code/core': ['git@git.example.com:team/other.git'] }))).toBeNull();
  expect(await folderHere(project, [], deps({ '/home/me/Code/core': [] }))).toBeNull();
});

test('never looks outside the home folder, and a plain folder is never found', async () => {
  const outside = deps({ '/etc': ['git@git.example.com:team/core.git'], '/home/me/x': ['git@git.example.com:team/core.git'] });
  expect(await folderHere(where(['git.example.com/team/core'], ['~/../../etc', undefined]), [], outside)).toBeNull();
  expect(await folderHere(where([], ['~/x']), [], outside)).toBeNull();
});

test('finds a clone named after the repository beside where the other computer has it, or beside this computer’s projects', async () => {
  const project = where(['git.example.com/team/core'], ['~/Code/Vireo']);
  expect(await folderHere(project, [], deps({ '/home/me/Code/core': ['git@git.example.com:team/core.git'], '/home/me/Code/other': ['git@git.example.com:team/other.git'] }))).toEqual({ path: '/home/me/Code/core', shown: '~/Code/core' });
  expect(await folderHere(project, ['/work/repos/site'], deps({ '/work/repos/core': ['https://git.example.com/team/core'] }))).toEqual({ path: '/work/repos/core', shown: '/work/repos/core' });
  expect(await folderHere(project, [], deps({ '/work/repos/core': ['https://git.example.com/team/core'] }))).toBeNull();
});

test('reads every remote from a git config, origin first', () => {
  const config = '[core]\n\tbare = false\n[remote "mirror"]\n\turl = https://mirror.example.com/me/core\n\tfetch = +refs/heads/*:refs/remotes/mirror/*\n[remote "origin"]\n\turl = git@git.example.com:team/core.git\n[branch "main"]\n\tremote = origin\n';
  expect(remotesOfConfig(config)).toEqual(['git@git.example.com:team/core.git', 'https://mirror.example.com/me/core']);
  expect(remotesOfConfig('[core]\n')).toEqual([]);
});

test('a chosen folder must be that repository, and the refusal never shows a remote’s address', async () => {
  const project = { name: 'Core', ...where(['git.example.com/team/core'], ['~/Code/core']) };
  const d = deps({ '/x/core': ['git@git.example.com:team/core.git'], '/x/other': ['https://user:secret@git.example.com/team/other.git'], '/x/plain': [] });
  expect(await chosenFolderHere(project, '/x/core', d)).toBe('/x/core');
  await expect(chosenFolderHere(project, '/x/other', d)).rejects.toThrow('/x/other is not a clone of team/core. It is git.example.com/team/other.');
  await expect(chosenFolderHere(project, '/x/plain', d)).rejects.toThrow('it has no git remote');
  await expect(chosenFolderHere(project, '/x/none', d)).rejects.toThrow('is not a folder');
});
