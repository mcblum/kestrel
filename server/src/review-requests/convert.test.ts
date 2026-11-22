import { describe, expect, it } from 'vitest';
import type { Project } from '../model.ts';
import { convertAsk, hostKindOf, noProjectFor, parseRequestRef, requestHome } from './convert.ts';

describe('what the user named', () => {
  it('a GitHub pull request link, whatever page of it', () => {
    expect(parseRequestRef('https://github.com/acme/app/pull/7')).toEqual({ host: 'github', hostName: 'github.com', repository: 'acme/app', number: 7, url: 'https://github.com/acme/app/pull/7' });
    expect(parseRequestRef(' https://github.com/acme/app/pull/7/files#diff-1 ')?.url).toBe('https://github.com/acme/app/pull/7');
    expect(parseRequestRef('https://git.example.com/acme/app/pull/12')).toMatchObject({ host: 'github', hostName: 'git.example.com', number: 12 });
  });

  it('a GitLab merge request link, with its groups', () => {
    expect(parseRequestRef('https://gitlab.example.com/group/sub/app/-/merge_requests/9/diffs')).toEqual({ host: 'gitlab', hostName: 'gitlab.example.com', repository: 'group/sub/app', number: 9, url: 'https://gitlab.example.com/group/sub/app/-/merge_requests/9' });
  });

  it('a bare number, for the session’s own project', () => {
    for (const text of ['7', '#7', '!7']) expect(parseRequestRef(text)).toEqual({ number: 7 });
  });

  it('nothing else', () => {
    for (const text of ['', 'the latest one', 'https://github.com/acme/app', 'https://github.com/acme/app/issues/7', 'ftp://github.com/acme/app/pull/7', '7 and 8']) expect(parseRequestRef(text), text).toBeNull();
  });
});

describe('the project a request belongs to', () => {
  const projects: Project[] = [
    { id: 'p1', name: 'App', folders: [{ id: 'f0', path: '/notes', isGit: false }, { id: 'f1', path: '/app', isGit: true }] },
    { id: 'p2', name: 'Docs', folders: [{ id: 'f2', path: '/docs', isGit: true }] },
  ];
  const origins: Record<string, string> = { '/app': 'git@github.com:Acme/App.git', '/docs': 'https://gitlab.example.com/group/docs.git' };
  const originOf = async (path: string) => origins[path] ?? null;

  it('a link: the registered folder whose origin is that repository, in whichever project', async () => {
    const home = await requestHome(parseRequestRef('https://github.com/acme/app/pull/7')!, projects, 'p2', originOf);
    expect(home).toMatchObject({ project: { id: 'p1' }, folder: { id: 'f1' }, host: 'github', repository: 'Acme/App' });
    expect(await requestHome(parseRequestRef('https://gitlab.example.com/group/docs/-/merge_requests/3')!, projects, null, originOf)).toMatchObject({ project: { id: 'p2' }, host: 'gitlab' });
  });

  it('a link to a repository that is no registered project: none', async () => {
    expect(await requestHome(parseRequestRef('https://github.com/other/thing/pull/1')!, projects, 'p1', originOf)).toBeNull();
  });

  it('a bare number: the session’s own project, and none for a session with no project', async () => {
    expect(await requestHome({ number: 7 }, projects, 'p2', originOf)).toMatchObject({ project: { id: 'p2' }, host: 'gitlab', hostName: 'gitlab.example.com', repository: 'group/docs' });
    expect(await requestHome({ number: 7 }, projects, null, originOf)).toBeNull();
  });

  it('tells GitLab from GitHub by the host’s name', () => {
    expect(hostKindOf('gitlab.com')).toBe('gitlab');
    expect(hostKindOf('gitlab.example.com')).toBe('gitlab');
    expect(hostKindOf('github.com')).toBe('github');
  });
});

describe('the words', () => {
  it('with no project: add it, or have the review here as text', () => {
    const text = noProjectFor('other/thing #1');
    expect(text).toContain('is not in a project registered in Kestrel');
    expect(text).toContain('add that repository as a project in Kestrel and ask again, or have the review here as ordinary text');
  });

  it('the card says what converting does, and what declining does', () => {
    const ask = convertAsk('pull request #7 in acme/app', 'App');
    expect(ask.title).toBe('Make this a review session?');
    expect(ask.detail).toContain('This session would be removed and that one would take its place.');
    expect(ask.detail).toContain('Decline to have the review here as ordinary text.');
  });
});
