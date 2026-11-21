// SAMPLE review requests for the fake store (KESTREL_FAKE=1): two in registered projects and one
// in a repository that is no project, so the CODE REVIEWS section and its page can be seen without
// a host. Nothing here asks gh or glab.
import { reviewRequestKey, type FoundReviewRequest, type ReviewRequest } from '../shared/review-requests.ts';

const HOUR_MS = 3_600_000;

const SAMPLES: readonly Omit<FoundReviewRequest, 'updatedAt'>[] = [
  { host: 'github', hostName: 'github.com', repository: 'sample/storefront', number: 412, title: 'Retry failed webhook deliveries with backoff', author: 'priya', requestedBy: 'devon', url: 'https://github.com/sample/storefront/pull/412', body: 'Deliveries that fail are retried up to five times, with the wait doubling each time.\n\nCloses #398.' },
  { host: 'github', hostName: 'github.com', repository: 'sample/design-system', number: 88, title: 'Table: keep the header in view while scrolling', author: 'jonas', url: 'https://github.com/sample/design-system/pull/88' },
  { host: 'github', hostName: 'github.com', repository: 'sample/billing-exports', number: 19, title: 'Write the nightly export as Parquet', author: 'amara', url: 'https://github.com/sample/billing-exports/pull/19', body: 'CSV stays behind a flag for one release.' },
];

/** The samples, the first two filed under the first two projects given. Pure. */
export function sampleReviewRequests(projectIds: readonly string[], now: number): ReviewRequest[] {
  return SAMPLES.map((sample, index) => {
    const found: FoundReviewRequest = { ...sample, updatedAt: now - (index + 1) * HOUR_MS };
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
    const found: FoundReviewRequest = { ...sample, updatedAt: now - (index + 1) * HOUR_MS };
    return { ...found, key: reviewRequestKey(found), projectId: sample.projectId };
  });
}
