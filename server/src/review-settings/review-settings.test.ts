// Settings → Git → Review requests: the rules (shared/review-settings.ts), where they are kept,
// the route, and the part that starts reviews on its own (review-requests/auto.ts).
import { describe, expect, it } from 'vitest';
import { reviewStarter } from '../review-requests/auto.ts';
import { ReviewRequestStore } from '../review-requests/store.ts';
import type { ReviewRequest } from '../shared/review-requests.ts';
import { DEFAULT_REVIEW_SETTINGS, MAX_REVIEWS_AT_ONCE, reviewsToStart, sanitizeReviewSettings, startsOnItsOwn, withProject, type ReviewAutomation, type ReviewSettings } from '../shared/review-settings.ts';
import { ready } from '../shared/sourced.ts';
import { reviewSettingsRoute } from './api.ts';
import { ReviewPrefs } from './prefs.ts';

const request = (number: number, projectId: string | null = 'p1', updatedAt = number): ReviewRequest => ({
  key: `github.com/acme/app/${number}`,
  host: 'github',
  hostName: 'github.com',
  repository: 'acme/app',
  number,
  title: `Request ${number}`,
  author: 'sam',
  url: `https://github.com/acme/app/pull/${number}`,
  updatedAt,
  projectId,
});
const START: ReviewAutomation = { mode: 'start', projects: 'all' };
const NONE = new Set<string>();

describe('the setting as stored', () => {
  it('lists requests and takes in every project until the user says otherwise', () => {
    expect(sanitizeReviewSettings(null)).toMatchObject({ mode: 'list', projects: 'all' });
    expect(sanitizeReviewSettings({ mode: 'publish', projects: 7 })).toEqual(DEFAULT_REVIEW_SETTINGS);
  });

  it('keeps a valid choice, each project once', () => {
    expect(sanitizeReviewSettings({ mode: 'start', projects: ['a', 'b', 'a'] })).toEqual({ ...DEFAULT_REVIEW_SETTINGS, mode: 'start', projects: ['a', 'b'] });
  });
});

describe('where a review starts on its own', () => {
  it('starts nothing while requests are only listed, or off', () => {
    expect(startsOnItsOwn({ mode: 'list', projects: 'all' }, 'p1')).toBe(false);
    expect(startsOnItsOwn({ mode: 'off', projects: 'all' }, 'p1')).toBe(false);
  });

  it('starts only in a chosen project, and never for a request in no project', () => {
    expect(startsOnItsOwn(START, 'p1')).toBe(true);
    expect(startsOnItsOwn({ mode: 'start', projects: ['p2'] }, 'p1')).toBe(false);
    expect(startsOnItsOwn(START, null)).toBe(false);
  });
});

describe('a project’s switch edits the one list', () => {
  it('turning one project off under All projects leaves every other project chosen', () => {
    expect(withProject('all', 'b', false, ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });

  it('turning a project on or off in a list adds or removes just it', () => {
    expect(withProject(['a'], 'b', true, ['a', 'b'])).toEqual(['a', 'b']);
    expect(withProject(['a', 'b'], 'a', false, ['a', 'b'])).toEqual(['b']);
  });

  it('never widens a list to All projects, which also takes in projects registered later', () => {
    expect(withProject(['a'], 'b', true, ['a', 'b'])).not.toBe('all');
    expect(withProject('all', 'a', true, ['a'])).toBe('all');
  });
});

describe('which reviews are due', () => {
  it('names the oldest waiting requests, up to the number allowed at once', () => {
    const due = reviewsToStart(START, [request(3), request(1), request(2)], [], NONE);
    expect(due.map((r) => r.number)).toEqual([1, 2]);
    expect(due).toHaveLength(MAX_REVIEWS_AT_ONCE);
  });

  it('leaves room only for what is not already at work', () => {
    const sessions = [{ state: 'running', review: { key: request(1).key } }];
    expect(reviewsToStart(START, [request(1), request(2), request(3)], sessions, NONE).map((r) => r.number)).toEqual([2]);
  });

  it('does not count a finished review, and does not start a second one of the same request', () => {
    const sessions = [{ state: 'done', review: { key: request(1).key } }];
    expect(reviewsToStart(START, [request(1), request(2), request(3)], sessions, NONE).map((r) => r.number)).toEqual([2, 3]);
  });

  it('skips a request that was tried and refused, one in no project, and one in a project not chosen', () => {
    const settings: ReviewAutomation = { mode: 'start', projects: ['p1'] };
    const requests = [request(1), request(2, null), request(3, 'p2'), request(4)];
    expect(reviewsToStart(settings, requests, [], new Set([request(1).key])).map((r) => r.number)).toEqual([4]);
  });

  it('starts reviews in the mode that also replies', () => {
    expect(reviewsToStart({ mode: 'reply', projects: 'all' }, [request(1)], [], NONE).map((r) => r.number)).toEqual([1]);
  });

  it('starts nothing unless the user chose it', () => {
    expect(reviewsToStart(DEFAULT_REVIEW_SETTINGS, [request(1)], [], NONE)).toEqual([]);
  });
});

describe('ReviewPrefs', () => {
  it('changes what is given, keeps the rest, and tells its listeners', async () => {
    const prefs = new ReviewPrefs();
    const heard: ReviewSettings[] = [];
    prefs.onChange((s) => heard.push(s));
    await prefs.set({ mode: 'start' });
    await prefs.set({ projects: ['p1'] });
    expect(await prefs.current()).toEqual({ ...DEFAULT_REVIEW_SETTINGS, mode: 'start', projects: ['p1'] });
    expect(heard).toHaveLength(2);
  });
});

describe('the route', () => {
  const workspace = { state: async () => ({ projects: [{ id: 'p1' }, { id: 'p2' }] }) };
  const put = (prefs: ReviewPrefs, body: Record<string, unknown>) => reviewSettingsRoute(['api', 'review-settings'], 'PUT', async () => body, workspace, prefs);

  it('gives the default before anything is chosen', async () => {
    const answer = await reviewSettingsRoute(['api', 'review-settings'], 'GET', async () => ({}), workspace, new ReviewPrefs());
    expect(answer).toEqual({ status: 200, body: DEFAULT_REVIEW_SETTINGS });
  });

  it('stores a choice of projects, dropping any that is not registered', async () => {
    const answer = await put(new ReviewPrefs(), { mode: 'start', projects: ['p2', 'gone'] });
    expect(answer).toEqual({ status: 200, body: { ...DEFAULT_REVIEW_SETTINGS, mode: 'start', projects: ['p2'] } });
  });

  it('stores posting on its own only when the warning was confirmed', async () => {
    const prefs = new ReviewPrefs();
    expect(await put(prefs, { mode: 'reply' })).toMatchObject({ status: 400, body: { error: expect.stringContaining('has to be confirmed') } });
    expect(await prefs.current()).toEqual(DEFAULT_REVIEW_SETTINGS);
    expect(await put(prefs, { mode: 'reply', confirmed: true })).toMatchObject({ status: 200, body: { mode: 'reply' } });
  });

  it('refuses a mode it does not know, a bad list, and an empty change, each with the reason', async () => {
    const prefs = new ReviewPrefs();
    expect(await put(prefs, { mode: 'publish' })).toMatchObject({ status: 400, body: { error: expect.stringContaining('mode must be one of') } });
    expect(await put(prefs, { projects: 'some' })).toMatchObject({ status: 400 });
    expect(await put(prefs, {})).toMatchObject({ status: 400 });
    expect(await prefs.current()).toEqual(DEFAULT_REVIEW_SETTINGS);
  });
});

describe('starting reviews on their own', () => {
  const setUp = (settings: ReviewAutomation, start: (r: ReviewRequest) => Promise<unknown>) => {
    const store = new ReviewRequestStore();
    const sessions: { state: string; review?: { key: string } }[] = [];
    const starter = reviewStarter({ settings: async () => settings, sessions: async () => sessions, start }, store);
    return { store, sessions, starter };
  };

  it('starts the reviews that are due and no more', async () => {
    const started: number[] = [];
    const { store, sessions, starter } = setUp(START, async (r) => {
      started.push(r.number);
      sessions.push({ state: 'running', review: { key: r.key } });
    });
    store.set('github.com', ready([request(1), request(2), request(3)]));
    await starter.run();
    await starter.run();
    expect(started).toEqual([1, 2]);
  });

  it('starts the one that waited once a review finishes', async () => {
    const started: number[] = [];
    const { store, sessions, starter } = setUp(START, async (r) => {
      started.push(r.number);
      sessions.push({ state: 'running', review: { key: r.key } });
    });
    store.set('github.com', ready([request(1), request(2), request(3)]));
    await starter.run();
    sessions[0]!.state = 'done';
    await starter.run();
    expect(started).toEqual([1, 2, 3]);
  });

  it('puts the reason on a request it could not start, and does not try it again', async () => {
    let tries = 0;
    const { store, starter } = setUp(START, async () => {
      tries += 1;
      throw new Error('No agent is connected.');
    });
    store.set('github.com', ready([request(1)]));
    await starter.run();
    await starter.run();
    expect(tries).toBe(1);
    expect(store.view().requests[0]?.notStarted).toBe('No agent is connected.');
  });

  it('tries again once the reasons are cleared, as a change of the setting does', async () => {
    let tries = 0;
    const { store, starter } = setUp(START, async () => {
      tries += 1;
      throw new Error('nope');
    });
    store.set('github.com', ready([request(1)]));
    await starter.run();
    store.clearNotes();
    expect(store.view().requests[0]?.notStarted).toBeUndefined();
    await starter.run();
    expect(tries).toBe(2);
  });

  it('starts nothing while requests are only listed', async () => {
    let tries = 0;
    const { store, starter } = setUp(DEFAULT_REVIEW_SETTINGS, async () => void (tries += 1));
    store.set('github.com', ready([request(1)]));
    await starter.run();
    expect(tries).toBe(0);
  });
});

describe('a reason leaves with its request', () => {
  it('is dropped when the request is no longer listed', () => {
    const store = new ReviewRequestStore();
    store.set('github.com', ready([request(1)]));
    store.note(request(1).key, 'why');
    store.set('github.com', ready([]));
    expect(store.noted().size).toBe(0);
  });
});
