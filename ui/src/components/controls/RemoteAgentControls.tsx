// The agent and model of a new session that will run on another computer (issue 52): what that computer said it can
// start (`session.startChoices`: its providers, each with its own model menu by name, and the agents it cannot start
// with why). Effort and fast mode are not offered: that computer starts the agent with the ones it remembers for it,
// fitted to the model, as a phone's start does. While it has not answered, the box's own agent stands and the model
// is that computer's default.
import { useEffect, useRef } from 'react';
import type { Agent } from '@kestrel/server/model';
import type { MenuItem } from '@kestrel/server/menu';
import type { ComputerStatus } from '@kestrel/server/start-computer';
import { AGENT_LABEL } from '../../labels.ts';
import { menuOpenFrom, openFrom } from './anchor.ts';

interface Props {
  /** Which of the two this draws: the agent sits first in the row, the model on the right, as here. */
  part: 'agent' | 'model';
  agent: Agent;
  model: string;
  status: ComputerStatus;
  onChange: (next: { agent: Agent; model: string }) => void;
}

/** A button that opens a menu built when it is pressed. */
function MenuButton({ className, label, title, items, onPick }: { className: string; label: string; title: string; items: () => MenuItem[]; onPick: (item: MenuItem) => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  return (
    <span className={`ctl ${className}`}>
      <button
        ref={button}
        type="button"
        className="ctl-button"
        aria-haspopup="menu"
        title={title}
        onPointerDown={() => void (wasOpen.current = menuOpenFrom(button.current))}
        onClick={() => {
          if (wasOpen.current) return void (wasOpen.current = false);
          openFrom(button.current!, items(), onPick);
        }}
      >
        <span className="ctl-label">{label}</span>
      </button>
    </span>
  );
}

export function RemoteAgentControls({ part, agent, model, status, onChange }: Props) {
  const choices = status.state === 'ready' ? status.choices : null;
  const provider = choices?.providers.find((p) => p.agent === agent);
  // That computer cannot start this agent, or does not offer this model: its own first choice instead.
  const fallback = choices && choices.providers.length > 0 && (!provider || !provider.models.some((m) => m.id === model)) ? (provider ?? choices.providers.find((p) => p.agent === choices.start.agent) ?? choices.providers[0]!) : null;
  useEffect(() => {
    if (part === 'agent' && fallback) onChange({ agent: fallback.agent, model: fallback.default });
  }, [fallback?.agent, fallback?.default]); // eslint-disable-line react-hooks/exhaustive-deps

  const where = choices?.here ?? 'that computer';
  const agentItems = (): MenuItem[] => [
    ...(choices?.providers ?? []).map((p) => ({ id: p.agent, label: p.name, checked: p.agent === agent })),
    // One that cannot start there is dimmed and says nothing more (Matt, 2026-11-26): why is in that computer's Settings.
    ...(choices?.missing ?? []).map((m) => ({ id: m.agent, label: m.name, disabled: true })),
  ];
  const modelItems = (): MenuItem[] => {
    const models = provider?.models ?? [{ id: '', name: 'Default' }];
    const row = (m: { id: string; name: string }): MenuItem => ({ id: `model:${m.id}`, label: m.name, checked: m.id === model });
    const more = models.filter((m) => m.more);
    return [...models.filter((m) => !m.more).map(row), ...(more.length > 0 ? [{ id: 'more', label: 'More models', children: more.map(row) }] : [])];
  };
  const modelName = provider?.models.find((m) => m.id === model)?.name ?? 'Default';
  if (part === 'agent') {
    return (
      <MenuButton className={`ctl-provider provider-${agent}`} label={AGENT_LABEL[agent]} title={`Agent: ${AGENT_LABEL[agent]}. Who works on this session, as ${where} offers them`} items={agentItems} onPick={(item) => {
        const next = choices?.providers.find((p) => p.agent === item.id);
        if (next && next.agent !== agent) onChange({ agent: next.agent, model: next.default });
      }} />
    );
  }
  return (
      <MenuButton className="ctl-model" label={modelName} title={`Model: ${modelName}, as ${where} offers them. Effort and fast mode are what ${where} remembers for this agent`} items={modelItems} onPick={(item) => {
        if (item.id.startsWith('model:')) onChange({ agent, model: item.id.slice('model:'.length) });
      }} />
  );
}
