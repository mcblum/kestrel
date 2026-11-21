// Short generated titles. A session starts with a provisional title from its first prompt
// (`titleFrom`), so its row and tab exist at once; the title providers (agents/title-providers.ts)
// are asked for a few-word title, the one for the session's agent first, then the others. When one
// comes back the session is renamed, but only if its title is still the provisional one: a rename
// by the user always wins, and a deleted session is left alone. Failure is silent to the user: one
// log line, the provisional title stays.
//
// A session that gets a worktree waits for the title, at most TITLE_WAIT_MS, so its branch is
// named from it (`decide`); one without a worktree has no branch and titles in the background
// (`begin`). A title that arrives after the wait renames the session, and then its branch when
// that is still safe (`whenTitled`, runtime/late-branch.ts).
import { providersFor, type TitleProvider } from '../agents/title-providers.ts';
import { sleep } from '../agents/title-request.ts';
import type { Agent } from '../model.ts';
import { titleIsEnough } from '../title.ts';
import { parseTitleReply, type TitleReply } from '../title-reply.ts';
import type { Workspace } from '../workspace.ts';

/** How long a new session's worktree waits for its generated title before using the provisional one. */
export const TITLE_WAIT_MS = 5_000;

type Log = (line: string) => void;
/** Tag candidates the title reply named, for the suggestions (suggestions/service.ts `fromTitle`). */
export type TitleTags = (sessionId: string, candidates: readonly Record<string, unknown>[]) => Promise<void>;

export interface TitleJob {
  sessionId: string;
  provisional: string;
  prompt: string;
  agent: Agent;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Resolves when `signal` is aborted; never without one. */
const aborted = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));

export class Titler {
  private readonly inFlight = new Set<Promise<void>>();
  /** Each session's titling while it runs. */
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly workspace: Pick<Workspace, 'retitleSession' | 'state'>,
    private readonly providers: readonly TitleProvider[] = [],
    /** The clock for the wait; tests pass one. */
    private readonly wait: (ms: number) => Promise<void> = sleep,
    private readonly log: Log = (line) => console.log(`[kestrel] ${line}`),
    /** Gets the reply's tag candidates; never delays the title or its wait. */
    private readonly onTags: TitleTags = async () => undefined,
  ) {}

  /** Starts titling in the background. Returns at once; never throws. */
  begin(job: TitleJob): void {
    this.launch(job);
  }

  /**
   * Titles the session, waiting at most TITLE_WAIT_MS, and returns the title to name its branch
   * from: the session's title by then (generated, renamed by the user, or still provisional).
   * Titling that is still running carries on in the background. An aborted `signal` (the user
   * stopped the session while it started) ends the wait at once. Never throws.
   */
  async decide(job: TitleJob, signal?: AbortSignal): Promise<string> {
    const work = this.launch(job);
    if (work && !signal?.aborted) await Promise.race([work, this.wait(TITLE_WAIT_MS), aborted(signal)]);
    return (await this.titleOf(job.sessionId)) ?? job.provisional;
  }

  /**
   * Runs `then` once the session's titling has finished: at once when it already has (it may have
   * ended while the worktree was being made) or never ran. Counted by `settled`. Never throws.
   */
  whenTitled(sessionId: string, then: () => Promise<void>): void {
    const work = this.running.get(sessionId) ?? Promise.resolve();
    this.track(work.then(then).catch((error) => this.log(`after the title of session ${sessionId}: ${message(error)}`)));
  }

  /** Resolves once every titling started so far has finished. For tests and shutdown. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  private launch(job: TitleJob): Promise<void> | null {
    if (this.providers.length === 0 || titleIsEnough(job.provisional, job.prompt)) return null;
    const work = this.track(this.run(job));
    this.running.set(job.sessionId, work);
    void work.finally(() => this.running.get(job.sessionId) === work && this.running.delete(job.sessionId));
    return work;
  }

  /** Counted by `settled` until it ends. */
  private track(work: Promise<void>): Promise<void> {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
    return work;
  }

  private async run({ sessionId, provisional, prompt, agent }: TitleJob): Promise<void> {
    const failures: string[] = [];
    try {
      for (const provider of providersFor(this.providers, agent)) {
        const reply = await this.ask(provider, prompt, failures);
        if (reply === null) continue;
        if (reply.tags.length) this.track(this.onTags(sessionId, reply.tags).catch((error) => this.log(`tag candidates for session ${sessionId}: ${message(error)}`)));
        if (reply.title !== provisional) await this.workspace.retitleSession(sessionId, provisional, reply.title);
        return;
      }
      this.log(`no generated title for session ${sessionId} (${failures.join('; ')}); keeping the first line`);
    } catch (error) {
      this.log(`title generation failed for session ${sessionId}: ${message(error)}`);
    }
  }

  /** One provider's cleaned title and tag candidates, or null (with the reason added to `failures`). */
  private async ask(provider: TitleProvider, prompt: string, failures: string[]): Promise<(TitleReply & { title: string }) | null> {
    try {
      const raw = await provider.title(prompt);
      const reply = raw === null ? null : parseTitleReply(raw);
      if (reply?.title == null) {
        failures.push(`${provider.name}: ${raw === null ? 'no reply' : 'unusable reply'}`);
        return null;
      }
      return { title: reply.title, tags: reply.tags };
    } catch (error) {
      failures.push(`${provider.name}: ${message(error)}`);
      return null;
    }
  }

  private async titleOf(sessionId: string): Promise<string | null> {
    return (await this.workspace.state()).sessions.find((s) => s.id === sessionId)?.title ?? null;
  }
}
