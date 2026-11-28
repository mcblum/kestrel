// How much of an agent account's plan is used, as the agent's own SDK or program reports it (issue 80;
// design doc, "Plan usage"). One shape for every agent: named windows, each with the share used and
// when it resets. Limits are the account's, not a session's: the server holds one copy per agent
// (plan-usage.ts), merged from what each session's agent reports and pushed to every window when what
// is shown changes. The words the composer's ring, its popup and Settings use are all here, so they
// agree. Pure.
//
// What each agent really reports (docs/spike-results.md, "Plan usage"):
// - Claude: a `rate_limit_event` on the stream as a turn runs (one window at a time, utilization 0-1,
//   reset in seconds), and the SDK's experimental /usage query (every window, 0-100, ISO resets), asked
//   once as a turn ends. Nothing for an API key or a cloud provider: no plan limits apply there.
// - Codex: `account/rateLimits/updated` as a turn runs (sparse, merged) and `account/rateLimits/read`
//   once when its app-server starts: a primary and a secondary window, percent used, reset in seconds.
// - OpenCode: no plan limits at all; cost and tokens per message only.
import { AGENT_LABEL, type Agent } from '../model.ts';

export interface LimitWindow {
  /** Stable within an agent: `five_hour`, `seven_day`, `primary`, `secondary`… What merging keys on. */
  id: string;
  /** What the agent's own app calls it: "5-hour", "Weekly", "Weekly (Opus)". */
  label: string;
  /** Share of the window used, 0 to 100; null when the agent named the window without a figure. */
  usedPercent: number | null;
  /** When it resets, ms since 1970; null when not said. */
  resetsAt: number | null;
  /** The agent said this window is used up (its requests are refused until it resets). */
  reached?: boolean;
  /** Where the agent's app lists it: lower first. */
  order: number;
}

export interface PlanUsage {
  windows: LimitWindow[];
  /** The plan as the agent names it ("max", "plus"), when it says. */
  plan?: string;
  /** When the agent last reported, ms since 1970. */
  at: number;
  /** The agent said no plan limits apply to this sign-in (an API key, a cloud provider). */
  noLimits?: boolean;
}

/** Every agent's last report this server has seen, by agent. An agent with none is absent. */
export type PlanUsageView = Partial<Record<Agent, PlanUsage>>;

/** Whether an agent reports its plan's limits at all. OpenCode does not (spike-results.md). */
export const REPORTS_LIMITS: Record<Agent, boolean> = { claude: true, codex: true, opencode: false };
/** Whether an agent reports what a turn cost in dollars. Codex reports tokens only. */
export const REPORTS_COST: Record<Agent, boolean> = { claude: true, codex: false, opencode: true };

/** From here a window reads as nearly used: the readout takes the warning treatment. */
export const NEARLY_USED = 80;

export type UsageLevel = 'ok' | 'near' | 'full';

const within = (n: number) => Math.min(100, Math.max(0, n));

/**
 * One report merged into the last: a window reported replaces the one of the same id, a window not in
 * this report is kept (Claude's event and Codex's notification each carry only some windows). Returns
 * a new value; neither argument is changed.
 */
export function mergePlanUsage(before: PlanUsage | null, update: PlanUsage): PlanUsage {
  if (!before || update.noLimits) return { ...update, windows: sortWindows(update.windows) };
  const byId = new Map(before.windows.map((w) => [w.id, w]));
  for (const w of update.windows) byId.set(w.id, { ...byId.get(w.id), ...w, usedPercent: w.usedPercent ?? byId.get(w.id)?.usedPercent ?? null, resetsAt: w.resetsAt ?? byId.get(w.id)?.resetsAt ?? null });
  const plan = update.plan ?? before.plan;
  return { windows: sortWindows([...byId.values()]), at: Math.max(before.at, update.at), ...(plan ? { plan } : {}) };
}

const sortWindows = (windows: LimitWindow[]) => [...windows].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

/** What a window shows: whole percent and reset to the minute. Two reports that show the same are not pushed again. */
const shownKey = (u: PlanUsage) =>
  JSON.stringify([u.noLimits ?? false, u.plan ?? '', u.windows.map((w) => [w.id, w.label, w.usedPercent === null ? null : Math.round(within(w.usedPercent)), w.resetsAt === null ? null : Math.round(w.resetsAt / 60_000), w.reached ?? false])]);

/** Whether two reports draw the same (the as-of time aside). */
export function sameShown(a: PlanUsage | null | undefined, b: PlanUsage | null | undefined): boolean {
  if (!a || !b) return a === b;
  return shownKey(a) === shownKey(b);
}

/** A window whose reset time has passed: what it said no longer holds, and nothing newer came. */
export const isPast = (w: LimitWindow, now: number): boolean => w.resetsAt !== null && w.resetsAt <= now;

/** The window closest to its limit now (used up first, then the highest share), or null when none has a figure. */
export function tightestWindow(usage: PlanUsage | null | undefined, now: number): LimitWindow | null {
  let best: LimitWindow | null = null;
  for (const w of usage?.windows ?? []) {
    if (isPast(w, now) || (w.usedPercent === null && !w.reached)) continue;
    const score = (x: LimitWindow) => (x.reached ? 1000 : within(x.usedPercent ?? 0));
    if (!best || score(w) > score(best)) best = w;
  }
  return best;
}

/** How close a window is to its limit, for the one warning treatment. */
export function levelOf(w: LimitWindow | null): UsageLevel {
  if (!w) return 'ok';
  if (w.reached || (w.usedPercent ?? 0) >= 100) return 'full';
  return (w.usedPercent ?? 0) >= NEARLY_USED ? 'near' : 'ok';
}

/** "42%", "<1%" for a sliver, "—" for no figure. */
export function percentText(w: LimitWindow): string {
  if (w.usedPercent === null) return w.reached ? '100%' : '—';
  const p = within(w.usedPercent);
  if (p > 0 && p < 1) return '<1%';
  return `${Math.round(p)}%`;
}

/** "resets in 25 min", "resets in 3 h 20 min", "resets in 4 d 6 h"; "reset since" once passed; '' when not said. */
export function resetText(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return '';
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  if (minutes <= 0) return 'reset since';
  if (minutes < 60) return `resets in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `resets in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  const days = Math.floor(hours / 24);
  return `resets in ${days} d${hours % 24 ? ` ${hours % 24} h` : ''}`;
}

/** One window as a line of the menu and of Settings: "5-hour · 42% used · resets in 3 h 20 min". */
export function windowText(w: LimitWindow, now: number): string {
  if (isPast(w, now)) return `${w.label} · reset since it was measured`;
  const used = w.reached ? 'used up' : w.usedPercent === null ? 'no figure' : `${percentText(w)} used`;
  const reset = resetText(w.resetsAt, now);
  return [w.label, used, reset].filter(Boolean).join(' · ');
}

export interface Readout {
  /** Its tooltip and accessible name, a whole sentence. */
  label: string;
  level: UsageLevel;
}

/** What the ring says about plan usage: its tightest window, or null when there is nothing to show (then the note says why). */
export function readout(agent: Agent, usage: PlanUsage | null | undefined, now: number): Readout | null {
  const w = tightestWindow(usage, now);
  if (!w) return null;
  const label = `${AGENT_LABEL[agent]} plan usage: ${windowText(w, now)}`;
  return { label, level: levelOf(w) };
}

/**
 * What is said in place of the windows when there are none to show. `elsewhere`: the session runs on
 * that computer, whose figures are not published to this one.
 */
export function planNote(agent: Agent, usage: PlanUsage | null | undefined, now: number, elsewhere?: string): string | null {
  const name = AGENT_LABEL[agent];
  if (elsewhere) return `${name}'s plan usage is reported on ${elsewhere}, where this session runs.`;
  if (!REPORTS_LIMITS[agent]) return `${name} does not report plan limits. Its cost and tokens are shown for each session.`;
  if (usage?.noLimits) return `${name} says no plan limits apply to this sign-in (an API key or a cloud provider).`;
  if (!usage || usage.windows.length === 0) return `${name} reports its plan usage as a turn runs. None reported since Kestrel started.`;
  if (!tightestWindow(usage, now)) return `Every ${name} window has reset since it was last measured. Measured again when a turn runs.`;
  return null;
}

/** "Reported at 14:05", from the last report. */
export function reportedText(usage: PlanUsage): string {
  return `Reported ${new Date(usage.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** The tokens a session's turns used, as the agent reported them: input (cached included) and output (reasoning included). */
export interface TurnTokens {
  input: number;
  output: number;
}

/** Two counts added; null stays null when neither has any. */
export function addTokens(a: TurnTokens | null | undefined, b: TurnTokens | null | undefined): TurnTokens | null {
  if (!a && !b) return null;
  return { input: (a?.input ?? 0) + (b?.input ?? 0), output: (a?.output ?? 0) + (b?.output ?? 0) };
}

/** A turn's tokens when they are real counts (none negative, not all zero), else undefined. */
export function realTokens(t: TurnTokens | null | undefined): TurnTokens | undefined {
  if (!t || !Number.isFinite(t.input) || !Number.isFinite(t.output) || t.input < 0 || t.output < 0 || t.input + t.output === 0) return undefined;
  return { input: t.input, output: t.output };
}

/** What a session's cost row says when the agent does not report cost. */
export const costNotReported = (agent: Agent): string => `${AGENT_LABEL[agent]} does not report cost`;

/** A view as the window holds it: anything that is not a report is dropped. */
export function asPlanUsageView(raw: unknown): PlanUsageView {
  const out: PlanUsageView = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const agent of Object.keys(AGENT_LABEL) as Agent[]) {
    const u = (raw as Record<string, unknown>)[agent] as PlanUsage | undefined;
    if (u && typeof u === 'object' && Array.isArray(u.windows) && typeof u.at === 'number') out[agent] = u;
  }
  return out;
}
