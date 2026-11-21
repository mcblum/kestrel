// Settings → Git → Review requests: what Kestrel does with the requests the user was asked to
// review (shared/review-requests.ts), and in which projects it may start a review on its own. One
// copy, kept with the app's settings; a project's Settings tab shows the same list from its side.
// Pure and browser-safe.
import type { ReviewRequest } from './review-requests.ts';

/**
 * `off`: no host is asked. `list`: requests are listed. `start`: a review also starts on its own.
 * `reply`: and its review is posted when it is finished, approval included.
 */
export type ReviewMode = 'off' | 'list' | 'start' | 'reply';

export const REVIEW_MODES: readonly ReviewMode[] = ['off', 'list', 'start', 'reply'];

export const REVIEW_MODE_LABEL: Record<ReviewMode, string> = {
  off: 'Off',
  list: 'List them',
  start: 'Start reviews on their own',
  reply: 'Review and reply on their own',
};

/** Every project, those registered later included; or only the projects with these ids. */
export type ReviewProjects = 'all' | readonly string[];

/**
 * Where the requests are shown. `sidebar`: the CODE REVIEWS section. `page`: the Code reviews page,
 * reached from a row of the sidebar's top menu, and no section (the default: Matt, 2026-11-21).
 * `both`: the section and that row.
 * The page exists whichever is chosen: the section's "Show more" opens it.
 */
export type ReviewPlace = 'both' | 'sidebar' | 'page';

export const REVIEW_PLACES: readonly ReviewPlace[] = ['page', 'sidebar', 'both'];

export const REVIEW_PLACE_LABEL: Record<ReviewPlace, string> = {
  both: 'In the sidebar and on their own page',
  sidebar: 'In the sidebar',
  page: 'On their own page',
};

/** How many requests nobody has started on the sidebar's section lists before "Show more". */
export const SIDEBAR_LIMIT = { min: 1, max: 50, initial: 5 } as const;

export interface ReviewSettings {
  mode: ReviewMode;
  /** Where a review may start on its own. Requests are listed for every project whatever this says. */
  projects: ReviewProjects;
  show: ReviewPlace;
  sidebarLimit: number;
}

/** The part that decides what Kestrel does on its own: all the starting and replying rules read. */
export type ReviewAutomation = Pick<ReviewSettings, 'mode' | 'projects'>;

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = { mode: 'list', projects: 'all', show: 'page', sidebarLimit: SIDEBAR_LIMIT.initial };

export const isReviewPlace = (v: unknown): v is ReviewPlace => REVIEW_PLACES.includes(v as ReviewPlace);

/** A limit as given, or null when it is not a whole number in range. */
export const asSidebarLimit = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= SIDEBAR_LIMIT.min && v <= SIDEBAR_LIMIT.max ? v : null);

/** Whether the sidebar has the CODE REVIEWS section. */
export const hasReviewSection = (settings: Pick<ReviewSettings, 'mode' | 'show'>): boolean => settings.mode !== 'off' && settings.show !== 'page';

/** Whether the sidebar's top menu has the Code reviews row. */
export const hasReviewLink = (settings: Pick<ReviewSettings, 'mode' | 'show'>): boolean => settings.mode !== 'off' && settings.show !== 'sidebar';

/** How many reviews Kestrel started on its own may be at work at once; the rest wait. */
export const MAX_REVIEWS_AT_ONCE = 2;

const isMode = (v: unknown): v is ReviewMode => REVIEW_MODES.includes(v as ReviewMode);

/** A project choice as given, or null when it is not one. Ids are kept once each. */
export function asReviewProjects(raw: unknown): ReviewProjects | null {
  if (raw === 'all') return 'all';
  if (!Array.isArray(raw) || !raw.every((id) => typeof id === 'string')) return null;
  return [...new Set(raw as string[])];
}

/** Stored settings, checked: whatever is missing or wrong reads as the default. */
export function sanitizeReviewSettings(raw: unknown): ReviewSettings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_REVIEW_SETTINGS;
  const r = raw as Record<string, unknown>;
  return {
    mode: isMode(r.mode) ? r.mode : DEFAULT_REVIEW_SETTINGS.mode,
    projects: asReviewProjects(r.projects) ?? DEFAULT_REVIEW_SETTINGS.projects,
    show: isReviewPlace(r.show) ? r.show : DEFAULT_REVIEW_SETTINGS.show,
    sidebarLimit: asSidebarLimit(r.sidebarLimit) ?? DEFAULT_REVIEW_SETTINGS.sidebarLimit,
  };
}

/** Whether a project is one of the chosen ones, whatever the mode. */
export const isChosenProject = (settings: ReviewAutomation, projectId: string): boolean => settings.projects === 'all' || settings.projects.includes(projectId);

/** Whether a review of a request in this project starts on its own. */
/** Whether the mode is one of the two in which Kestrel acts without being asked, in the chosen projects. */
export const isAutomatic = (mode: ReviewMode): boolean => mode === 'start' || mode === 'reply';

export const startsOnItsOwn = (settings: ReviewAutomation, projectId: string | null): boolean => isAutomatic(settings.mode) && projectId !== null && isChosenProject(settings, projectId);

/** Whether a finished review in this project is posted without the user's click. */
export const repliesOnItsOwn = (settings: ReviewAutomation, projectId: string | null): boolean => settings.mode === 'reply' && projectId !== null && isChosenProject(settings, projectId);

/** What the user must confirm before choosing `reply`. One wording, shown in Settings → Git. */
export const REPLY_WARNING =
  'Kestrel will post reviews, and approve pull requests, in your name without showing you first. A pull request is somebody else\'s text, and text in it can steer the model that reads it. Choose this only for repositories whose contributors you trust.';

/**
 * The choice of projects after one project is switched on or off, as its Settings tab does it.
 * Switching one off while the choice is every project makes it every project registered now but
 * that one. Switching the last missing one on does not make it "all": that also takes in projects
 * registered later, which only the user chooses.
 */
export function withProject(projects: ReviewProjects, projectId: string, on: boolean, registered: readonly string[]): ReviewProjects {
  if (projects === 'all') return on ? 'all' : registered.filter((id) => id !== projectId);
  const others = projects.filter((id) => id !== projectId);
  return on ? [...others, projectId] : others;
}

interface ReviewingSession {
  state: string;
  review?: { key: string };
}

/**
 * The requests to start a review of now: in a chosen project, with no review session yet, and not
 * already tried (`tried`: a start that was refused is not asked again). Oldest first, so a request
 * does not wait behind newer ones, and only as many as leave MAX_REVIEWS_AT_ONCE at work.
 */
export function reviewsToStart<T extends Pick<ReviewRequest, 'key' | 'projectId' | 'updatedAt'>>(settings: ReviewAutomation, requests: readonly T[], sessions: readonly ReviewingSession[], tried: ReadonlySet<string>): T[] {
  if (!isAutomatic(settings.mode)) return [];
  const reviewed = new Set(sessions.flatMap((s) => (s.review ? [s.review.key] : [])));
  const atWork = sessions.filter((s) => s.review && s.state === 'running').length;
  const free = Math.max(0, MAX_REVIEWS_AT_ONCE - atWork);
  return requests
    .filter((r) => startsOnItsOwn(settings, r.projectId) && !reviewed.has(r.key) && !tried.has(r.key))
    .sort((a, b) => a.updatedAt - b.updatedAt || a.key.localeCompare(b.key))
    .slice(0, free);
}
