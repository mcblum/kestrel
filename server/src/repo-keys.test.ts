import { expect, test } from 'vitest';
import type { Project } from './model.ts';
import { RepoKeys } from './repo-keys.ts';

const project = (...paths: string[]): Project => ({ id: 'p1', name: 'Core', defaultFolderId: null, folders: paths.map((path, i) => ({ id: `f${i}`, path, isGit: true })) }) as unknown as Project;

test('a project is every remote of its folders, origin first, each once', async () => {
  const keys = new RepoKeys(async (path) => (path === '/a' ? ['git@git.example.com:team/core.git', 'https://mirror.example.com/me/Core'] : ['https://git.example.com/team/core', 'not an address']));
  expect(await keys.ofProject(project('/a', '/b'))).toEqual(['git.example.com/team/core', 'mirror.example.com/me/core']);
});

test('a folder git cannot read has no keys, and the answer is kept a while', async () => {
  let asked = 0;
  const keys = new RepoKeys(async () => {
    asked++;
    throw new Error('not a repository');
  });
  expect(await keys.ofProject(project('/a'))).toEqual([]);
  expect(await keys.ofProject(project('/a'))).toEqual([]);
  expect(asked).toBe(1);
});
