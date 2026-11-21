// The model with its effort beside it ("Opus 5.5  Medium", the effort muted). Opens the model menu
// (shared/model-choice.ts): the current models numbered 1 to 9, Effort and More models submenus,
// and the fast-mode switch, each only when the agent says the model has it.
import { useRef } from 'react';
import type { ModelOption } from '@kestrel/server/agent-types';
import { modelLabel, optionFor, pickFromMenu, shownEffort, type ModelSettings } from '@kestrel/server/model-choice';
import { shownModelMenu } from '@kestrel/server/model-picker';
import type { MenuItem } from '@kestrel/server/menu';
import { contextMenu } from '../../menuState.ts';
import { menuOpenFrom, openFrom } from './anchor.ts';

interface Props {
  models: readonly ModelOption[];
  value: ModelSettings;
  /** A running session: a change applies from the next message. */
  running: boolean;
  onChange: (next: ModelSettings) => void;
  /** Shown in place of the model while none has been chosen: the menu then ticks nothing, and any pick counts. */
  placeholder?: string;
}

/** The menu with no row ticked: nothing has been chosen yet, so the default must not look chosen. */
const unticked = (items: readonly MenuItem[]): MenuItem[] => items.map((item) => ({ ...item, ...(item.toggle ? {} : { checked: false }), ...(item.children ? { children: unticked(item.children) } : {}) }));

function tooltip(models: readonly ModelOption[], value: ModelSettings, running: boolean): string {
  const option = optionFor(models, value.model);
  const parts = [`Model: ${option?.description ?? modelLabel(models, value.model)}`];
  if (option?.efforts?.length) parts.push('Effort: how much it thinks before answering');
  if (option?.fast && value.fast) parts.push('Fast mode is on');
  if (running) parts.push('Changes apply from your next message');
  return parts.join('. ');
}

export function ModelControl({ models, value, running, onChange, placeholder }: Props) {
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const effort = shownEffort(models, value);
  const fast = optionFor(models, value.model)?.fast && value.fast;

  const open = () => {
    let latest = value;
    openFrom(button.current!, placeholder ? unticked(shownModelMenu(models, latest)) : shownModelMenu(models, latest), (item) => {
      const next = pickFromMenu(models, latest, item.id);
      // With nothing chosen yet, picking the row the default resolves to is still a choice.
      if (next === latest && !placeholder) return;
      latest = next;
      onChange(next);
      // The switch leaves the menu open: show it flipped.
      if (item.toggle) contextMenu.replace(shownModelMenu(models, next));
    });
  };

  return (
    <span className="ctl ctl-model">
      <button
        ref={button}
        type="button"
        className="ctl-button"
        aria-haspopup="menu"
        title={placeholder ? 'Choose the model this preset uses' : tooltip(models, value, running)}
        onPointerDown={() => void (wasOpen.current = menuOpenFrom(button.current))}
        onClick={() => (wasOpen.current ? void (wasOpen.current = false) : open())}
      >
        {placeholder ? (
          <span className="ctl-effort">{placeholder}</span>
        ) : (
          <>
            <span className="ctl-model-name">{modelLabel(models, value.model)}</span>
            {effort && <span className="ctl-effort">{effort}</span>}
            {fast && <span className="ctl-effort">Fast</span>}
          </>
        )}
      </button>
    </span>
  );
}
