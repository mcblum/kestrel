// Autopilot for a session's pull request (docs/designs/pr-autopilot.md, approved by Matt 2026-11-24).
// While it is on, Kestrel presses the "needs you" cards' main button itself (shared/request-attention.ts:
// failed checks, merge conflicts, requested changes), one round at a time, and merges when the host says
// the request is ready if the user ticked Merge when green. It stops, and says why, when the rounds run out
// or it is stuck. Pure and browser-safe: the settings, the per-session record, the one step function and
// the words. The impure part is pull-requests/autopilot.ts.
import { primaryPullRequest, pullRequestStatus, type PullRequest, type PullRequestLookup } from './details.ts';
import { hostTerms, requestNumber, type HostKind } from './host-terms.ts';
import { attentionLine, fixMessage, occurrenceKey, requestAttention, type AttentionPrefs, type ReasonDetail, type RequestAttention } from './request-attention.ts';
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
}

export const DEFAULT_AUTOPILOT_PREFS: AutopilotPrefs = { offer: true, always: false, merge: false, rounds: 3, roundMinutes: 60 };
export const ROUNDS_MIN = 1;
export const ROUNDS_MAX = 10;
export const ROUND_MINUTES_MIN = 10;
export const ROUND_MINUTES_MAX = 24 * 60;
/** The time limits Settings offers in its select (any whole minutes in range are accepted). */
export const ROUND_MINUTE_CHOICES = [10, 20, 30, 45, 60, 90, 120, 180, 240, 360, 720, 1440] as const;

/** Shown before "Always turn it on" is stored (Matt, 2026-11-24). */
export const ALWAYS_WARNING =
  'Kestrel will respond on its own to every pull request a session opens: it fixes failed checks, merge conflicts and requested changes and pushes, without asking you, up to the rounds set here. With Merge when green ticked it also merges them.';

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
  };
}

/** A change sent by the user, checked strictly: the change, or why it cannot be saved. */
export function checkAutopilotChange(raw: unknown): { ok: true; change: Partial<AutopilotPrefs> } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'Send the Autopilot settings as an object.' };
  const v = raw as Record<string, unknown>;
  const change: Partial<AutopilotPrefs> = {};
  for (const key of Object.keys(v)) {
    const value = v[key];
    if (key === 'offer' || key === 'always' || key === 'merge') {
      if (typeof value !== 'boolean') return { ok: false, reason: `${key} must be true or false.` };
      change[key] = value;
    } else if (key === 'rounds') {
      if (whole(value, ROUNDS_MIN, ROUNDS_MAX, -1) === -1) return { ok: false, reason: `Rounds must be a whole number from ${ROUNDS_MIN} to ${ROUNDS_MAX}.` };
      change.rounds = value as number;
    } else if (key === 'roundMinutes') {
      if (whole(value, ROUND_MINUTES_MIN, ROUND_MINUTES_MAX, -1) === -1) return { ok: false, reason: `A round's time limit must be from ${ROUND_MINUTES_MIN} minutes to ${ROUND_MINUTES_MAX / 60} hours, in whole minutes.` };
      change.roundMinutes = value as number;
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

/** One session's Autopilot, kept by the workspace and shown on its SessionView. */
export interface AutopilotRecord {
  /** The request it looks after. */
  number: number;
  merge: boolean;
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

export function newRecord(number: number, merge: boolean, prefs: AutopilotPrefs): AutopilotRecord {
  return { number, merge, rounds: 0, maxRounds: prefs.rounds, roundMinutes: prefs.roundMinutes, handled: [] };
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
  now: number;
}

export type AutopilotAct =
  | { type: 'none' }
  | { type: 'round'; message: string; round: number }
  | { type: 'merge'; pr: PullRequest }
  | { type: 'green'; line: string }
  | { type: 'stop'; stop: AutopilotStop };

export interface Step {
  record: AutopilotRecord;
  act: AutopilotAct;
}

type Where = { host: HostKind; number: number };
const whereOf = (a: Where): string => requestNumber(hostTerms(a.host), a.number);
const NONE: AutopilotAct = { type: 'none' };

function stopped(record: AutopilotRecord, now: number, why: string, notify = true): Step {
  const stop = { at: now, why, notify };
  const { round: _round, ...rest } = record;
  return { record: { ...rest, stopped: stop }, act: { type: 'stop', stop } };
}

const failedNames = (pr: PullRequest): string[] => (pr.failedChecks ?? []).map((c) => c.name).sort();
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);

/** The message a round sends: what the cards' buttons send, for each reason, under one heading. */
export function roundMessage(a: Omit<RequestAttention, 'reasons'>, reasons: readonly ReasonDetail[], round: number, maxRounds: number): string {
  const parts = reasons.map((d) => fixMessage(a, d));
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
  if (record.stopped || !input.lookup || input.lookup.state !== 'ready') return { record, act: NONE };
  const pr = input.lookup.value.pullRequests.find((p) => p.number === record.number) ?? null;
  if (!pr) return { record, act: NONE };
  const where = whereOf({ host: input.lookup.value.host, number: pr.number });
  if (pr.state === 'merged') return stopped(record, now, `${where} was merged`, false);
  if (pr.state === 'closed') return stopped(record, now, `${where} was closed`, false);
  const head = pr.headSha ?? '';
  const moved = !!head && record.head?.sha !== head;
  if (moved) record = { ...record, head: { sha: head, at: now } };

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
  const green = pr.state === 'open' && pullRequestStatus(pr).tone === 'green';
  if (!green) return { record, act: NONE };
  if (record.merge) return { record, act: { type: 'merge', pr } };
  if (record.green === head) return { record, act: NONE };
  return { record: { ...record, green: head }, act: { type: 'green', line: `${where} is green: ready to merge` } };
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
  const merge = r.merge ? ', merges when green' : '';
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
  const merge = r.merge ? ' · merge' : '';
  if (r.waiting) return `Autopilot${merge} · waiting`;
  if (r.round) return `Autopilot${merge} · round ${r.rounds} of ${r.maxRounds}`;
  return `Autopilot${merge}`;
}

/**
 * The request pill's Autopilot menu: a switch for Autopilot, one for Merge when green (shown while it is
 * on), and what it is doing now. Turned on before the session has an open request, it waits for one.
 */
export function autopilotMenu(sessionId: string, record: AutopilotRecord | null | undefined): MenuItem[] {
  const on = isWanted(record);
  const items: MenuItem[] = [{ id: 'autopilot', label: 'Autopilot', heading: autopilotText(record), toggle: true, checked: on, action: { type: 'set-autopilot', sessionId, on: !on } }];
  if (on) items.push({ id: 'autopilot-merge', label: 'Merge when green', toggle: true, checked: record!.merge, action: { type: 'set-autopilot', sessionId, on: true, merge: !record!.merge } });
  return items;
}
