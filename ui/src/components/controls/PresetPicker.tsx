// One box of a row in Who does what (WhoDoesWhatSetting.tsx): the preset chosen there, on two lines
// (its name, then its agent, model and effort), or what the empty box means. Its menu lists the
// presets on the same two lines, so nobody has to remember what a name stands for, then Remove and
// Create preset (TwoLineMenu.tsx).
import { Plus, X } from 'lucide-react';
import type { ModelPreset } from '@kestrel/server/who-does-what';
import { TwoLineMenu, type MenuChoice } from './TwoLineMenu.tsx';

interface Props {
  id?: string;
  /** What the box is called to a screen reader: "Design preset 1". */
  label: string;
  /** The preset chosen here; null for the empty box. */
  value: ModelPreset | null;
  /** The presets offered: every one not already on the row, and this box's own. */
  options: readonly ModelPreset[];
  /** What the empty box says ("Add another Design preset", "Nobody"). */
  empty: string;
  describe: (preset: ModelPreset) => string;
  onPick: (id: string) => void;
  /** Take this box's preset off the row; absent for the empty box. */
  onRemove?: () => void;
  /** Make a new preset and put it here; absent when there is no room for another. */
  onCreate?: () => void;
  /**
   * The row's first box only: the choice of nobody ("Use the session’s current model"), first in
   * the menu and ticked while the row is empty, so there is always a way back to it. Choosing it
   * empties the row.
   */
  none?: { label: string; onPick: () => void };
}

export function PresetPicker({ id, label, value, options, empty, describe, onPick, onRemove, onCreate, none }: Props) {
  const choices: MenuChoice[] = [
    ...(none ? [{ key: 'none', name: none.label, checked: value === null, run: () => value !== null && none.onPick() }] : []),
    ...options.map((preset, at): MenuChoice => ({ key: preset.id, name: preset.name, detail: describe(preset), checked: preset.id === value?.id, separated: none !== undefined && at === 0, run: () => preset.id !== value?.id && onPick(preset.id) })),
    ...(onRemove && !none ? [{ key: 'remove', name: 'Remove from this role', icon: <X aria-hidden />, separated: options.length > 0, run: onRemove }] : []),
    ...(onCreate ? [{ key: 'create', name: 'Create preset…', icon: <Plus aria-hidden />, separated: (!onRemove || none !== undefined) && options.length > 0, run: onCreate }] : []),
  ];
  return <TwoLineMenu id={id} label={label} name={value ? value.name : empty} detail={value ? describe(value) : undefined} muted={value === null} choices={choices} none="No presets yet. Add one above." />;
}
