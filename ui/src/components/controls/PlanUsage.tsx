// The agent's plan windows in the composer popup and Settings → Usage.
import type { Agent } from '@kestrel/server/model';
import { SELECTABLE_AGENTS } from '@kestrel/server/model';
import { isPast, levelOf, planNote, reportedText, windowText, type LimitWindow, type PlanUsage } from '@kestrel/server/plan-usage';
import { AGENT_LABEL } from '../../labels.ts';
import { useApp } from '../../store.ts';
import { useMinuteNow } from '../../useNow.ts';

function WindowRow({ w, now }: { w: LimitWindow; now: number }) {
  const past = isPast(w, now);
  const share = past || w.usedPercent === null ? (w.reached && !past ? 100 : 0) : Math.min(100, Math.max(0, w.usedPercent));
  return (
    <li className={`plan-window ${past ? 'past' : levelOf(w)}`}>
      <span className="plan-window-text">{windowText(w, now)}</span>
      <span className="plan-bar" aria-hidden>
        <span className="plan-bar-fill" style={{ width: `${share}%` }} />
      </span>
    </li>
  );
}

/** One agent's plan: its windows, or the words said in their place. `elsewhere`: the computer the session runs on. */
export function AgentPlanUsage({ agent, usage, elsewhere, heading = AGENT_LABEL[agent] }: { agent: Agent; usage: PlanUsage | undefined; elsewhere?: string; heading?: string }) {
  const now = useMinuteNow();
  const note = planNote(agent, usage, now, elsewhere);
  const windows = elsewhere ? [] : (usage?.windows ?? []);
  return (
    <div className="plan-usage">
      <div className="plan-usage-head">
        <strong>{heading}</strong>
        {!elsewhere && usage?.plan && <span className="plan-usage-plan">{usage.plan}</span>}
      </div>
      {windows.length > 0 && (
        <ul className="plan-windows">
          {windows.map((w) => (
            <WindowRow key={w.id} w={w} now={now} />
          ))}
        </ul>
      )}
      {note && <p className="plan-usage-note">{note}</p>}
      {!elsewhere && usage && windows.length > 0 && <div className="plan-usage-foot">{reportedText(usage)}</div>}
    </div>
  );
}

/** Every agent's plan at once, for Settings → Usage. */
export function PlanUsageOverview() {
  const usage = useApp((s) => s.planUsage);
  return (
    <div className="plan-overview">
      {SELECTABLE_AGENTS.map((agent) => (
        <AgentPlanUsage key={agent} agent={agent} usage={usage[agent]} />
      ))}
    </div>
  );
}
