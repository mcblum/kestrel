// The one copy, on the server, of the requests the user was asked to review. Held per host, kept
// current in the background (sync.ts) and pushed: nothing asks gh or glab per view. A host that
// cannot be asked keeps its last answer and gains a problem, so a failed ask never empties the
// list. Listeners hear only when what would be pushed really changed.
// A request the user dismissed stays held, apart (`dismissed`): it is not listed as waiting, no
// review of it starts on its own, and it comes back only when the user restores it. The dismissed
// keys are kept with the app's settings, and outlive the request: a host that answers with nothing
// for a moment must not bring three hundred dismissed requests back.
// A waiting request the user has not opened is unread (`unread`): it is read once its page is
// opened, a review of it is started, or it is marked read. The read keys are kept the same way.
// How a request arrived decides whether it is new at all (arrivals.ts): one the host already calls
// satisfied when it first arrives is read from the start.
import { arrive, NO_ARRIVALS, type ReviewArrivals } from './arrivals.ts';
import { NO_REVIEW_REQUESTS, orderReviewRequests, withDismissed, type ReviewRequest, type ReviewRequestsView } from '../shared/review-requests.ts';
import type { Sourced } from '../shared/sourced.ts';

interface HostEntry {
  requests: readonly ReviewRequest[];
  problem: string | null;
}

export type ReviewRequestListener = (view: ReviewRequestsView) => void;

export interface ReviewRequestStoreOptions {
  /** The order the user left the rows in, as it was last stored. */
  order?: readonly string[];
  /** Keeps the order when it changes; failures are the caller's to log. */
  saveOrder?: (order: readonly string[]) => void;
  /** The keys of the requests the user dismissed, as they were last stored. */
  dismissed?: readonly string[];
  /** Keeps the dismissed keys when they change; failures are the caller's to log. */
  saveDismissed?: (keys: readonly string[]) => void;
  /** The keys of the requests the user has looked at, as they were last stored. */
  seen?: readonly string[];
  /** Keeps the read keys when they change; failures are the caller's to log. */
  saveSeen?: (keys: readonly string[]) => void;
  /** Which requests have been listed, and which were read because they arrived satisfied; null when never stored. */
  arrivals?: ReviewArrivals | null;
  /** Keeps that record when it changes; failures are the caller's to log. */
  saveArrivals?: (arrivals: ReviewArrivals) => void;
}

export class ReviewRequestStore {
  private order: readonly string[];
  private dismissedKeys: readonly string[];
  private seenKeys: readonly string[];
  private arrivals: ReviewArrivals;
  /** The record was never stored: each host's first answer is only learned, so nothing unread is read by it. */
  private readonly seedFirst: boolean;

  constructor(private readonly options: ReviewRequestStoreOptions = {}) {
    this.arrivals = options.arrivals ?? NO_ARRIVALS;
    this.seedFirst = !options.arrivals;
    this.order = options.order ?? [];
    this.dismissedKeys = options.dismissed ?? [];
    this.seenKeys = options.seen ?? [];
    this.current = { ...NO_REVIEW_REQUESTS, order: [...this.order] };
    this.json = JSON.stringify(this.current);
  }

  /** The order the user dragged the rows into. Keys of requests no longer listed are kept: a request that comes back keeps its place. */
  setOrder(order: readonly string[]): void {
    this.order = [...order];
    this.options.saveOrder?.(this.order);
    this.replace(this.hosts);
  }

  /** Dismiss these requests (`on`), or restore them. A key of a request not listed now is kept all the same. */
  dismiss(keys: readonly string[], on: boolean): void {
    const next = withDismissed(this.dismissedKeys, keys, on);
    if (next.length === this.dismissedKeys.length && next.every((key, i) => key === this.dismissedKeys[i])) return;
    this.dismissedKeys = next;
    this.options.saveDismissed?.(next);
    // Dismissed is looked at: restored later, it does not come back as new.
    if (on) this.keepSeen(withDismissed(this.seenKeys, keys, true));
    this.replace(this.hosts);
  }

  /** Whether the user dismissed this request. */
  isDismissed(key: string): boolean {
    return this.dismissedKeys.includes(key);
  }

  /** Mark these requests read (`seen`), or unread again. A waiting request not marked read is new. */
  markSeen(keys: readonly string[], seen: boolean): void {
    if (this.keepSeen(withDismissed(this.seenKeys, keys, seen))) this.replace(this.hosts);
  }

  private keepSeen(next: readonly string[]): boolean {
    if (next.length === this.seenKeys.length && next.every((key, i) => key === this.seenKeys[i])) return false;
    this.seenKeys = next;
    this.options.saveSeen?.(next);
    return true;
  }

  private hosts: ReadonlyMap<string, HostEntry> = new Map();
  /** Why a review of a request could not be started on its own, by the request's key. */
  private notes: ReadonlyMap<string, string> = new Map();
  private current: ReviewRequestsView;
  private json: string;
  private readonly listeners = new Set<ReviewRequestListener>();

  /** Everything held, most recently changed first. The same object until it changes. */
  view(): ReviewRequestsView {
    return this.current;
  }

  /** A host's answer. One that could not be given keeps the host's last list and records why. */
  set(hostName: string, answer: Sourced<ReviewRequest[]>): void {
    if (answer.state === 'loading') return;
    const held = this.hosts.get(hostName);
    if (answer.state === 'ready') this.arriving(answer.value, this.seedFirst && !held);
    const entry: HostEntry = answer.state === 'ready' ? { requests: answer.value, problem: null } : { requests: held?.requests ?? [], problem: answer.reason };
    this.replace(new Map(this.hosts).set(hostName, entry));
  }

  private arriving(requests: readonly ReviewRequest[], seeding: boolean): void {
    const step = arrive(this.arrivals, this.seenKeys, requests, seeding);
    if (step.arrivals !== this.arrivals) {
      this.arrivals = step.arrivals;
      this.options.saveArrivals?.(step.arrivals);
    }
    this.keepSeen(step.seen);
  }

  /** Only these hosts are still asked: what the others answered is dropped. */
  keep(hostNames: readonly string[]): void {
    const kept = new Set(hostNames);
    this.replace(new Map([...this.hosts].filter(([name]) => kept.has(name))));
  }

  /** Record why a review of this request could not be started on its own; shown on its page. */
  note(key: string, reason: string): void {
    this.notes = new Map(this.notes).set(key, reason);
    this.replace(this.hosts);
  }

  /** Forget every such reason: the setting changed, so each request may be tried again. */
  clearNotes(): void {
    this.notes = new Map();
    this.replace(this.hosts);
  }

  /** The keys of the requests that carry a reason. */
  noted(): ReadonlySet<string> {
    return new Set(this.notes.keys());
  }

  onChange(listener: ReviewRequestListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private replace(hosts: ReadonlyMap<string, HostEntry>): void {
    this.hosts = hosts;
    const names = [...hosts.keys()].sort();
    const listed = names.flatMap((name) => hosts.get(name)!.requests);
    // A reason outlives its request only until the request leaves the list.
    const keys = new Set(listed.map((r) => r.key));
    this.notes = new Map([...this.notes].filter(([key]) => keys.has(key)));
    const gone = new Set(this.dismissedKeys);
    const seen = new Set(this.seenKeys);
    const view: ReviewRequestsView = {
      requests: orderReviewRequests(listed.filter((r) => !gone.has(r.key)).map((r) => (this.notes.has(r.key) ? { ...r, notStarted: this.notes.get(r.key)! } : r))),
      unread: listed.filter((r) => !gone.has(r.key) && !seen.has(r.key)).map((r) => r.key).sort(),
      dismissed: orderReviewRequests(listed.filter((r) => gone.has(r.key))),
      order: [...this.order],
      problems: names.flatMap((name) => (hosts.get(name)!.problem ? [{ hostName: name, reason: hosts.get(name)!.problem! }] : [])),
    };
    const json = JSON.stringify(view);
    if (json === this.json) return;
    this.current = view;
    this.json = json;
    for (const listener of this.listeners) listener(view);
  }
}
