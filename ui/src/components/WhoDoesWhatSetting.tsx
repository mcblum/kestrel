// Settings → Models & roles → Who does what (server: shared/who-does-what.ts): the presets each
// role's work goes to, top choice first, and a few lines of the user's own on who should do what.
// Every row is the same thing: its presets in order, then the box that adds another (Matt,
// 2026-11-20). Orchestrate is above Design and Build; Review stands apart.
import { useId, useState, type ReactNode } from 'react';
import { CircleHelp } from 'lucide-react';
import { MAX_ROLE_INSTRUCTION, MAX_ROW, modeOfRole, ROLE_MODE_DETAIL, ROLE_MODE_LABEL, ROLE_MODES, ROLE_ROWS, ROUTING_LINE, ROW_EMPTY, ROW_HELP, ROW_LABEL, rowList, UNAVAILABLE, UNAVAILABLE_LABEL, whenUnavailable, withRowList, type RoleMode, type RoleRow, type Unavailable, type WhoDoesWhat } from '@kestrel/server/who-does-what';
import { PresetPicker } from './controls/PresetPicker.tsx';
import { TwoLineMenu } from './controls/TwoLineMenu.tsx';
import { usePresetText } from './controls/usePresetText.ts';
import { SettingSection } from './SettingHelp.tsx';
import '../styles/roles.css';

const ROW_MORE: Record<RoleRow, string> = {
  orchestrate: 'A session that hands work to other sessions leads them: it moves to the first of these on its own agent, from its next turn. A session keeps its agent, and one whose model you picked yourself keeps that.',
  design: 'Work of this kind goes to the first of these that can run, whichever agent the session is on.',
  build: 'Work of this kind goes to the first of these that can run, whichever agent the session is on.',
  review: 'The first of these that did not write the work reviews it.',
};

/** A row's label, right-aligned, with its help opening across the row underneath. */
function RowLabel({ htmlFor, label, help }: { htmlFor: string; label: string; help: ReactNode }) {
  const [open, setOpen] = useState(false);
  const helpId = useId();
  return (
    <>
      <div className="roles-label">
        <label htmlFor={htmlFor}>{label}</label>
        <button type="button" className={`setting-help-toggle${open ? ' open' : ''}`} aria-expanded={open} aria-controls={helpId} aria-label={`Help: ${label}`} title={open ? 'Hide help' : 'Help'} onClick={() => setOpen((was) => !was)}>
          <CircleHelp aria-hidden />
        </button>
      </div>
      <p id={helpId} className="settings-help roles-help" hidden={!open}>{help}</p>
    </>
  );
}

export function WhoDoesWhatSetting({ value: stored, onChange, onCreate, canCreate }: {
  value: WhoDoesWhat;
  onChange: (value: WhoDoesWhat) => void;
  /** Make a new preset and put it at `index` of the row. */
  onCreate: (row: RoleRow, index: number) => void;
  canCreate: boolean;
}) {
  const describe = usePresetText();
  const modes = { design: modeOfRole(stored, 'design'), build: modeOfRole(stored, 'build'), review: modeOfRole(stored, 'review') };
  const preset = (id: string) => stored.presets.find((p) => p.id === id) ?? null;
  return (
    <SettingSection title="Who does what" help={HELP}>
      <p className="settings-help">{ROUTING_LINE}</p>
      <div className="roles">
        {ROLE_ROWS.map((row) => {
          const list = rowList(stored, row).filter((id) => preset(id) !== null);
          const set = (next: string[]) => onChange(withRowList(stored, row, next));
          const label = ROW_LABEL[row];
          // Every chosen preset, then one empty box to add the next while there is room.
          const boxes: (string | null)[] = list.length < MAX_ROW ? [...list, null] : list;
          return (
            <div key={row} style={{ display: 'contents' }}>
              {row === 'review' && <div className="roles-apart" role="presentation" />}
              <RowLabel htmlFor={`roles-${row}-0`} label={label} help={<>{ROW_HELP[row]}. {ROW_MORE[row]}</>} />
              <div className="roles-list">
                {boxes.map((id, i) => (
                  <PresetPicker
                    key={id ?? 'add'}
                    id={`roles-${row}-${i}`}
                    label={`${label} preset ${i + 1}`}
                    value={id ? preset(id) : null}
                    options={stored.presets.filter((p) => p.id === id || !list.includes(p.id))}
                    empty={list.length === 0 ? ROW_EMPTY[row] : `Add another ${label} preset`}
                    describe={describe}
                    onPick={(picked) => set(id ? list.map((x) => (x === id ? picked : x)) : [...list, picked])}
                    onRemove={id ? () => set(list.filter((x) => x !== id)) : undefined}
                    none={i === 0 ? { label: ROW_EMPTY[row], onPick: () => set([]) } : undefined}
                    onCreate={canCreate ? () => onCreate(row, i) : undefined}
                  />
                ))}
              </div>
              {(row === 'design' || row === 'build') && (
                <div className="roles-side">
                  <TwoLineMenu
                    label={`How ${label} work is sent`}
                    name={ROLE_MODE_LABEL[modes[row]]}
                    detail={ROLE_MODE_DETAIL[modes[row]]}
                    disabled={list.length === 0}
                    choices={ROLE_MODES.map((mode) => ({ key: mode, name: ROLE_MODE_LABEL[mode], detail: ROLE_MODE_DETAIL[mode], checked: mode === modes[row], run: () => mode !== modes[row] && onChange({ ...stored, modes: { ...modes, [row]: mode as RoleMode } }) }))}
                  />
                </div>
              )}
            </div>
          );
        })}
        <div className="roles-apart" role="presentation" />
        <div className="roles-label plain"><label htmlFor="roles-unavailable">If the top choice cannot run</label></div>
        <div className="roles-wide">
          <select id="roles-unavailable" className="form-control" value={whenUnavailable(stored)} onChange={(e) => onChange({ ...stored, whenUnavailable: e.target.value as Unavailable })}>
            {UNAVAILABLE.map((choice) => <option key={choice} value={choice}>{UNAVAILABLE_LABEL[choice]}</option>)}
          </select>
        </div>
        <div className="roles-wide">
          <label className="tag-rule-switch">
            <input type="checkbox" checked={stored.reviewOffer !== false} disabled={rowList(stored, 'review').length === 0} onChange={(e) => onChange({ ...stored, reviewOffer: e.target.checked })} />
            Offer a review when I create a pull request
          </label>
        </div>
        <div className="roles-wide">
          <label className="tag-rule-switch">
            <input type="checkbox" checked={stored.reviewAuto === true} disabled={rowList(stored, 'review').length === 0} onChange={(e) => onChange({ ...stored, reviewAuto: e.target.checked })} />
            Start a review on its own when a session opens a pull request or asks for one
          </label>
        </div>
        <div className="roles-label plain"><label htmlFor="who-instruction">In your own words</label></div>
        <div className="roles-wide">
          <textarea id="who-instruction" className="form-control project-script" rows={3} maxLength={MAX_ROLE_INSTRUCTION} placeholder="Anything visual goes to Design first. Build never restyles what Design made." value={stored.instruction} onChange={(e) => onChange({ ...stored, instruction: e.target.value })} />
        </div>
      </div>
    </SettingSection>
  );
}

const HELP = (
  <p className="settings-help">
    Different agents are better at different work. Point a role at a model preset and work of that kind goes to it, whichever agent the session was started with; a role left on "Use the session’s current model" stays with the session. In the session's own project the part is done in that session's worktree, one session writing at a time, and handed back; in another project it gets a worktree of its own. "Ask me first" always shows you the card first, even from a session in Auto; "Route automatically" asks only when the session's own mode would; "Off" keeps the preset but sends nothing. Orchestrate is above Design and Build: the session you asked leads, hands those parts out and puts them together, and Review stands apart. A role can list who is next when its first choice cannot run (not connected, not signed in, or out of usage): you are asked before the work moves, unless you choose to have the next one used and be told. Review is started by you: from the Create pull request form, or from the card shown when a session opens a pull request or asks for a review of its work. Nothing starts before you answer, unless you choose to have reviews start on their own. Whoever wrote the code does not review it: list more than one reviewer, on different agents or models, and the first that did not write the work is used; if every one of them wrote some of it, no review is offered and the form says why. What you write under "In your own
    words" is given to every agent with its other standing instructions.
  </p>
);
