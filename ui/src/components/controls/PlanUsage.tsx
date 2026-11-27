// Plan usage, inline (issue 80): how much of each agent account's plan is used, as the agent reports it
// (server/src/shared/plan-usage.ts). One block draws an agent's windows; it is used in two places: the
// readout under the message box (the open session's agent: its tightest window, opening a menu with every
// window and the session's context, tokens and cost) and Settings → Agent setup (all three agents). Grey
// chrome: a bar is neutral, and takes the warning colour only when a window is nearly used, the error
// colour when it is used up. Every word comes from the shared functions, so the readout and the menu agree.
import { useEffect, useRef, useState } from 'react';
import type { Agent } from '@kestrel/server/model';
import { SELECTABLE_AGENTS } from '@kestrel/server/model';
import { isPast, levelOf, planNote, readout, reportedText, windowText, type LimitWindow, type PlanUsage } from '@kestrel/server/plan-usage';
import { percentLabel, tokenCount } from '@kestrel/server/context-usage';
import { spendText } from '@kestrel/server/details';
import { AGENT_LABEL } from '../../labels.ts';
import { useApp } from '../../store.ts';
import { useMinuteNow } from '../../useNow.ts';
import { useUsage } from '../details/sources.ts';
import { Popup } from '../Popup.tsx';

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
export function AgentPlanUsage({ agent, usage, elsewhere, heading = true }: { agent: Agent; usage: PlanUsage | undefined; elsewhere?: string; heading?: boolean }) {
  const now = useMinuteNow();
  const note = planNote(agent, usage, now, elsewhere);
  const windows = elsewhere ? [] : (usage?.windows ?? []);
  return (
    <div className="plan-usage">
      {heading && (
        <div className="plan-usage-head">
          <strong>{AGENT_LABEL[agent]}</strong>
          {!elsewhere && usage?.plan && <span className="plan-usage-plan">{usage.plan}</span>}
        </div>
      )}
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

/** The session's own figures: how full its context window is, and the tokens and cost its agent reported. */
function SessionSpend({ agent, sessionId }: { agent: Agent; sessionId: string }) {
  const context = useApp((s) => s.live.get(sessionId)?.context ?? null);
  const updatedAt = useApp((s) => s.sessionsById.get(sessionId)?.updatedAt ?? 0);
  const usage = useUsage(sessionId, String(updatedAt)).value;
  const spend = spendText(agent, usage.state === 'ready' ? usage.value : null);
  return (
    <dl className="ctx-rows plan-session">
      {context && (
        <div className="ctx-row">
          <dt>Context</dt>
          <dd>
            {tokenCount(context.usedTokens)} of {tokenCount(context.windowTokens)} · {percentLabel(context)}
          </dd>
        </div>
      )}
      {spend.tokens && (
        <div className="ctx-row">
          <dt>Tokens</dt>
          <dd>{spend.tokens}</dd>
        </div>
      )}
      <div className="ctx-row">
        <dt>Cost</dt>
        <dd>{spend.cost}</dd>
      </div>
    </dl>
  );
}

interface ReadoutProps {
  agent: Agent;
  /** The open session, for its own figures; none in a new session's box. */
  sessionId?: string;
  /** The session runs on another computer: its name. Plan figures there are not published to this one. */
  elsewhere?: string;
}

/** The compact readout under the message box: the tightest window's share, opening every window and the session's figures. */
export function PlanUsageReadout({ agent, sessionId, elsewhere }: ReadoutProps) {
  const usage = useApp((s) => s.planUsage[agent]);
  const now = useMinuteNow();
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const shown = elsewhere ? null : readout(agent, usage, now);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !host.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setOpen(false), button.current?.focus());
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const label = shown?.label ?? `${AGENT_LABEL[agent]} usage`;
  return (
    <span className="ctl ctl-usage" ref={host}>
      <button ref={button} type="button" className={`ctl-button usage-button ${shown?.level ?? 'none'}`} title={label} aria-label={label} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        {shown?.text ?? 'Usage'}
      </button>
      {open && (
        <Popup anchor={button} side="above" gap={6} className="ctx-pop plan-pop" role="dialog" aria-label={`${AGENT_LABEL[agent]} usage`}>
          <div className="ctx-title">{AGENT_LABEL[agent]} plan usage</div>
          <AgentPlanUsage agent={agent} usage={usage} elsewhere={elsewhere} heading={false} />
          {sessionId && !elsewhere && (
            <>
              <div className="ctx-sub">This session</div>
              <SessionSpend agent={agent} sessionId={sessionId} />
            </>
          )}
        </Popup>
      )}
    </span>
  );
}

/** Every agent's plan at once, for Settings → Agent setup. */
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
