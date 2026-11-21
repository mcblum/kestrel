// Settings → Model presets, a section of its own (Matt, 2026-11-20) (server: shared/who-does-what.ts): a few named combinations
// of agent, model, effort and fast mode, picked later from the controls under the message box and
// from the "Who does what" table. Rows are edited here and saved together.
import { useDraft } from '../unsaved.ts';
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { AGENT_LABEL } from '@kestrel/server/model';
import { MAX_PRESETS, missingStarters, ROW_LABEL, rowList, STARTER_PRESETS, whoDoesWhatProblem, withoutPreset, withRowList, type ModelPreset, type RoleRow, type WhoDoesWhat } from '@kestrel/server/who-does-what';
import { OLDER_SERVER, RESTART_REASON } from '../store.ts';
import { startingControls, useTabs } from '../tabsStore.ts';
import { saveWhoDoesWhat, useWhoDoesWhatResource } from '../whoDoesWhat.ts';
import { ModelControl } from './controls/ModelControl.tsx';
import { ProviderControl } from './controls/ProviderControl.tsx';
import { useCapabilities } from './controls/useCapabilities.ts';
import { WhoDoesWhatSetting } from './WhoDoesWhatSetting.tsx';
import { SettingHeading } from './SettingHelp.tsx';

/** Draft presets get stable IDs so roles can reference them before saving. */
type Row = ModelPreset & { key: string; /** A common preset offered by name: nothing is saved for it until its model is chosen. */ unchosen?: boolean };

const rowOf = (preset: ModelPreset): Row => ({ ...preset, key: preset.id });
/** What is saved: every row but the starters still waiting for a model. */
const sent = (rows: readonly Row[]) => rows.filter((row) => !row.unchosen).map(({ key: _key, unchosen: _unchosen, ...preset }) => preset);

function PresetRow({ row, index, onChange, onRemove }: { row: Row; index: number; onChange: (patch: Partial<Row>) => void; onRemove: () => void }) {
  const caps = useCapabilities(row.agent);
  const id = `preset-name-${row.key}`;
  return (
    <li className="preset-row" aria-label={row.name || `Preset ${index + 1}`}>
      <label htmlFor={id} className="saved-action-field">
        <span className="preset-mobile-label">Name</span>
        <input id={id} className="form-control" spellCheck={false} placeholder="Deep review" value={row.name} onChange={(e) => onChange({ name: e.target.value })} />
      </label>
      <div className="preset-agent-field" role="group" aria-label={`Agent for ${row.name || `preset ${index + 1}`}`}>
        <span className="preset-mobile-label" aria-hidden="true">Agent</span>
        {/* Another agent's model means nothing here: the new agent starts at its default. */}
        <ProviderControl value={row.agent} fixed={false} onChange={(agent) => onChange({ agent, model: '', effort: '', fast: false })} />
      </div>
      <div className="preset-model-field" role="group" aria-label={`Model and effort for ${row.name || `preset ${index + 1}`}`}>
        <span className="preset-mobile-label" aria-hidden="true">Model / effort</span>
        <ModelControl models={caps.models} value={{ model: row.model, effort: row.effort, fast: row.fast }} running={false} placeholder={row.unchosen ? 'Choose a model' : undefined} onChange={(s) => onChange({ model: s.model, effort: s.effort ?? '', fast: s.fast ?? false, unchosen: false })} />
        {row.unchosen && (
          <button type="button" className="link-button preset-use-default" aria-label={`Use ${AGENT_LABEL[row.agent]}'s default for ${row.name || `preset ${index + 1}`}`} onClick={() => onChange({ unchosen: false })}>Use default</button>
        )}
      </div>
      <button type="button" className="icon-button saved-action-remove" aria-label={`Remove ${row.name || `preset ${index + 1}`}`} title="Remove" onClick={onRemove}>
        <Trash2 aria-hidden />
      </button>
    </li>
  );
}

function Editor({ stored }: { stored: WhoDoesWhat }) {
  const defaults = useTabs(startingControls);
  const starter = (name: string): Row => ({ id: crypto.randomUUID(), key: crypto.randomUUID(), name, agent: defaults.agent, model: '', effort: '', fast: false, unchosen: true });
  // With nothing saved yet the common presets are there to start from, each waiting for its model.
  const initial = (): Row[] => (stored.presets.length === 0 ? STARTER_PRESETS.map(starter) : stored.presets.map(rowOf));
  const [rows, setRows] = useState<Row[]>(initial);
  useEffect(() => setRows(initial()), [stored.presets]); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [stored]);
  const missing = missingStarters(rows.map((r) => r.name));
  const waiting = rows.filter((r) => r.unchosen).length;
  const next = { ...draft, presets: sent(rows) };
  const problem = whoDoesWhatProblem(next);
  const changed = JSON.stringify(next) !== JSON.stringify(stored);
  const anchor = useDraft({ what: 'Models & roles', changed, problem, save: () => saveWhoDoesWhat(next), discard: () => { setRows(initial()); setDraft(stored); } });
  const add = (row?: RoleRow, index?: number) => {
    const id = crypto.randomUUID();
    const base = row ? `${ROW_LABEL[row]} preset` : '';
    let name = base;
    for (let n = 2; name && rows.some((r) => r.name.trim().toLowerCase() === name.toLowerCase()); n++) name = `${base} ${n}`;
    setRows([...rows, { id, key: id, name, agent: defaults.agent, model: defaults.model, effort: defaults.effort ?? '', fast: defaults.fast ?? false }]);
    // Made from a row's box: it goes into that box.
    if (row) {
      const list = [...rowList(draft, row)];
      list.splice(index ?? list.length, 1, id);
      setDraft(withRowList(draft, row, list));
    }
    requestAnimationFrame(() => {
      const input = document.getElementById(`preset-name-${id}`) as HTMLInputElement | null;
      input?.focus();
      input?.select();
    });
  };
  const remove = (row: Row) => {
    setRows(rows.filter((r) => r.id !== row.id));
    if (row.id) setDraft(withoutPreset(draft, row.id));
  };
  return (
    <>
      <h2>Model presets</h2>
      <p className="settings-help">Save an agent, model and effort under a name. Use it in a session or assign it to a role below.</p>
      {rows.length === 0 && <p className="settings-help">No presets yet.</p>}
      {waiting > 0 && <p className="settings-help">Choose a model or use the agent’s default for each preset you want. Unconfigured suggestions won’t be saved.</p>}
      <div className="preset-column-headings" aria-hidden="true">
        <span>Preset name</span><span>Agent</span><span>Model / effort</span><span />
      </div>
      <ul className="preset-list">
        {rows.map((row, i) => (
          <PresetRow key={row.key} row={row} index={i} onChange={(patch) => setRows(rows.map((r) => (r.key === row.key ? { ...r, ...patch } : r)))} onRemove={() => remove(row)} />
        ))}
      </ul>
      <div className="delegation-limits-actions preset-actions">
        <button type="button" disabled={rows.length >= MAX_PRESETS} onClick={() => add()}>
          <Plus aria-hidden /> Add preset
        </button>
        {missing.length > 0 && rows.length + missing.length <= MAX_PRESETS && (
          <button type="button" onClick={() => setRows([...rows, ...missing.map(starter)])}>Add common presets</button>
        )}
        <span className="preset-save-status">{waiting > 0 ? `${rows.length - waiting} of ${rows.length} configured` : `${rows.length} ${rows.length === 1 ? 'preset' : 'presets'}`}</span>

      </div>
      <WhoDoesWhatSetting value={next} onChange={setDraft} onCreate={add} canCreate={rows.length < MAX_PRESETS} />
      {changed && problem && <span className="delegation-limit-problem" role="alert">{problem}</span>}
      <span ref={anchor} className="draft-anchor" />
    </>
  );
}

const HELP = (
  <p className="settings-help">
    A preset is an alias: an agent, model, effort and fast mode under one name, for combinations you switch between: everyday work, a deeper model for hard problems, a different provider for review. Pick one from Preset in the controls under the message box; a new preset
    starts from what new sessions start with. Presets are also what the roles in Who does what below point at. Removing a preset a role uses leaves that role to the session's own agent.
  </p>
);

export function PresetsSetting() {
  const loaded = useWhoDoesWhatResource();
  return (
    <>
      {/* The page's own heading: this is a section of Settings by itself. */}
      <SettingHeading level={1} title="Models & roles" help={HELP} />
      <section className="settings-section preset-editor">
        {loaded.state === 'ready' ? <Editor stored={loaded.value} /> : <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>}
      </section>
    </>
  );
}
