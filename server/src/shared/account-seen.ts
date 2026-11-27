// What was seen, for the whole account (docs/designs/account-sessions.md, "What was seen, as built"; Matt,
// 2026-11-26: "the read state should just be the read state for every device"). Pure.
//
// Each computer holds one sealed record in the list `seen`: the marks made on it (in a window, or by a phone of
// the account through it). A mark is a pair, what the session's activity was when it was marked (`at`, as
// shared/unread.ts keeps it; 0 for marked unread by hand) and when the mark was made (`by`, the clock of the
// computer that made it). Every computer merges every record it has, its own included, per session: the later
// mark wins. So two computers marking different sessions at the same moment both win, marking unread travels
// as a mark like any other, and no write can lose another's, as nobody writes over a record but its own.
import type { Machine } from './machines.ts';
import type { Seen } from './unread.ts';

/** `[at, by]`: the session's activity when it was marked (0: marked unread), and when the mark was made. */
export type SeenMark = readonly [at: number, by: number];
/** Session id -> its mark. */
export type SeenMarks = Readonly<Record<string, SeenMark>>;

/** The list every computer's record is in, before tagging. */
export const SEEN_LIST = 'seen';
/** What a computer's record is filed under, before tagging. */
export const seenLabel = (machineId: string): string => `seen|${machineId}`;

/** As many sessions as a record carries; past it, the oldest marks go. About 70 bytes each. */
export const MAX_MARKS = 5000;
const MAX_ID = 200;

/** The later of two marks; on the same moment, the one that says more was read, so a tie never lights a dot. */
export function laterMark(a: SeenMark | undefined, b: SeenMark | undefined): SeenMark | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a[1] !== b[1]) return a[1] > b[1] ? a : b;
  return a[0] >= b[0] ? a : b;
}

/** Every record as one: per session, the later mark. */
export function mergeMarks(records: readonly SeenMarks[]): SeenMarks {
  const out: Record<string, SeenMark> = {};
  for (const record of records) for (const [id, mark] of Object.entries(record)) out[id] = laterMark(out[id], mark)!;
  return out;
}

/** What the window reads (shared/unread.ts): each session's activity when it was last marked. */
export function seenOfMarks(marks: SeenMarks): Seen {
  return Object.fromEntries(Object.entries(marks).map(([id, [at]]) => [id, at]));
}

/** Only the sessions in `ids`, and at most `MAX_MARKS`, the newest kept. Returns the same object when nothing goes. */
export function pruneMarks(marks: SeenMarks, ids: ReadonlySet<string>): SeenMarks {
  const kept = Object.entries(marks).filter(([id]) => ids.has(id));
  if (kept.length === Object.keys(marks).length && kept.length <= MAX_MARKS) return marks;
  return Object.fromEntries(kept.sort((a, b) => b[1][1] - a[1][1]).slice(0, MAX_MARKS));
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Stored or sent marks, kept only where they are an id with two numbers; at most `MAX_MARKS`. */
export function asMarks(value: unknown): SeenMarks {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const kept = Object.entries(value).filter((e): e is [string, [number, number]] => {
    const [id, mark] = e;
    return id.length > 0 && id.length < MAX_ID && Array.isArray(mark) && mark.length === 2 && finite(mark[0]) && finite(mark[1]);
  });
  return Object.fromEntries(kept.sort((a, b) => b[1][1] - a[1][1]).slice(0, MAX_MARKS).map(([id, [at, by]]) => [id, [at, by] as const]));
}

/** A computer's record as it is sealed: its marks and the computer, nothing else. */
export interface SeenRecord {
  v: 1;
  kind: 'seen';
  machine: Machine;
  marks: SeenMarks;
}

export const seenRecordOf = (machine: Machine, marks: SeenMarks): SeenRecord => ({ v: 1, kind: 'seen', machine: { id: machine.id, name: machine.name }, marks });

/** A record as opened, or null when it is not one. Which machine may write it, and under which id, are the caller's to check. */
export function asSeenRecord(raw: unknown): { machineId: string; marks: SeenMarks } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const machine = typeof r.machine === 'object' && r.machine !== null ? (r.machine as Record<string, unknown>) : null;
  const machineId = machine && typeof machine.id === 'string' && machine.id.length > 0 && machine.id.length < MAX_ID ? machine.id : null;
  if (r.kind !== 'seen' || !machineId) return null;
  return { machineId, marks: asMarks(r.marks) };
}
