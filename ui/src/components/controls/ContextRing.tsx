// One composer popup for the agent's plan and the session's spend and context window.
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Agent } from '@kestrel/server/model';
import { contextNote, percentLabel, shownRows, tokenCount, usedFraction, type ContextUsage } from '@kestrel/server/context-usage';
import { NEARLY_USED, planNote, readout } from '@kestrel/server/plan-usage';
import { spendText } from '@kestrel/server/details';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../../data/resources.ts';
import { AGENT_LABEL } from '../../labels.ts';
import { actions, useApp } from '../../store.ts';
import { useMinuteNow } from '../../useNow.ts';
import { useUsage } from '../details/sources.ts';
import { Popup } from '../Popup.tsx';
import { AgentPlanUsage } from './PlanUsage.tsx';

/** GET /api/sessions/:id/context: how full the window is, or, when it cannot be known now, the words shown in its place. */
interface Asked {
  usage: ContextUsage | null;
  note: string | null;
}
const asContextUsage = (raw: unknown): Sourced<Asked> => {
  const answer = (raw ?? {}) as { usage?: ContextUsage | null; note?: string };
  return ready({ usage: answer.usage ?? null, note: typeof answer.note === 'string' ? answer.note : null });
};

/** Why Compact cannot be pressed now, or null: the server refuses the same, whatever this shows. */
function compactBlocked(state: string | undefined): string | null {
  if (state === 'running') return 'The agent is working. Compact once this turn ends.';
  if (state === 'attention') return 'Answer the card first, then compact.';
  return null;
}
const R = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * R;

function Ring({ fraction }: { fraction: number }) {
  return (
    <svg className="ctx-ring" viewBox="0 0 14 14" aria-hidden>
      <circle className="ctx-track" cx="7" cy="7" r={R} />
      {fraction > 0 && <circle className="ctx-fill" cx="7" cy="7" r={R} strokeDasharray={`${Math.max(0.6, fraction * CIRCUMFERENCE)} ${CIRCUMFERENCE}`} transform="rotate(-90 7 7)" />}
    </svg>
  );
}

function Breakdown({ usage }: { usage: ContextUsage }) {
  const { inWindow, deferred } = shownRows(usage);
  return (
    <>
      {inWindow.length > 0 && (
        <dl className="ctx-rows">
          {inWindow.map((r) => (
            <div key={r.name} className={`ctx-row ${r.kind}`}>
              <dt>{r.name}</dt>
              <dd>{tokenCount(r.tokens)}</dd>
            </div>
          ))}
        </dl>
      )}
      {deferred.length > 0 && (
        <>
          <div className="ctx-sub" title="Loaded only when the agent needs them, so they are not in the window">Not in the window</div>
          <dl className="ctx-rows">
            {deferred.map((r) => (
              <div key={r.name} className="ctx-row deferred">
                <dt>{r.name}</dt>
                <dd>{tokenCount(r.tokens)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <div className="ctx-foot">
        {usage.model} · measured {new Date(usage.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </div>
    </>
  );
}

function ContextDetails({ usage, summary }: { usage: ContextUsage; summary: string }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return (
    <>
      <button
        type="button"
        className="ctx-disclosure"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight aria-hidden />
        <span>Context window</span>
        <span className="ctx-total">{summary}</span>
      </button>
      <div id={detailsId} className="ctx-details" hidden={!expanded}>
        {expanded && <Breakdown usage={usage} />}
      </div>
    </>
  );
}

/** The tokens and cost the agent reported for this session. */
function SessionSpend({ agent, sessionId }: { agent: Agent; sessionId: string }) {
  const updatedAt = useApp((s) => s.sessionsById.get(sessionId)?.updatedAt ?? 0);
  const usage = useUsage(sessionId, String(updatedAt)).value;
  const spend = spendText(agent, usage.state === 'ready' ? usage.value : null);
  return (
    <div className="ctx-section">
      <div className="ctx-heading">This session</div>
      <dl className="ctx-rows">
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
    </div>
  );
}

interface Props {
  agent: Agent;
  sessionId?: string;
  reportsContext: boolean;
  /** The computer that runs the session, when its plan usage is reported there. */
  elsewhere?: string;
}

export function ContextRing({ agent, sessionId, reportsContext, elsewhere }: Props) {
  const live = useApp((s) => sessionId ? s.live.get(sessionId)?.context ?? null : null);
  const state = useApp((s) => sessionId ? s.sessionsById.get(sessionId)?.state : undefined);
  const plan = useApp((s) => elsewhere ? undefined : s.planUsage[agent]);
  const asked = useResource(sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/context` : null, asContextUsage).value;
  const now = useMinuteNow();
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const usage = live ?? (asked.state === 'ready' ? asked.value.usage : null);
  const agentLabel = AGENT_LABEL[agent];
  const pending = !!sessionId && asked.state === 'loading';
  const note = asked.state === 'ready' ? asked.value.note : asked.state === 'unavailable' ? asked.reason : null;
  const contextStatus = pending ? 'Asking the agent…' : note ?? contextNote({
    reports: reportsContext, agentLabel, started: !!sessionId, working: state === 'running',
  });
  const blocked = compactBlocked(state);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!host.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const fraction = usage ? usedFraction(usage) : 0;
  const shown = readout(agent, plan, now);
  const level = fraction >= 1 || shown?.level === 'full' ? 'full' : fraction * 100 >= NEARLY_USED || shown?.level === 'near' ? 'near' : 'ok';
  const summary = usage ? `${tokenCount(usage.usedTokens)} of ${tokenCount(usage.windowTokens)} tokens · ${percentLabel(usage)}` : null;
  const planLabel = shown?.label ?? planNote(agent, plan, now, elsewhere) ?? `${agentLabel} plan usage`;
  const label = `${planLabel}\nContext window: ${summary ?? contextStatus}`;

  return (
    <span className="ctl ctl-context" ref={host}>
      <button
        ref={button}
        type="button"
        className={`ctl-button ctx-button ${level}`}
        title={label}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <Ring fraction={fraction} />
      </button>
      {open && (
        <Popup anchor={button} side="above" align="end" gap={6} className="ctx-pop" role="dialog" aria-label="Usage and context window">
          <AgentPlanUsage agent={agent} usage={plan} elsewhere={elsewhere} heading={`${agentLabel} plan usage`} />
          {sessionId && !elsewhere && <SessionSpend agent={agent} sessionId={sessionId} />}
          <div className="ctx-section">
            {usage && summary ? <ContextDetails usage={usage} summary={summary} /> : (
              <>
                <div className="ctx-heading">Context window</div>
                <p className="ctx-none">{contextStatus}</p>
              </>
            )}
            {sessionId && (reportsContext || usage) && (
              <div className="ctx-actions">
                <button
                  type="button"
                  className="secondary-button small"
                  disabled={blocked !== null}
                  onClick={() => {
                    setOpen(false);
                    button.current?.focus();
                    void actions.compact(sessionId);
                  }}
                >
                  Compact conversation
                </button>
                {blocked && <span className="ctx-why">{blocked}</span>}
              </div>
            )}
          </div>
        </Popup>
      )}
    </span>
  );
}
