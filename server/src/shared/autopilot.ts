// Autopilot for a session's pull request (docs/designs/pr-autopilot.md, approved by Matt 2026-11-24).
// While it is on, Kestrel presses the "needs you" cards' main button itself (shared/request-attention.ts:
// failed checks, merge conflicts, requested changes), one round at a time, brings the branch up to date when
// the host will not merge it behind its base, and merges when the host says the request is ready if the user
// ticked Merge when green. With Watch ticked, a merge does not end it: it watches the pipeline on the
// commit the merge put on the target branch, and a failure there is a round that fixes it in a new pull
// request. It stops, and says why, when the rounds run out or it is stuck. Pure and browser-safe: the settings, the per-session record, the one step function and
// the words. The impure part is pull-requests/autopilot.ts.
import { mustCatchUp, primaryPullRequest, pullRequestStatus, type BasePipeline, type FailedCheck, type PullRequest, type PullRequestLookup } from './details.ts';
import { hostTerms, requestNumber, type HostKind } from './host-terms.ts';
import { attentionLine, catchUpMessage, fixMessage, occurrenceKey, OTHER_SERVICE_HINT, requestAttention, type AttentionPrefs, type ReasonDetail, type RequestAttention } from './request-attention.ts';
import type { Sourced } from './sourced.ts';
import type { MenuItem } from './menu.ts';

// ---- the user's choices (Settings → Git → Autopilot) -------------------------------------------

export interface AutopilotPrefs {
  /** Offer it with a card when a session's pull request first appears. */
  offer: boolean;
  /** Turn it on for every new request without asking (stored only after the warning was confirmed). */
  always: boolean;
  /** "Merge when green" ticked when it is offered, and what Always uses. */
  merge: boolean;
  /** Rounds before it stops. */
  rounds: number;
  /** How long one round may take, from its message until the checks on what it pushed have reported. */
  roundMinutes: number;
  /** "Watch the target branch's pipeline after merging" ticked when it is offered, and what Always uses. */
  watch: boolean;
  /** How long that pipeline may take, from the merge being seen until it has passed or failed. */
  watchMinutes: number;
}

export const DEFAULT_AUTOPILOT_PREFS: AutopilotPrefs = { offer: true, always: false, merge: false, rounds: 3, roundMinutes: 60, watch: false, watchMinutes: 60 };

/** What the user chose beside Autopilot itself: Merge when green, and Watch the target branch's pipeline after merging. */
export interface AutopilotChoice {
  merge: boolean;
  watch: boolean;
}
export const ROUNDS_MIN = 1;
export const ROUNDS_MAX = 10;
export const ROUND_MINUTES_MIN = 10;
export const ROUND_MINUTES_MAX = 24 * 60;
/** The time limits Settings offers in its select (any whole minutes in range are accepted). */
export const ROUND_MINUTE_CHOICES = [10, 20, 30, 45, 60, 90, 120, 180, 240, 360, 720, 1440] as const;

/** Shown before "Always turn it on" is stored (Matt, 2026-11-24). */
export const ALWAYS_WARNING =
  'Kestrel will respond on its own to every pull request a session opens: it fixes failed checks, merge conflicts and requested changes, brings a branch up to date where the host requires it, and pushes, without asking you, up to the rounds set here. With Merge when green ticked it also merges them. With Watch the target branch’s pipeline ticked it also watches the pipeline after each merge and, when it fails, fixes it in a new pull request.';

const whole = (v: unknown, min: number, max: number, fallback: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback);

/** Stored choices read back: anything unreadable is the default for that part. */
export function sanitizeAutopilotPrefs(raw: unknown): AutopilotPrefs {
  const v = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_AUTOPILOT_PREFS;
  return {
    offer: typeof v.offer === 'boolean' ? v.offer : d.offer,
    always: typeof v.always === 'boolean' ? v.always : d.always,
    merge: typeof v.merge === 'boolean' ? v.merge : d.merge,
    rounds: whole(v.rounds, ROUNDS_MIN, ROUNDS_MAX, d.rounds),
    roundMinutes: whole(v.roundMinutes, ROUND_MINUTES_MIN, ROUND_MINUTES_MAX, d.roundMinutes),
    watch: typeof v.watch === 'boolean' ? v.watch : d.watch,
    watchMinutes: whole(v.watchMinutes, ROUND_MINUTES_MIN, ROUND_MINUTES_MAX, d.watchMinutes),
  };
}

/** A change sent by the user, checked strictly: the change, or why it cannot be saved. */
export function checkAutopilotChange(raw: unknown): { ok: true; change: Partial<AutopilotPrefs> } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'Send the Autopilot settings as an object.' };
  const v = raw as Record<string, unknown>;
  const change: Partial<AutopilotPrefs> = {};
  for (const key of Object.keys(v)) {
    const value = v[key];
    if (key === 'offer' || key === 'always' || key === 'merge' || key === 'watch') {
      if (typeof value !== 'boolean') return { ok: false, reason: `${key} must be true or false.` };
      change[key] = value;
    } else if (key === 'rounds') {
      if (whole(value, ROUNDS_MIN, ROUNDS_MAX, -1) === -1) return { ok: false, reason: `Rounds must be a whole number from ${ROUNDS_MIN} to ${ROUNDS_MAX}.` };
      change.rounds = value as number;
    } else if (key === 'roundMinutes') {
      if (whole(value, ROUND_MINUTES_MIN, ROUND_MINUTES_MAX, -1) === -1) return { ok: false, reason: `A round's time limit must be from ${ROUND_MINUTES_MIN} minutes to ${ROUND_MINUTES_MAX / 60} hours, in whole minutes.` };
      change.roundMinutes = value as number;
    } else if (key === 'watchMinutes') {
      if (whole(value, ROUND_MINUTES_MIN, ROUND_MINUTES_MAX, -1) === -1) return { ok: false, reason: `The pipeline watch's time limit must be from ${ROUND_MINUTES_MIN} minutes to ${ROUND_MINUTES_MAX / 60} hours, in whole minutes.` };
      change.watchMinutes = value as number;
    } else if (key !== 'confirmed') return { ok: false, reason: `Autopilot has no setting called ${key.slice(0, 40)}.` };
  }
  if (change.always === true && v.confirmed !== true) return { ok: false, reason: `Confirm first: ${ALWAYS_WARNING}` };
  if (Object.keys(change).length === 0) return { ok: false, reason: 'Nothing to change.' };
  return { ok: true, change };
}

/** "1 hour", "90 minutes", "2 hours". */
export function minutesText(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

// ---- one session's record ------------------------------------------------------------------------

/** A round under way: its message was sent at `startedAt`, with the request at `head`. */
export interface AutopilotRound {
  startedAt: number;
  head: string;
  /** When its turn was first seen over. */
  idleSince?: number;
  /** The checks that had failed when it started, to tell the same failure twice. */
  failed: string[];
}

/** Why it stopped. `notify`: tell the user (a stop they did not cause themselves). */
export interface AutopilotStop {
  at: number;
  why: string;
  notify: boolean;
}

/** Watching the pipeline on the commit a merge put on the target branch. */
export interface AutopilotWatch {
  /** The merged request's host, for its words. */
  host: HostKind;
  /** The merged request, as its host writes it ("#431"). */
  request: string;
  /** The target branch ('' when the host did not say). */
  base: string;
  /** The commit the merge put there. */
  sha: string;
  /** When the merge was seen: the time limit and the wait for a pipeline to start count from here. */
  since: number;
}

/** One session's Autopilot, kept by the workspace and shown on its SessionView. */
export interface AutopilotRecord {
  /** The request it looks after. */
  number: number;
  merge: boolean;
  /** Watch the target branch's pipeline after the request is merged. */
  watch: boolean;
  /** That watch's time limit, as set when it was turned on. */
  watchMinutes: number;
  /** Present while it watches that pipeline. */
  watching?: AutopilotWatch;
  /** While a round fixes a failed pipeline on the target branch: the request whose merge it followed, and that branch. */
  fixing?: { request: string; base: string };
  /** The failed jobs of the last target-branch pipeline it set out to fix: the same ones failing again stop it. */
  pipelineFailed?: string[];
  /** Rounds started so far. */
  rounds: number;
  /** The most rounds, and a round's limit, as set when it was turned on. */
  maxRounds: number;
  roundMinutes: number;
  /** Occurrences a round was started for (`occurrenceKey`): never a second round for the same one. */
  handled: string[];
  round?: AutopilotRound;
  /** The head commit last seen, and since when: new checks are given time to start. */
  head?: { sha: string; at: number };
  /** The failed checks the last round set out to fix. */
  lastFailed?: string[];
  /** The head it said was green, so it says so once per commit. */
  green?: string;
  /** Present once it is off. */
  stopped?: AutopilotStop;
  /** Turned on before the session had an open request: it starts on the request once one is opened (`number` is 0 until then). */
  waiting?: boolean;
}

/** The user wants it: on, or waiting for the session's request to be opened. What a switch shows. */
export const isWanted = (r: AutopilotRecord | null | undefined): r is AutopilotRecord => !!r && !r.stopped;
/** At work on a request: wanted, and the request exists. */
export const isOn = (r: AutopilotRecord | null | undefined): r is AutopilotRecord => isWanted(r) && !r.waiting;
/**
 * At work, the user's message takes it back: on a request (or watching its pipeline), or waiting for the
 * request a round is opening to fix the target branch's pipeline. Not while it only waits for a first request.
 */
export const isAtWork = (r: AutopilotRecord | null | undefined): r is AutopilotRecord => isWanted(r) && (!r.waiting || !!r.round);

export function newRecord(number: number, choice: AutopilotChoice, prefs: AutopilotPrefs): AutopilotRecord {
  return { number, merge: choice.merge, watch: choice.watch, rounds: 0, maxRounds: prefs.rounds, roundMinutes: prefs.roundMinutes, watchMinutes: prefs.watchMinutes, handled: [] };
}

/**
 * A record waiting for its request that a round of the target branch's pipeline is opening: what it carries
 * on to that request (the rounds used and their limits, the round itself, the failed jobs it set out to fix),
 * on top of a new record for the request. Anything else starts afresh.
 */
export function carriedOver(from: AutopilotRecord | null | undefined, fresh: AutopilotRecord): AutopilotRecord {
  if (!isWanted(from) || !from.waiting || !from.round) return fresh;
  return {
    ...fresh,
    rounds: from.rounds,
    maxRounds: from.maxRounds,
    roundMinutes: from.roundMinutes,
    watchMinutes: from.watchMinutes,
    round: from.round,
    ...(from.pipelineFailed ? { pipelineFailed: from.pipelineFailed } : {}),
  };
}

/** When the PR store first saw the request's head commit (`headSeenAt`), never later than now; now when it did not say. */
export const seenAt = (pr: Pick<PullRequest, 'headSeenAt'>, now: number): number => Math.min(pr.headSeenAt ?? now, now);

/**
 * A new record for a request as it stands when Autopilot is turned on (issue 82): its head is taken as seen
 * when the store first saw it, so checks that have long settled are not waited on again, and the first step
 * acts at once on what already needs doing (failed checks, conflicts, requested changes, a branch the host
 * requires to catch up, or a merge when it is green).
 */
export function recordFor(pr: Pick<PullRequest, 'number' | 'headSha' | 'headSeenAt'> | null, number: number, choice: AutopilotChoice, prefs: AutopilotPrefs, now: number): AutopilotRecord {
  const record = newRecord(pr?.number ?? number, choice, prefs);
  return pr?.headSha ? { ...record, head: { sha: pr.headSha, at: seenAt(pr, now) } } : record;
}

/** A stored record read back; null when it is not one. */
export function asRecord(raw: unknown): AutopilotRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<AutopilotRecord>;
  if (typeof r.number !== 'number' || typeof r.merge !== 'boolean' || typeof r.rounds !== 'number' || !Array.isArray(r.handled)) return null;
  return {
    ...(r as AutopilotRecord),
    maxRounds: whole(r.maxRounds, ROUNDS_MIN, ROUNDS_MAX, DEFAULT_AUTOPILOT_PREFS.rounds),
    roundMinutes: whole(r.roundMinutes, ROUND_MINUTES_MIN, ROUND_MINUTES_MAX, DEFAULT_AUTOPILOT_PREFS.roundMinutes),
    // Kept before the watch existed: watch off.
    watch: r.watch === true,
    watchMinutes: whole(r.watchMinutes, ROUND_MINUTES_MIN, ROUND_MINUTES_MAX, DEFAULT_AUTOPILOT_PREFS.watchMinutes),
  };
}

// ---- the step --------------------------------------------------------------------------------------

/** After a round's turn ends with nothing pushed, this long for the store to see a push before it counts as none. */
export const NO_PUSH_GRACE_MS = 2 * 60_000;
/** After a new commit is seen, this long for its checks to start before it is taken as clean. */
export const CHECKS_SETTLE_MS = 90_000;

export interface StepInput {
  record: AutopilotRecord;
  lookup: Sourced<PullRequestLookup> | undefined;
  attention: AttentionPrefs;
  /** Not working and not waiting on an answer (`isIdle`). */
  idle: boolean;
  /** Its last turn failed or was stopped. */
  failed: boolean;
  /** The head commit is one no session of Kestrel's made (a person pushed), when known. */
  foreignPush?: boolean;
  /** While it watches the target branch's pipeline: that pipeline as the PR store holds it. */
  pipeline?: Sourced<BasePipeline>;
  now: number;
}

export type AutopilotAct =
  | { type: 'none' }
  | { type: 'round'; message: string; round: number }
  | { type: 'merge'; pr: PullRequest }
  | { type: 'green'; line: string }
  | { type: 'stop'; stop: AutopilotStop }
  /** The request was merged and it now watches the target branch's pipeline: the store is asked to keep it current. */
  | { type: 'watch'; watching: AutopilotWatch; line: string }
  /** Done, quietly, with a line in the session (the watched pipeline passed, or none ran). */
  | { type: 'end'; line: string };

export interface Step {
  record: AutopilotRecord;
  act: AutopilotAct;
}

type Where = { host: HostKind; number: number };
const whereOf = (a: Where): string => requestNumber(hostTerms(a.host), a.number);
const NONE: AutopilotAct = { type: 'none' };

function stopped(record: AutopilotRecord, now: number, why: string, notify = true): Step {
  const stop = { at: now, why, notify };
  const { round: _round, watching: _watching, ...rest } = record;
  return { record: { ...rest, stopped: stop }, act: { type: 'stop', stop } };
}

/** Off without telling anyone, with one line in the session saying how it ended. */
function ended(record: AutopilotRecord, now: number, why: string, line: string): Step {
  const { record: off } = stopped(record, now, why, false);
  return { record: off, act: { type: 'end', line } };
}

const failedNames = (pr: PullRequest): string[] => (pr.failedChecks ?? []).map((c) => c.name).sort();
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);

/** The message a round sends: what the cards' buttons send, for each reason, under one heading. */
export function roundMessage(a: Omit<RequestAttention, 'reasons'>, reasons: readonly ReasonDetail[], round: number, maxRounds: number): string {
  return roundText(a, reasons.map((d) => fixMessage(a, d)), round, maxRounds);
}

function roundText(a: Where, parts: readonly string[], round: number, maxRounds: number): string {
  return [
    `Autopilot, round ${round} of ${maxRounds}: ${whereOf(a)} needs work before it can be merged.`,
    '',
    parts.join('\n\n---\n\n'),
    '',
    'When you are done, commit and push to the same branch, then end your turn: Kestrel watches the checks and comes back if more is needed. If you cannot fix something, push nothing and say plainly why, so I can take over.',
  ].join('\n');
}

/**
 * How every line that tells the user Autopilot gave a request back begins. The conversation draws such a line
 * with the plane, not the warning sign (`isDisengagedLine`).
 */
export const AUTOPILOT_DISENGAGED = 'Autopilot disengaged.';
/** The last sentence of such a line in the conversation. */
export const CONTROLS_YOURS = 'The controls are yours again.';
export const isDisengagedLine = (text: string): boolean => text.startsWith(AUTOPILOT_DISENGAGED);

/**
 * What Autopilot does now for one session, and its record after. Pure. Called after every change of the
 * session, its request or the choices, and on a timer for the time limits.
 */
export function autopilotStep(input: StepInput): Step {
  const { now } = input;
  let record = input.record;
  if (record.stopped) return { record, act: NONE };
  if (record.watching) return watchStep(input, record, record.watching);
  if (record.waiting) return record.round ? fixWaitStep(input, record, record.round) : { record, act: NONE };
  if (!input.lookup || input.lookup.state !== 'ready') return { record, act: NONE };
  const pr = input.lookup.value.pullRequests.find((p) => p.number === record.number) ?? null;
  if (!pr) return { record, act: NONE };
  const where = whereOf({ host: input.lookup.value.host, number: pr.number });
  if (pr.state === 'merged') return mergedStep(record, pr, input.lookup.value.host, where, now);
  if (pr.state === 'closed') return stopped(record, now, `${where} was closed`, false);
  const head = pr.headSha ?? '';
  const moved = !!head && record.head?.sha !== head;
  // A commit's checks are given time to start from when the store first saw it, not from when Autopilot did.
  if (moved) record = { ...record, head: { sha: head, at: seenAt(pr, now) } };

  const round = record.round;
  if (round) {
    if (now - round.startedAt > record.roundMinutes * 60_000) return stopped(record, now, `${AUTOPILOT_DISENGAGED} ${where}: round ${record.rounds} went over its time limit of ${minutesText(record.roundMinutes)}`);
    if (!input.idle) return { record, act: NONE };
    if (input.failed) return stopped(record, now, `${AUTOPILOT_DISENGAGED} ${where}: the agent's turn in round ${record.rounds} failed or was stopped`);
    const idleSince = round.idleSince ?? now;
    if (head === round.head) {
      if (now - idleSince >= NO_PUSH_GRACE_MS) return stopped(record, now, `${AUTOPILOT_DISENGAGED} ${where}: the agent pushed nothing in round ${record.rounds}`);
      return { record: { ...record, round: { ...round, idleSince } }, act: NONE };
    }
    // Pushed: the round lasts until the checks on what it pushed have reported, under the same time limit.
    const settling = pr.checks === 'running' || (record.head !== undefined && now - record.head.at < CHECKS_SETTLE_MS && pr.checks !== 'failing');
    if (settling) return { record: { ...record, round: { ...round, idleSince } }, act: NONE };
    const { round: _done, ...rest } = record;
    record = { ...rest, lastFailed: round.failed };
  } else if (moved && input.foreignPush) {
    return stopped(record, now, `${AUTOPILOT_DISENGAGED} ${where}: someone else pushed to it`);
  }

  if (!input.idle) return { record, act: NONE };
  if (pr.checks === 'running') return { record, act: NONE };
  const settled = !record.head || now - record.head.at >= CHECKS_SETTLE_MS;
  const attention = requestAttention(input.lookup, input.attention);
  const holds = attention && attention.number === pr.number ? attention.reasons : [];

  if (holds.length > 0) {
    // A conflict that outlived a round is the same occurrence: the round did not resolve it.
    const unresolved = holds.find((d) => d.reason === 'conflicts' && record.handled.includes(occurrenceKey(d)));
    if (unresolved) return stopped(record, now, `${AUTOPILOT_DISENGAGED} ${where}: the merge conflicts are still there after round ${record.rounds}`);
    const fresh = holds.filter((d) => !record.handled.includes(occurrenceKey(d)));
    // A review asking still, after its round: waiting on the reviewer, not on the agent.
    if (fresh.length === 0) return { record, act: NONE };
    const failedNow = failedNames(pr);
    if (fresh.some((d) => d.reason === 'checks-failed') && sameList(failedNow, record.lastFailed ?? [])) return stopped(record, now, `${AUTOPILOT_DISENGAGED} ${where}: the same checks failed again after round ${record.rounds} (${failedNow.join(', ')})`);
    if (record.rounds >= record.maxRounds) return stopped(record, now, `${AUTOPILOT_DISENGAGED} ${where} after ${record.rounds} ${record.rounds === 1 ? 'round' : 'rounds'}: ${attentionLine({ host: attention!.host, number: pr.number, reasons: fresh }).replace(/^./, (c) => c.toLowerCase())}`);
    const n = record.rounds + 1;
    const { reasons: _all, ...request } = attention!;
    return {
      record: { ...record, rounds: n, handled: [...record.handled, ...fresh.map(occurrenceKey)].slice(-50), round: { startedAt: now, head, failed: failedNow } },
      act: { type: 'round', message: roundMessage(request, fresh, n, record.maxRounds), round: n },
    };
  }

  if (!settled) return { record, act: NONE };
  if (mustCatchUp(pr)) {
    // Behind a base the host requires it to be level with: a round merges the base in. Once per head commit.
    const key = `behind\n${head}`;
    if (record.handled.includes(key)) return { record, act: NONE };
    const base = pr.baseBranch ?? null;
    if (record.rounds >= record.maxRounds) return stopped(record, now, `${AUTOPILOT_DISENGAGED} ${where} after ${record.rounds} ${record.rounds === 1 ? 'round' : 'rounds'}: its branch is behind ${base ?? 'its target branch'}`);
    const n = record.rounds + 1;
    const request = { host: input.lookup.value.host, number: pr.number, title: pr.title, url: pr.url, commit: head || `#${pr.number}` };
    return {
      record: { ...record, rounds: n, handled: [...record.handled, key].slice(-50), round: { startedAt: now, head, failed: [] } },
      act: { type: 'round', message: roundText(request, [catchUpMessage(request, base)], n, record.maxRounds), round: n },
    };
  }
  const green = pr.state === 'open' && pullRequestStatus(pr).tone === 'green';
  if (!green) return { record, act: NONE };
  if (record.merge) return { record, act: { type: 'merge', pr } };
  if (record.green === head) return { record, act: NONE };
  return { record: { ...record, green: head }, act: { type: 'green', line: `${where} is green: ready to merge` } };
}

// ---- after the merge: the target branch's pipeline ------------------------------------------------

/** "the main pipeline", or the target branch's when the host did not name it. */
export const pipelineName = (base: string): string => (base ? `the ${base} pipeline` : 'the target branch’s pipeline');
const branchName = (base: string): string => (base ? base : 'the target branch');
const capital = (text: string): string => text.replace(/^./, (c) => c.toUpperCase());
const shortSha = (sha: string): string => (/^[0-9a-f]{12,}$/i.test(sha) ? sha.slice(0, 8) : sha);

/** Merged: without Watch it ends quietly, as before; with it, it watches the pipeline on the commit the merge made. */
function mergedStep(record: AutopilotRecord, pr: PullRequest, host: HostKind, where: string, now: number): Step {
  if (!record.watch) return stopped(record, now, `${where} was merged`, false);
  const base = pr.baseBranch ?? '';
  const sha = pr.mergeSha ?? pr.headSha;
  if (!sha) return ended(record, now, `${where} was merged`, `Autopilot: ${where} was merged, but the host did not say which commit the merge made, so there is no pipeline to watch.`);
  const watching: AutopilotWatch = { host, request: where, base, sha, since: now };
  const { round: _round, green: _green, ...rest } = record;
  return { record: { ...rest, watching }, act: { type: 'watch', watching, line: `Autopilot: ${where} was merged. Watching ${pipelineName(base)} on ${shortSha(sha)}.` } };
}

/** Watching the pipeline on the merge's commit: passed or none ends it quietly, failed is a round, too long stops it. */
function watchStep(input: StepInput, record: AutopilotRecord, w: AutopilotWatch): Step {
  const { now } = input;
  const p = input.pipeline?.state === 'ready' && input.pipeline.value.sha === w.sha ? input.pipeline.value : null;
  const name = pipelineName(w.base);
  if (p?.checks === 'passing') return ended(record, now, `${capital(name)} passed after ${w.request}`, `Autopilot: ${name} passed after ${w.request}.`);
  if (p?.checks === 'failing') return pipelineFailedStep(input, record, w, p);
  if (now - w.since > record.watchMinutes * 60_000) return stopped(record, now, `${AUTOPILOT_DISENGAGED} ${capital(name)} after ${w.request} did not finish within ${minutesText(record.watchMinutes)}`);
  if (p?.checks === 'none' && now - w.since >= CHECKS_SETTLE_MS) return ended(record, now, `No pipeline ran on ${branchName(w.base)} after ${w.request}`, `Autopilot: no pipeline ran on ${branchName(w.base)} after ${w.request}, so there was nothing to watch.`);
  return { record, act: NONE };
}

/** The watched pipeline failed: a round that fixes it in a new request, unless the same jobs failed last time or no rounds are left. */
function pipelineFailedStep(input: StepInput, record: AutopilotRecord, w: AutopilotWatch, p: BasePipeline): Step {
  const { now } = input;
  // A turn already on its way (the user's, say) finishes first; the time limit no longer applies, the pipeline did finish.
  if (!input.idle) return { record, act: NONE };
  const names = (p.failedChecks ?? []).map((c) => c.name).sort();
  const listed = names.length > 0 ? ` (${names.join(', ')})` : '';
  if (sameList(names, record.pipelineFailed ?? [])) return stopped(record, now, `${AUTOPILOT_DISENGAGED} The same jobs failed again on ${branchName(w.base)} after ${w.request}${listed}`);
  if (record.rounds >= record.maxRounds) return stopped(record, now, `${AUTOPILOT_DISENGAGED} ${capital(pipelineName(w.base))} failed after ${w.request}${listed}, and all ${record.maxRounds} ${record.maxRounds === 1 ? 'round is' : 'rounds are'} used`);
  const n = record.rounds + 1;
  const { watching: _watching, green: _green, lastFailed: _lastFailed, head: _head, ...rest } = record;
  return {
    // It waits for the request the round opens, as when turned on before one existed; the round goes on with it.
    record: { ...rest, number: 0, waiting: true, rounds: n, fixing: { request: w.request, base: w.base }, pipelineFailed: names, round: { startedAt: now, head: '', failed: names } },
    act: { type: 'round', message: pipelineFixMessage(w, p, n, record.maxRounds), round: n },
  };
}

/** Waiting for the request a round is opening to fix the target branch's pipeline: the round's limits, and none opened. */
function fixWaitStep(input: StepInput, record: AutopilotRecord, round: AutopilotRound): Step {
  const { now } = input;
  const fixing = `fixing ${pipelineName(record.fixing?.base ?? '')}${record.fixing ? ` after ${record.fixing.request}` : ''}`;
  if (now - round.startedAt > record.roundMinutes * 60_000) return stopped(record, now, `${AUTOPILOT_DISENGAGED} Round ${record.rounds}, ${fixing}, went over its time limit of ${minutesText(record.roundMinutes)}`);
  if (!input.idle) return { record, act: NONE };
  if (input.failed) return stopped(record, now, `${AUTOPILOT_DISENGAGED} The agent's turn in round ${record.rounds}, ${fixing}, failed or was stopped`);
  const idleSince = round.idleSince ?? now;
  if (now - idleSince >= NO_PUSH_GRACE_MS) return stopped(record, now, `${AUTOPILOT_DISENGAGED} The agent opened no request to fix ${pipelineName(record.fixing?.base ?? '')}${record.fixing ? ` after ${record.fixing.request}` : ''} in round ${record.rounds}`);
  return round.idleSince === idleSince ? { record, act: NONE } : { record: { ...record, round: { ...round, idleSince } }, act: NONE };
}

const PIPELINE_LOG_HINT: Record<HostKind, string> = {
  github: 'Each link is the page where that check reported its failure. For a GitHub Actions run, from a shell, `gh run view <run id> --log-failed` prints a failed run\'s log (the run id is in the link).',
  gitlab: 'Each link is the page where that job or status reported its failure. For a GitLab CI job, from a shell, `glab ci trace <job id>` prints its log (the job id is the number at the end of the link).',
};

/** The message of a round that fixes the target branch's pipeline: in a new request, never on the branch itself. */
export function pipelineFixMessage(w: AutopilotWatch, p: Pick<BasePipeline, 'failedChecks' | 'url'>, round: number, maxRounds: number): string {
  const base = w.base ? `\`${w.base}\`` : 'the target branch';
  const terms = hostTerms(w.host);
  const failed: readonly FailedCheck[] = p.failedChecks ?? [];
  const lines = failed.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ''}`);
  const all = p.url ? [`- The whole pipeline: ${p.url}`] : [];
  return [
    `Autopilot, round ${round} of ${maxRounds}: the pipeline on ${base} failed at commit ${shortSha(w.sha)}, after ${w.request} was merged.`,
    '',
    failed.length > 0 ? 'These failed:' : 'The host did not say which jobs failed.',
    ...lines,
    ...all,
    '',
    PIPELINE_LOG_HINT[w.host],
    OTHER_SERVICE_HINT,
    '',
    `Find out why it failed. Then, in this worktree, on this session's own branch: fetch from the remote and merge the remote's ${base} into this branch (a merge, not a rebase; never force-push, and never push to ${base} itself), fix what made the pipeline fail, run the tests, commit, push the branch, and open a new ${terms.long} into ${base} whose description says it fixes the ${w.base ? `\`${w.base}\` ` : ''}pipeline after ${w.request}.`,
    '',
    `When you are done, end your turn: Kestrel looks after the new ${terms.long} as it did ${w.request}. If you cannot fix it, open no ${terms.long} and say plainly why, so I can take over.`,
  ].join('\n');
}

/** What the session's request is, for the offer: its primary request, open or a draft. */
export function offeredRequest(lookup: Sourced<PullRequestLookup> | undefined): PullRequest | null {
  if (!lookup || lookup.state !== 'ready') return null;
  const pr = primaryPullRequest(lookup.value.pullRequests);
  return pr && (pr.state === 'open' || pr.state === 'draft') ? pr : null;
}

/** The record's state in a few words, for the pill's menu and Session Details. */
export function autopilotText(r: AutopilotRecord | null | undefined): string {
  if (!r) return 'Off';
  if (r.stopped) return `Off: ${r.stopped.why}`;
  if (r.watching) return `On: watching ${pipelineName(r.watching.base)} after ${r.watching.request}`;
  const merge = `${r.merge ? ', merges when green' : ''}${r.watch ? ', watches the pipeline after merging' : ''}`;
  if (r.waiting && r.round && r.fixing) return `On${merge}: round ${r.rounds} of ${r.maxRounds} under way, fixing ${pipelineName(r.fixing.base)} after ${r.fixing.request}`;
  if (r.waiting) return `On${merge}: starts when this session’s pull request is opened`;
  return r.round ? `On${merge}: round ${r.rounds} of ${r.maxRounds} under way` : `On${merge}: ${r.rounds} of ${r.maxRounds} rounds used`;
}

/**
 * The words on the Autopilot control under the message box: every state told by its words, not its colour.
 * Off (never on, or turned off by the user), stopped on its own (it said why), waiting for the request, at
 * work on a round, or on.
 */
export function autopilotLabel(r: AutopilotRecord | null | undefined): string {
  if (!r) return 'Autopilot off';
  if (r.stopped) return r.stopped.notify ? 'Autopilot stopped' : 'Autopilot off';
  if (r.watching) return `Autopilot · watching ${branchName(r.watching.base)}`;
  const merge = `${r.merge ? ' · merge' : ''}${r.watch ? ' · watch' : ''}`;
  if (r.round) return `Autopilot${merge} · round ${r.rounds} of ${r.maxRounds}`;
  if (r.waiting) return `Autopilot${merge} · waiting`;
  return `Autopilot${merge}`;
}

/** "Watch the main pipeline after merging", by the request's target branch when known. */
export const watchLabel = (base: string | null | undefined): string => `Watch ${base ? `the ${base} pipeline` : 'the target branch’s pipeline'} after merging`;

/**
 * The request pill's Autopilot menu: a switch for Autopilot, one for Merge when green and one for Watch the
 * target branch's pipeline (shown while it is on), and what it is doing now. Turned on before the session has
 * an open request, it waits for one. `base`: the request's target branch, for the watch's words.
 */
export function autopilotMenu(sessionId: string, record: AutopilotRecord | null | undefined, base?: string | null): MenuItem[] {
  const on = isWanted(record);
  const items: MenuItem[] = [{ id: 'autopilot', label: 'Autopilot', heading: autopilotText(record), toggle: true, checked: on, action: { type: 'set-autopilot', sessionId, on: !on } }];
  if (on) {
    items.push({ id: 'autopilot-merge', label: 'Merge when green', toggle: true, checked: record!.merge, action: { type: 'set-autopilot', sessionId, on: true, merge: !record!.merge } });
    const watchBase = record!.watching?.base ?? record!.fixing?.base ?? base;
    items.push({ id: 'autopilot-watch', label: watchLabel(watchBase), toggle: true, checked: record!.watch, action: { type: 'set-autopilot', sessionId, on: true, watch: !record!.watch } });
  }
  return items;
}
