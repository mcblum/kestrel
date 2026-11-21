// Dismissing a review request, where the requests are shown, and how many the sidebar lists: the
// store's dismissed keys, the settings that choose the place, the Code reviews page's path, and
// where a review session is drawn when the sidebar has no CODE REVIEWS section.
import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../model.ts';
import { sidebarMenu } from '../shared/menu.ts';
import { sidebarHomes } from '../shared/pinned-homes.ts';
import { asDismissedKeys, asReviewRequestsView, MAX_DISMISSED, needsALook, openedText, requestStatus, reviewRequestKey, withDismissed, withinLimit, type ReviewRequest } from '../shared/review-requests.ts';
import { DEFAULT_REVIEW_SETTINGS, hasReviewLink, hasReviewSection, sanitizeReviewSettings, SIDEBAR_LIMIT } from '../shared/review-settings.ts';
import { containerOf, parseViewPath, selectsRow, viewPath } from '../shared/routes.ts';
import { ready } from '../shared/sourced.ts';
import { agoText } from '../shared/when.ts';
import { sampleReviewCount, sampleReviewRequests, sampleUnreadCount, SAMPLE_REVIEW_COUNT } from './fake.ts';
import { mapGithubItem } from './github.ts';
import { mapGitlabItem } from './gitlab.ts';
import { reviewSettingsRoute } from '../review-settings/api.ts';
import { ReviewPrefs } from '../review-settings/prefs.ts';
import { reviewStarter } from './auto.ts';
import { ReviewRequestStore } from './store.ts';

const request = (number: number, updatedAt = number): ReviewRequest => {
  const base = { host: 'github' as const, hostName: 'github.com', repository: 'acme/app', number, title: `Change ${number}`, author: 'sam', url: `https://github.com/acme/app/pull/${number}`, updatedAt, projectId: null };
  return { ...base, key: reviewRequestKey(base) };
};
const keysOf = (requests: readonly ReviewRequest[]) => requests.map((r) => r.number);

describe('dismissing a request', () => {
  it('takes it out of the waiting list and holds it apart, until it is restored', () => {
    const store = new ReviewRequestStore();
    store.set('github.com', ready([request(1), request(2), request(3)]));
    store.dismiss([request(2).key], true);
    expect(keysOf(store.view().requests)).toEqual([3, 1]);
    expect(keysOf(store.view().dismissed)).toEqual([2]);
    store.dismiss([request(2).key], false);
    expect(keysOf(store.view().requests)).toEqual([3, 2, 1]);
    expect(store.view().dismissed).toEqual([]);
  });

  it('dismisses many at once, saves the keys, and tells listeners once', () => {
    const saved: string[][] = [];
    const store = new ReviewRequestStore({ saveDismissed: (keys) => saved.push([...keys]) });
    store.set('github.com', ready([request(1), request(2), request(3)]));
    let heard = 0;
    store.onChange(() => (heard += 1));
    store.dismiss([request(1).key, request(3).key], true);
    expect(keysOf(store.view().requests)).toEqual([2]);
    expect(saved).toEqual([[request(1).key, request(3).key]]);
    expect(heard).toBe(1);
    store.dismiss([request(1).key], true); // already dismissed: nothing to save or tell
    expect(saved).toHaveLength(1);
    expect(heard).toBe(1);
  });

  it('starts with the stored keys, and keeps one whose request is not listed for now', () => {
    const store = new ReviewRequestStore({ dismissed: [request(2).key] });
    store.set('github.com', ready([request(1)]));
    expect(keysOf(store.view().requests)).toEqual([1]);
    store.set('github.com', ready([request(1), request(2)])); // the host lists it again: still dismissed
    expect(keysOf(store.view().requests)).toEqual([1]);
    expect(keysOf(store.view().dismissed)).toEqual([2]);
  });

  it('keeps each key once, and forgets the oldest past the cap', () => {
    expect(withDismissed(['a'], ['b', 'a'], true)).toEqual(['a', 'b']);
    expect(withDismissed(['a', 'b', 'c'], ['b'], false)).toEqual(['a', 'c']);
    const many = Array.from({ length: MAX_DISMISSED }, (_, i) => `k${i}`);
    const next = withDismissed(many, ['new'], true);
    expect(next).toHaveLength(MAX_DISMISSED);
    expect(next[0]).toBe('k1');
    expect(next.at(-1)).toBe('new');
  });

  it('reads stored keys and a pushed view, and an older server as nothing dismissed', () => {
    expect(asDismissedKeys(['a', 7, 'a', ''])).toEqual(['a']);
    expect(asDismissedKeys('a')).toEqual([]);
    expect(asReviewRequestsView({ requests: [], problems: [] }).dismissed).toEqual([]);
    expect(keysOf(asReviewRequestsView({ requests: [], problems: [], dismissed: [request(4), { key: 'x' }] }).dismissed)).toEqual([4]);
  });

  it('is in a request row’s menu, with what else can be done to it', () => {
    const labels = (target: Parameters<typeof sidebarMenu>[0]) => sidebarMenu(target).map((i) => i.label);
    expect(labels({ kind: 'review', key: 'k', pinned: false })).toEqual(['Open', 'Pin', 'Dismiss']);
    expect(labels({ kind: 'review', key: 'k', pinned: true, unread: true, url: 'https://github.com/a/b/pull/1', service: 'GitHub' })).toEqual(['Open', 'Open on GitHub', 'Copy link', 'Mark as read', 'Unpin', 'Dismiss']);
    expect(labels({ kind: 'review', key: 'k', pinned: false, unread: false, sessionId: 's1' })).toEqual(['Open review', 'Mark as unread', 'Pin', 'Dismiss']);
    const items = sidebarMenu({ kind: 'review', key: 'k', pinned: false, unread: false });
    expect(items.find((i) => i.id === 'mark-review-read')!.action).toEqual({ type: 'mark-review-read', key: 'k', read: false });
    expect(items.at(-1)!.action).toEqual({ type: 'dismiss-review', key: 'k', dismissed: true });
  });

  it('a dismissed one can be restored from its menu, and is not pinned or marked', () => {
    const items = sidebarMenu({ kind: 'review', key: 'k', pinned: false, unread: false, dismissed: true, url: 'https://x/1', service: 'GitLab' });
    expect(items.map((i) => i.label)).toEqual(['Open', 'Open on GitLab', 'Copy link', 'Restore']);
    expect(items.at(-1)!.action).toEqual({ type: 'dismiss-review', key: 'k', dismissed: false });
  });
});

describe('how many the sidebar lists', () => {
  const rows = ['a', 'S', 'b', 'c', 'd'];

  it('shows the first few, and every row that is always kept', () => {
    expect(withinLimit(rows, 2, (row) => row === 'S')).toEqual({ shown: ['a', 'S', 'b'], hidden: 2 });
    expect(withinLimit(rows, 2, (row) => row === 'd')).toEqual({ shown: ['a', 'S', 'd'], hidden: 2 });
  });

  it('hides nothing when everything fits', () => {
    expect(withinLimit(rows, 5, () => false)).toEqual({ shown: rows, hidden: 0 });
  });
});

describe('where the requests are shown', () => {
  it('is their own page until the user says otherwise, and five in the sidebar when it has the section', () => {
    expect(DEFAULT_REVIEW_SETTINGS).toMatchObject({ show: 'page', sidebarLimit: 5 });
    expect(sanitizeReviewSettings({ show: 'drawer', sidebarLimit: 0 })).toEqual(DEFAULT_REVIEW_SETTINGS);
    expect(sanitizeReviewSettings({ show: 'both', sidebarLimit: 12 })).toMatchObject({ show: 'both', sidebarLimit: 12 });
  });

  it('gives the sidebar its section, its row for the page, or both, and neither while requests are off', () => {
    expect([hasReviewSection({ mode: 'list', show: 'both' }), hasReviewLink({ mode: 'list', show: 'both' })]).toEqual([true, true]);
    expect([hasReviewSection({ mode: 'list', show: 'sidebar' }), hasReviewLink({ mode: 'list', show: 'sidebar' })]).toEqual([true, false]);
    expect([hasReviewSection({ mode: 'start', show: 'page' }), hasReviewLink({ mode: 'start', show: 'page' })]).toEqual([false, true]);
    expect([hasReviewSection({ mode: 'off', show: 'both' }), hasReviewLink({ mode: 'off', show: 'both' })]).toEqual([false, false]);
  });

  it('is stored by the route, which refuses a place or a number it does not know', async () => {
    const workspace = { state: async () => ({ projects: [] }) };
    const prefs = new ReviewPrefs();
    const put = (body: Record<string, unknown>) => reviewSettingsRoute(['api', 'review-settings'], 'PUT', async () => body, workspace, prefs);
    expect(await put({ show: 'sidebar', sidebarLimit: 8 })).toMatchObject({ status: 200, body: { mode: 'list', show: 'sidebar', sidebarLimit: 8 } });
    expect(await put({ show: 'drawer' })).toMatchObject({ status: 400, body: { error: expect.stringContaining('show must be one of') } });
    expect(await put({ sidebarLimit: SIDEBAR_LIMIT.max + 1 })).toMatchObject({ status: 400, body: { error: expect.stringContaining('whole number') } });
    expect(await prefs.current()).toMatchObject({ show: 'sidebar', sidebarLimit: 8 });
  });
});

describe('the Code reviews page', () => {
  it('has a path, with the dismissed ones under their own', () => {
    expect(viewPath({ kind: 'code-reviews' })).toBe('#/code-reviews');
    expect(parseViewPath('#/code-reviews')).toEqual({ kind: 'code-reviews' });
    expect(parseViewPath(viewPath({ kind: 'code-reviews', filter: 'dismissed' }))).toEqual({ kind: 'code-reviews', filter: 'dismissed' });
    expect(parseViewPath('#/code-reviews/other')).toEqual({ kind: 'code-reviews' });
  });

  it('is one destination under either filter', () => {
    expect(containerOf({ kind: 'code-reviews', filter: 'dismissed' })).toEqual({ kind: 'code-reviews' });
    expect(selectsRow({ kind: 'code-reviews', filter: 'dismissed' }, { kind: 'code-reviews' })).toBe(true);
  });
});

describe('a review session when the sidebar has no CODE REVIEWS section', () => {
  const node = (sessionId: string): TreeNode => ({ sessionId, via: null, movedFrom: null, children: [] });
  const input = { pins: [], trees: { ungrouped: [node('a'), node('b')] }, sessions: [{ id: 'a', filing: { projectId: null, status: 'landed' as const } }, { id: 'b', filing: { projectId: null, status: 'landed' as const } }], reviewing: new Set(['a']) };

  it('leaves its home for the section when there is one', () => {
    const homes = sidebarHomes(input);
    expect(homes.reviews.map((r) => r.id)).toEqual(['a']);
    expect(homes.trees.ungrouped!.map((n) => n.sessionId)).toEqual(['b']);
  });

  it('stays in its home when there is none', () => {
    const homes = sidebarHomes({ ...input, reviewsSection: false });
    expect(homes.reviews).toEqual([]);
    expect(homes.trees.ungrouped!.map((n) => n.sessionId)).toEqual(['a', 'b']);
  });
});

describe('how long ago a request was opened', () => {
  const MIN = 60_000;
  const DAY = 86_400_000;
  const now = 1_800_000_000_000;

  it('is said in its largest whole unit', () => {
    expect(agoText(now - 20_000, now)).toBe('just now');
    expect(agoText(now - MIN, now)).toBe('1 minute ago');
    expect(agoText(now - 20 * MIN, now)).toBe('20 minutes ago');
    expect(agoText(now - 3 * 60 * MIN, now)).toBe('3 hours ago');
    expect(agoText(now - 4 * DAY, now)).toBe('4 days ago');
    expect(agoText(now - 65 * DAY, now)).toBe('2 months ago');
    expect(agoText(now - 400 * DAY, now)).toBe('1 year ago');
    expect(agoText(now + MIN, now)).toBe('just now'); // a host's clock ahead of this one
  });

  it('is read from each host, and left out when the host did not say', () => {
    const github = mapGithubItem({ number: 7, repository_url: 'https://api.github.com/repos/acme/app', created_at: '2026-11-17T10:00:00Z', updated_at: '2026-11-20T10:00:00Z' });
    expect(github?.openedAt).toBe(Date.parse('2026-11-17T10:00:00Z'));
    const gitlab = mapGitlabItem({ iid: 12, references: { full: 'team/api!12' }, created_at: '2026-11-19T08:00:00Z' }, 'git.example.io');
    expect(gitlab?.openedAt).toBe(Date.parse('2026-11-19T08:00:00Z'));
    expect(mapGithubItem({ number: 7, repository_url: 'https://api.github.com/repos/acme/app' })).not.toHaveProperty('openedAt');
    expect(openedText({ openedAt: now - 4 * DAY }, now)).toBe('4 days ago');
    expect(openedText({}, now)).toBe('');
  });
});

describe('sample review requests', () => {
  it('are as many as asked for, each with its own key', () => {
    const many = sampleReviewRequests(['p1', 'p2'], 1_800_000_000_000, 300);
    expect(many).toHaveLength(300);
    expect(new Set(many.map((r) => r.key)).size).toBe(300);
    expect(many.slice(0, 3).map((r) => r.projectId)).toEqual(['p1', 'p2', null]);
    expect(sampleReviewRequests([], 0)).toHaveLength(SAMPLE_REVIEW_COUNT);
  });

  it('reads the count from the environment, and anything else as the usual count', () => {
    expect(sampleReviewCount('300')).toBe(300);
    expect(sampleReviewCount('0')).toBe(0);
    expect([sampleUnreadCount('10'), sampleUnreadCount('0'), sampleUnreadCount(undefined), sampleUnreadCount('some')]).toEqual([10, 0, null, null]);
    expect([sampleReviewCount(undefined), sampleReviewCount('many'), sampleReviewCount('5000')]).toEqual([SAMPLE_REVIEW_COUNT, SAMPLE_REVIEW_COUNT, SAMPLE_REVIEW_COUNT]);
  });
});

describe('a new request is unread', () => {
  const listed = () => {
    const saved: string[][] = [];
    const store = new ReviewRequestStore({ saveSeen: (keys) => saved.push([...keys]) });
    store.set('github.com', ready([request(1), request(2), request(3)]));
    return { store, saved };
  };

  it('until it is marked read, and again when it is marked unread', () => {
    const { store, saved } = listed();
    expect(store.view().unread).toEqual([request(1).key, request(2).key, request(3).key]);
    store.markSeen([request(1).key, request(3).key], true);
    expect(store.view().unread).toEqual([request(2).key]);
    expect(saved).toEqual([[request(1).key, request(3).key]]);
    store.markSeen([request(3).key], false);
    expect(store.view().unread).toEqual([request(2).key, request(3).key]);
  });

  it('stays read across a restart, and a request that arrives later is new', () => {
    const store = new ReviewRequestStore({ seen: [request(1).key] });
    store.set('github.com', ready([request(1)]));
    expect(store.view().unread).toEqual([]);
    store.set('github.com', ready([request(1), request(2)]));
    expect(store.view().unread).toEqual([request(2).key]);
  });

  it('is not counted once dismissed, and does not come back as new when restored', () => {
    const { store } = listed();
    store.dismiss([request(2).key], true);
    expect(store.view().unread).toEqual([request(1).key, request(3).key]);
    store.dismiss([request(2).key], false);
    expect(store.view().unread).toEqual([request(1).key, request(3).key]);
  });

  it('is read once a review of it starts on its own: its session carries the news from then', async () => {
    const { store } = listed();
    const settings = { mode: 'start' as const, projects: 'all' as const };
    store.set('github.com', ready([{ ...request(1), projectId: 'p1' }, request(2)]));
    await reviewStarter({ settings: async () => settings, sessions: async () => [], start: async () => undefined }, store).run();
    expect(store.view().unread).toEqual([request(2).key]);
  });

  it('has a status that says so, unless Kestrel could not start it, which matters more', () => {
    expect(requestStatus({}, true)).toMatchObject({ tone: 'unread' });
    expect(requestStatus({ notStarted: 'No agent.' }, true)).toMatchObject({ tone: 'needs-you' });
    expect(asReviewRequestsView({ requests: [], problems: [], unread: ['a', 3] }).unread).toEqual(['a']);
    expect(asReviewRequestsView({ requests: [], problems: [] }).unread).toEqual([]);
  });
});

describe('which requests need a look', () => {
  const view = { requests: [request(1), request(2), request(3)], unread: [request(1).key] };
  const reviewing = (id: string, n: number, state: 'done' | 'running' | 'attention', updatedAt: number) => ({ id, state, updatedAt, review: { key: request(n).key } });

  it('the ones not opened yet, and a review that finished a turn since the user last looked', () => {
    const sessions = [reviewing('s2', 2, 'done', 200), reviewing('s3', 3, 'done', 200)];
    expect([...needsALook(view, sessions, { s2: 100, s3: 200 })]).toEqual([request(1).key, request(2).key]);
  });

  it('a review that waits on an answer, but not one still at work', () => {
    const sessions = [reviewing('s2', 2, 'attention', 100), reviewing('s3', 3, 'running', 300)];
    expect([...needsALook(view, sessions, { s2: 100, s3: 100 })]).toEqual([request(1).key, request(2).key]);
  });

  it('each request once, and never one that no longer waits', () => {
    const sessions = [reviewing('s1', 1, 'done', 200), reviewing('gone', 9, 'done', 200)];
    expect([...needsALook(view, sessions, { s1: 100, gone: 100 })]).toEqual([request(1).key]);
    expect(needsALook({ requests: [], unread: [request(1).key] }, [], {}).size).toBe(0);
  });
});
