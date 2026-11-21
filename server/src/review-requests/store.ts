// The one copy, on the server, of the requests the user was asked to review. Held per host, kept
// current in the background (sync.ts) and pushed: nothing asks gh or glab per view. A host that
// cannot be asked keeps its last answer and gains a problem, so a failed ask never empties the
// list. Listeners hear only when what would be pushed really changed.
import { NO_REVIEW_REQUESTS, orderReviewRequests, type ReviewRequest, type ReviewRequestsView } from '../shared/review-requests.ts';
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
}

export class ReviewRequestStore {
  private order: readonly string[];

  constructor(private readonly options: ReviewRequestStoreOptions = {}) {
    this.order = options.order ?? [];
    this.current = { ...NO_REVIEW_REQUESTS, order: [...this.order] };
    this.json = JSON.stringify(this.current);
  }

  /** The order the user dragged the rows into. Keys of requests no longer listed are kept: a request that comes back keeps its place. */
  setOrder(order: readonly string[]): void {
    this.order = [...order];
    this.options.saveOrder?.(this.order);
    this.replace(this.hosts);
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
    const entry: HostEntry = answer.state === 'ready' ? { requests: answer.value, problem: null } : { requests: held?.requests ?? [], problem: answer.reason };
    this.replace(new Map(this.hosts).set(hostName, entry));
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
    const view: ReviewRequestsView = {
      requests: orderReviewRequests(listed.map((r) => (this.notes.has(r.key) ? { ...r, notStarted: this.notes.get(r.key)! } : r))),
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
