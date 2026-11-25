// SAMPLE review requests for the fake store (KESTREL_FAKE=1): two in registered projects and the
// rest in repositories that are no project, so the CODE REVIEWS section and its page can be seen without
// a host. Some carry what other reviewers said: one approval, approved, and changes asked for. Nothing here asks gh or glab.
import { reviewRequestKey, type FoundReviewRequest, type ReviewRequest } from '../shared/review-requests.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const OPENED_AGO = [HOUR_MS / 3, 5 * HOUR_MS, 4 * DAY_MS, DAY_MS, 9 * DAY_MS, 2 * DAY_MS, 40 * DAY_MS, 3 * HOUR_MS, 16 * DAY_MS];

const SAMPLES: readonly Omit<FoundReviewRequest, 'updatedAt'>[] = [
  { host: 'github', hostName: 'github.com', repository: 'sample/storefront', number: 412, title: 'Retry failed webhook deliveries with backoff', author: 'priya', requestedBy: 'devon', url: 'https://github.com/sample/storefront/pull/412', body: 'Deliveries that fail are retried up to five times, with the wait doubling each time.\n\nCloses #398.' },
  { host: 'github', hostName: 'github.com', repository: 'sample/design-system', number: 88, title: 'Table: keep the header in view while scrolling', author: 'jonas', url: 'https://github.com/sample/design-system/pull/88', others: { approvedBy: ['lucia'], changesRequestedBy: [], satisfied: false } },
  { host: 'github', hostName: 'github.com', repository: 'sample/billing-exports', number: 19, title: 'Write the nightly export as Parquet', author: 'amara', url: 'https://github.com/sample/billing-exports/pull/19', body: 'CSV stays behind a flag for one release.', others: { approvedBy: ['kim', 'noor'], changesRequestedBy: [], satisfied: true } },
  // More than the sidebar lists by default, so its "Show more" and the Code reviews page can be seen.
  { host: 'github', hostName: 'github.com', repository: 'sample/billing-exports', number: 23, title: 'Stream large exports instead of buffering them', author: 'amara', url: 'https://github.com/sample/billing-exports/pull/23' },
  { host: 'github', hostName: 'github.com', repository: 'sample/docs-site', number: 140, title: 'Search: rank exact title matches first', author: 'lucia', url: 'https://github.com/sample/docs-site/pull/140', others: { approvedBy: ['kim'], changesRequestedBy: ['tomas'], satisfied: false } },
  { host: 'github', hostName: 'github.com', repository: 'sample/docs-site', number: 143, title: 'Fix broken anchors in the API reference', author: 'tomas', url: 'https://github.com/sample/docs-site/pull/143' },
  { host: 'github', hostName: 'github.com', repository: 'sample/mobile-shell', number: 57, title: 'Deep links open the right tab after a cold start', author: 'noor', url: 'https://github.com/sample/mobile-shell/pull/57' },
  { host: 'github', hostName: 'github.com', repository: 'sample/mobile-shell', number: 61, title: 'Drop the legacy push token migration', author: 'devon', url: 'https://github.com/sample/mobile-shell/pull/61' },
  { host: 'github', hostName: 'github.com', repository: 'sample/infra-modules', number: 9, title: 'Pin the base image by digest', author: 'kim', url: 'https://github.com/sample/infra-modules/pull/9' },
];

/** How many samples there are when no number is asked for. */
export const SAMPLE_REVIEW_COUNT = SAMPLES.length;

/** What KESTREL_SAMPLE_REVIEWS asks for: a whole number from 0 to 1000, else the usual count. Pure. */
export function sampleReviewCount(raw: string | undefined): number {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 0 && n <= 1000 ? n : SAMPLE_REVIEW_COUNT;
}

/** What KESTREL_SAMPLE_UNREAD asks for: how many of the samples are new, a whole number from 0; null when not asked. Pure. */
export function sampleUnreadCount(raw: string | undefined): number | null {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * `count` samples, the first two filed under the first two projects given. Past the ones written
 * out they repeat with new numbers, so a long list (a few hundred, as a busy account has) can be
 * seen. Pure.
 */
export function sampleReviewRequests(projectIds: readonly string[], now: number, count: number = SAMPLE_REVIEW_COUNT): ReviewRequest[] {
  const samples = Array.from({ length: count }, (_, index) => {
    const base = SAMPLES[index % SAMPLES.length]!;
    const round = Math.floor(index / SAMPLES.length);
    if (round === 0) return base;
    const number = base.number + round * 100;
    return { ...base, number, url: base.url.replace(/\d+$/, String(number)) };
  });
  return samples.map((sample, index) => {
    // Opened from twenty minutes to some weeks ago, so every wording of the age can be seen.
    const found: FoundReviewRequest = { ...sample, updatedAt: now - (index + 1) * HOUR_MS, openedAt: now - OPENED_AGO[index % OPENED_AGO.length]! };
    return { ...found, key: reviewRequestKey(found), projectId: index < 2 ? (projectIds[index] ?? null) : null };
  });
}

/** SAMPLE: the two requests of the story scene with reviews (`pnpm demo --story --reviews`), one in App and one in API. */
const STORY_SAMPLES: readonly (Omit<FoundReviewRequest, 'updatedAt'> & { projectId: string })[] = [
  { projectId: 'app', host: 'github', hostName: 'github.com', repository: 'sample/app', number: 412, title: 'Keep the cart total in view on small screens', author: 'priya', requestedBy: 'priya', url: 'https://github.com/sample/app/pull/412', body: 'The total sticks to the bottom of the screen below 480 px.' },
  { projectId: 'api', host: 'github', hostName: 'github.com', repository: 'sample/api', number: 88, title: 'Retry failed webhook deliveries with backoff', author: 'jonas', requestedBy: 'devon', url: 'https://github.com/sample/api/pull/88', body: 'Deliveries that fail are retried up to five times, with the wait doubling each time.' },
];

/** The story scene's requests: neither has a review started. Pure. */
export function storyReviewRequests(now: number): ReviewRequest[] {
  return STORY_SAMPLES.map((sample, index) => {
    const found: FoundReviewRequest = { ...sample, updatedAt: now - (index + 1) * HOUR_MS, openedAt: now - (index + 1) * 2 * DAY_MS };
    return { ...found, key: reviewRequestKey(found), projectId: sample.projectId };
  });
}
