// Settings → Workflow: "Delegation limits" (server: limits.ts, limits-api.ts; the ranges and their
// reasons in @kestrel/server/delegation-limits). The limits in force are held once in the app store
// through useResource; what is typed here is only a draft until Save, checked as it is typed with
// the same function the server uses, and a save writes back what the server stored.
import { useDraft } from '../unsaved.ts';
import { SettingSection } from './SettingHelp.tsx';
import { useState } from 'react';
import { LIMIT_KEYS, LIMIT_LABELS, LIMIT_RANGES, limitProblem, type DelegationLimits, type DelegationLimitsView, type LimitKey } from '@kestrel/server/delegation-limits';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';

export const DELEGATION_LIMITS_PATH = '/api/delegation-limits';
const asView = (raw: unknown): Sourced<DelegationLimitsView> => ready(raw as DelegationLimitsView);

type Draft = Partial<Record<LimitKey, string>>;

/** What a typed value means: blank is no number at all, so it is refused as one. */
const typed = (text: string): number => (text.trim() === '' ? Number.NaN : Number(text));

async function send(init: RequestInit): Promise<boolean> {
  const view = await act(() => call<DelegationLimitsView>(DELEGATION_LIMITS_PATH, init));
  if (view) putResource(DELEGATION_LIMITS_PATH, ready(view));
  return view !== undefined;
}

function LimitInput({ name, text, fallback, onChange }: { name: LimitKey; text: string; fallback: number; onChange: (text: string) => void }) {
  const { min, max } = LIMIT_RANGES[name];
  const problem = limitProblem(name, typed(text));
  return (
    <div className="delegation-limit">
      <label htmlFor={`limit-${name}`}>{LIMIT_LABELS[name]}</label>
      <span className="delegation-limit-field">
        <input id={`limit-${name}`} type="number" min={min} max={max} step={1} value={text} aria-invalid={problem !== null} onChange={(e) => onChange(e.target.value)} />
        <span className="delegation-limit-default">
          Default {fallback} · {min} to {max}
        </span>
      </span>
      {problem && <span className="delegation-limit-problem">{problem}</span>}
    </div>
  );
}

function LimitsForm({ view }: { view: DelegationLimitsView }) {
  const [draft, setDraft] = useState<Draft>({});
  const textOf = (key: LimitKey): string => draft[key] ?? String(view.limits[key]);
  const changed = LIMIT_KEYS.some((key) => draft[key] !== undefined && typed(draft[key]!) !== view.limits[key]);
  const valid = LIMIT_KEYS.every((key) => limitProblem(key, typed(textOf(key))) === null);
  const atDefaults = LIMIT_KEYS.every((key) => view.limits[key] === view.defaults[key]);
  const save = async () => {
    const limits = Object.fromEntries(LIMIT_KEYS.map((key) => [key, typed(textOf(key))])) as unknown as DelegationLimits;
    const saved = await send({ method: 'PUT', body: JSON.stringify(limits) });
    if (saved) setDraft({});
    return saved;
  };
  const firstProblem = LIMIT_KEYS.map((key) => limitProblem(key, typed(textOf(key)))).find((p) => p !== null) ?? null;
  const anchor = useDraft({ what: 'Delegation limits', changed, problem: valid ? null : firstProblem, save, discard: () => setDraft({}) });
  const reset = async () => {
    if (await send({ method: 'DELETE' })) setDraft({});
  };
  return (
    <>
      {LIMIT_KEYS.map((key) => (
        <LimitInput key={key} name={key} text={textOf(key)} fallback={view.defaults[key]} onChange={(text) => setDraft((d) => ({ ...d, [key]: text }))} />
      ))}
      <div className="delegation-limits-actions">
        <button type="button" disabled={atDefaults && !changed} onClick={() => void reset()}>
          Reset to defaults
        </button>
      </div>
      <span ref={anchor} className="draft-anchor" />
    </>
  );
}

function DelegationLimitsSettingControls() {
  const loaded = useResource(DELEGATION_LIMITS_PATH, asView).value;
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  return (
    <>
      <LimitsForm view={loaded.value} />
    </>
  );
}

const HELP = (
  <>
    <p className="settings-help">
      How far a session may split its work. A call past a limit is refused, and the agent is told the number in force so it can do the work itself or wait. A session started with handoff or spawn counts toward the sessions at work in its tree. An agent cannot
      change these.
    </p>
  </>
);

export function DelegationLimitsSetting() {
  return (
    <SettingSection title="Delegation limits" help={HELP}>
      <DelegationLimitsSettingControls />
    </SettingSection>
  );
}
