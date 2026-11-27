// The one copy of each agent account's plan usage this server holds (issue 80; shared/plan-usage.ts).
// Filled from what sessions' agents report (the `limits` event), merged, and pushed whole to every window
// only when what a window would draw changed, or when the copy's as-of time has fallen well behind: a
// burst of reports during a turn is at most one push, and none when the figures stand. Nothing here asks
// an agent, polls, or writes anywhere: kept in memory, a restart starts empty.
import type { Agent } from './model.ts';
import { mergePlanUsage, sameShown, type PlanUsage, type PlanUsageView } from './shared/plan-usage.ts';

/** An unchanged report still moves the pushed as-of time when the last push is this old, so "Reported 14:05" does not mislead. */
export const AS_OF_REFRESH_MS = 10 * 60_000;

export class PlanUsageStore {
  private current: PlanUsageView = {};
  private readonly listeners = new Set<(view: PlanUsageView) => void>();

  /** Every agent's last report, as pushed. Unchanged agents keep their identity. */
  view(): PlanUsageView {
    return this.current;
  }

  /** One report from an agent. True when it changed what is pushed (and listeners were told). */
  note(agent: Agent, update: PlanUsage): boolean {
    const before = this.current[agent] ?? null;
    const next = mergePlanUsage(before, update);
    if (before && sameShown(before, next) && next.at - before.at < AS_OF_REFRESH_MS) return false;
    this.current = { ...this.current, [agent]: next };
    for (const listener of this.listeners) listener(this.current);
    return true;
  }

  onChange(listener: (view: PlanUsageView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
