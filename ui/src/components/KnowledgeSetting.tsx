// Settings → Workflow → Knowledge base (server: shared/knowledge.ts, knowledge/api.ts). Which
// registered project is the team's knowledge base, whether sessions may propose additions to it, and
// what Kestrel read from it. The select and the switch save as they are changed. The view is a route
// answer held once in the store (`useResource`); a change writes back what the server answered.
import { fetchEveryText, INDEX_LINES_MAX, KNOWLEDGE_FETCH_MINUTES, KNOWLEDGE_MANIFEST, KNOWLEDGE_STALE_DAYS, PROPOSALS_PER_SESSION, type KnowledgeView } from '@kestrel/server/knowledge';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';
import { SettingSection } from './SettingHelp.tsx';

export const KNOWLEDGE_PATH = '/api/knowledge';
const asView = (raw: unknown): Sourced<KnowledgeView> => ready(raw as KnowledgeView);
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const HELP = (
  <>
    <p className="settings-help">
      A knowledge base is a git repository your team shares, where what everyone should know is written down: how the platform works, how systems connect, what has caught people out. Kestrel knows a registered project is one by the file{' '}
      <code>{KNOWLEDGE_MANIFEST}</code> at its root, and reads it from the default branch of its remote, so only what has been merged reaches an agent.
    </p>
    <p className="settings-help">
      Every session is given one line per entry that applies to the repository it works in, at most {INDEX_LINES_MAX} lines however large the knowledge base grows, and reads an entry only when it needs it. When a session learns something that is written down
      nowhere, it may propose it: you are shown the exact text on a card that never holds the work up, and on your yes Kestrel opens the pull request. A session proposes at most {PROPOSALS_PER_SESSION} entries.
    </p>
  </>
);

function Read({ base }: { base: NonNullable<KnowledgeView['base']> }) {
  return (
    <>
      <p className="settings-help">
        {base.name}: {count(base.entries, 'entry', 'entries')} in {count(base.areas.length, 'area', 'areas')}, read from {base.ref}.
        {base.stale > 0 && ` ${count(base.stale, 'entry has', 'entries have')} not been verified in ${KNOWLEDGE_STALE_DAYS} days; an agent reading one is told so.`}
      </p>
      {base.skipped.length > 0 && (
        <>
          <p className="settings-help">{count(base.skipped.length, 'file is', 'files are')} left out because Kestrel cannot read them as entries:</p>
          <ul className="settings-help">
            {base.skipped.slice(0, 10).map((s) => (
              <li key={s.path}>
                <code>{s.path}</code>: {s.reason}
              </li>
            ))}
            {base.skipped.length > 10 && <li>and {base.skipped.length - 10} more.</li>}
          </ul>
        </>
      )}
    </>
  );
}

function KnowledgeControls() {
  const loaded = useResource(KNOWLEDGE_PATH, asView).value;
  const change = async (patch: Partial<KnowledgeView['settings']>) => {
    const view = await act(() => call<KnowledgeView>(KNOWLEDGE_PATH, { method: 'PATCH', body: JSON.stringify(patch) }));
    if (view) putResource(KNOWLEDGE_PATH, ready(view));
  };
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  const { settings, candidates, base, problem } = loaded.value;
  // The project in use stays listed even when it can no longer be read, so the choice is never hidden.
  const chosenMissing = settings.projectId !== null && !candidates.some((c) => c.projectId === settings.projectId);
  if (candidates.length === 0 && !settings.projectId) {
    return (
      <p className="settings-help">
        None of your projects is a knowledge base. Add your team's knowledge repository as a project; Kestrel recognises it by <code>{KNOWLEDGE_MANIFEST}</code> at its root.
      </p>
    );
  }
  return (
    <>
      <div className="ticket-answer">
        <label htmlFor="knowledge-project">Knowledge base</label>
        <select id="knowledge-project" className="form-control" value={settings.projectId ?? ''} onChange={(e) => void change({ projectId: e.target.value || null })}>
          <option value="">None</option>
          {chosenMissing && <option value={settings.projectId!}>The project chosen before</option>}
          {candidates.map((c) => (
            <option key={c.projectId} value={c.projectId}>
              {c.name} ({c.project})
            </option>
          ))}
        </select>
      </div>
      {problem && <p className="settings-help" role="alert">{problem}</p>}
      {base && <Read base={base} />}
      {settings.projectId && (
        <>
          <div className="ticket-answer">
            <label htmlFor="knowledge-fetch">Check for changes</label>
            <select id="knowledge-fetch" className="form-control" value={settings.fetchMinutes} onChange={(e) => void change({ fetchMinutes: Number(e.target.value) })}>
              {KNOWLEDGE_FETCH_MINUTES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {fetchEveryText(minutes)}
                </option>
              ))}
            </select>
          </div>
          <p className="settings-help">
            Kestrel fetches the knowledge base's remote this often while it is open, and when a session starts. What was merged since reaches sessions already at work the next time they search or read; your own checkout is never pulled or changed.
          </p>
        </>
      )}
      {settings.projectId && (
        <label className="tag-rule-switch">
          <input type="checkbox" checked={settings.proposals === 'ask'} onChange={(e) => void change({ proposals: e.target.checked ? 'ask' : 'never' })} />
          Let sessions propose additions and corrections
        </label>
      )}
    </>
  );
}

export function KnowledgeSetting() {
  return (
    <SettingSection title="Knowledge base" help={HELP}>
      <KnowledgeControls />
    </SettingSection>
  );
}
