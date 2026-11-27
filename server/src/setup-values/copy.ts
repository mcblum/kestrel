// The asking computer's side of copying set-up values (docs/designs/onboarding.md, 19.4 and 19.5). Only
// the Copy values button's route calls this: no section run, no Kestrel tool, no phone. The line and the
// names come from the server's own list (never the page); the other computer is asked `setup.values`
// over the sealed desk-to-desk channel and its person says Allow there; the answer is checked and each
// value written at once where a typed one would go:
//
//   - an MCP server: Kestrel's own list, its definition added first by the line's own step when it is not
//     there yet, then each value into a secret slot that has none here (`McpServerStore.fillValues`);
//   - a Claude settings file: the line's own step, with the values as its input, as a typed value is.
//
// What it answers, and so what the page, a toast, a run's state or anything else sees, is names only.
// Nothing here logs.
import { Refused } from '../refused.ts';
import { blankKey } from '../setup-actions/file-steps.ts';
import type { RunReport } from '../setup-actions/steps.ts';
import { NEVER_REMOTE, type ConnectOp } from '../shared/connect-ops.ts';
import { listNameOf } from '../shared/mcp-servers.ts';
import type { SetupList } from '../shared/setup-list.ts';
import { checkValuesAnswer, copiedText, copyStepOf, olderText, SETUP_VALUES_OP, stepText, VALUE_REQUEST_TTL_MS, VALUE_WORDS } from '../shared/setup-values.ts';

/** What another computer said: its answer, its refusal (`reached`), or that it could not be reached. */
type Answer = { ok: true; result: unknown } | { ok: false; reached: boolean; reason: string };

export interface CopyDeps {
  /** The list as the page has it, read again now (SetupSteps.list). */
  list(): Promise<SetupList>;
  /** One request of the closed list to another computer (RemoteSessions.ask). */
  ask(machine: string, op: ConnectOp, args: Record<string, unknown>, opts: { timeoutMs: number }): Promise<Answer>;
  /** A line's own step, as its Run does (SetupSteps.runLine): the input is never kept. */
  runLine(id: string, input?: Record<string, string>): Promise<RunReport>;
  /** Kestrel's own MCP list; null where there is none. */
  mcp: {
    has(name: string): Promise<boolean>;
    fill(name: string, values: Readonly<Record<string, string>>): Promise<string[]>;
    clear(name: string, keys: readonly string[]): Promise<void>;
  } | null;
  /** Keeps an Undo and answers its token (SetupSteps' own, so the page's Undo route takes it). */
  keepUndo(undo: () => Promise<void>): string;
  newId(): string;
}

/** What a copy did, by name, for the page and its toast. */
export interface CopyReport {
  from: string;
  step: string;
  copied: string[];
  notThere: string[];
  said: string;
  undo: string | null;
}

/** How long the asking computer waits: the other's two minutes, and a little for the channel. */
export const COPY_WAIT_MS = VALUE_REQUEST_TTL_MS + 10_000;

/** Asks the other computer, and refuses in words the person can act on when it did not give values. */
async function askFor(deps: CopyDeps, machine: { id: string; name: string }, line: string, names: string[]): Promise<unknown> {
  const requestId = deps.newId();
  const answer = await deps.ask(machine.id, SETUP_VALUES_OP, { requestId, line, names }, { timeoutMs: COPY_WAIT_MS });
  if (answer.ok) return answer.result;
  if (!answer.reached) {
    // It may still show the request: take it back, and do not wait for that.
    void deps.ask(machine.id, 'setup.values.withdraw', { requestId }, { timeoutMs: 5_000 }).catch(() => undefined);
    throw new Refused(VALUE_WORDS.unreachable(machine.name));
  }
  // An older Kestrel does not know the operation and answers with its own words for anything under `setup`.
  if (answer.reason === NEVER_REMOTE.setup) throw new Refused(olderText(machine.name));
  throw new Refused(answer.reason);
}

const ranWrong = (report: RunReport): boolean => report.failed.length > 0 || report.waiting.length > 0 || report.done.length === 0;

/** Copies a line's missing values from one computer that has them. Refused with the reason; never a value in it. */
export async function copyValues(deps: CopyDeps, lineId: string, machineId: string): Promise<CopyReport> {
  const list = await deps.list();
  const line = list.lines.find((l) => l.id === lineId);
  const step = copyStepOf(lineId);
  if (!line || !step) throw new Refused('That step is not on this computer\'s list any more. Check again.');
  if (line.dismissed) throw new Refused(`"${line.title}" is dismissed. Restore it first.`);
  const offer = line.copy?.offers.find((o) => o.id === machineId);
  if (!offer) throw new Refused(line.copy ? `That computer has none of ${line.title}'s missing values.` : `${line.title} has no missing values to copy.`);
  if (offer.older) throw new Refused(olderText(offer.name));
  const raw = await askFor(deps, offer, lineId, offer.names);
  const checked = checkValuesAnswer(offer.names, raw);
  if (!checked.ok) throw new Refused(checked.problem);
  const { values, notThere } = checked.answer;
  const named = Object.keys(values);
  const where = step.kind === 'mcp' ? step.server : step.path;
  if (named.length === 0) return { from: offer.name, step: stepText(lineId), copied: [], notThere, said: copiedText([], notThere, offer.name, where), undo: null };

  let copied: string[];
  let undo: string | null;
  if (step.kind === 'mcp') {
    if (!deps.mcp) throw new Refused('This copy of Kestrel keeps no MCP servers of its own, so there is nowhere to put the values.');
    // As Kestrel's list names it: the other computer's name where the list allows it (shared/mcp-servers.ts).
    const server = listNameOf(step.server);
    const had = await deps.mcp.has(server);
    // Not in Kestrel's list yet: the line's own step adds it, as its button would, then the values go in.
    const added = had ? null : await deps.runLine(lineId);
    if (added && ranWrong(added)) throw new Refused(`${step.server} could not be added to Kestrel's MCP servers, so nothing was copied. Its line says why.`);
    copied = await deps.mcp.fill(server, values);
    const mcp = deps.mcp;
    undo = added ? added.undo : copied.length > 0 ? deps.keepUndo(() => mcp.clear(server, copied)) : null;
  } else {
    // The settings file's own step writes it, with the values as its typed input (file-steps.ts).
    const input = Object.fromEntries(named.map((name) => [blankKey({ path: step.path, at: ['env', name] }), values[name]!]));
    const report = await deps.runLine(lineId, input);
    if (ranWrong(report)) throw new Refused(`${step.path} was not written, so nothing was copied. Its line says why.`);
    copied = named;
    undo = report.undo;
  }
  return { from: offer.name, step: stepText(lineId), copied, notThere, said: copiedText(copied, notThere, offer.name, where), undo };
}
