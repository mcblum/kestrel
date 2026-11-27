import { expect, test } from 'vitest';
import { ADOPTED_KEY, AdoptHere, type AdoptDeps } from './account-adopt.ts';
import type { Project } from './model.ts';

const away = (name: string, repos: string[]): Project => ({ id: `account|${repos[0] ?? name}`, name, folders: [], defaultFolderId: null, away: true, elsewhere: { machines: [{ id: 'm1', name: 'Laptop' }], repos, folders: [{ name, isGit: true, path: `~/Code/${name}` }] } }) as Project;

function world(projects: Project[], onDisk: string[]) {
  const settings = new Map<string, string>();
  const created: string[] = [];
  let finds = 0;
  const deps: AdoptDeps = {
    view: async () => ({ projects }),
    find: async (p) => {
      finds++;
      return onDisk.includes(p.name) ? { path: `/home/me/Code/${p.name}`, shown: `~/Code/${p.name}` } : null;
    },
    create: async (name, path) => {
      if (name === 'Taken') throw new Error('A project is already called Taken.');
      created.push(`${name} at ${path}`);
      const at = projects.findIndex((p) => p.name === name);
      projects.splice(at, 1);
    },
    settings: { getSetting: async (k) => settings.get(k) ?? null, putSetting: async (k, v) => void settings.set(k, v) },
  };
  return { adopt: new AdoptHere(deps), settings, created, finds: () => finds, projects };
}

test('a project whose folder is already here is added, and one that is not is left', async () => {
  const w = world([away('core', ['git.example.com/team/core']), away('docs', ['git.example.com/team/docs'])], ['core']);
  expect(await w.adopt.check()).toEqual(['core']);
  expect(w.created).toEqual(['core at /home/me/Code/core']);
  expect(JSON.parse(w.settings.get(ADOPTED_KEY)!)).toEqual(['git.example.com/team/core']);
});

test('it looks once for the same projects, and again when another shows up', async () => {
  const w = world([away('docs', ['git.example.com/team/docs'])], []);
  await w.adopt.check();
  await w.adopt.check();
  expect(w.finds()).toBe(1);
  w.projects.push(away('core', ['git.example.com/team/core']));
  await w.adopt.check();
  expect(w.finds()).toBe(3);
});

test('a repository added once is not added again after the person removes it', async () => {
  const w = world([away('core', ['git.example.com/team/core'])], ['core']);
  await w.adopt.check();
  w.projects.push(away('core', ['git.example.com/team/core']), away('docs', ['git.example.com/team/docs']));
  expect(await w.adopt.check()).toEqual([]);
  expect(w.created).toHaveLength(1);
});

test('a plain folder is never looked for, and a refused add is left for the page', async () => {
  const w = world([away('notes', []), away('Taken', ['git.example.com/team/taken'])], ['notes', 'Taken']);
  expect(await w.adopt.check()).toEqual([]);
  expect(w.finds()).toBe(1);
  expect(w.settings.has(ADOPTED_KEY)).toBe(false);
});
