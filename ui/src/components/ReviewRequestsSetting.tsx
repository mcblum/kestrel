// Settings → Git → Review requests (server: shared/review-settings.ts, review-settings/api.ts): what
// Kestrel does with the requests you were asked to review, and in which projects a review may
// start on its own. With a `projectId` it is the same list seen from that project's Settings tab:
// one switch. Held once in the app store through useResource; a change writes back what the
// server stored.
import { DEFAULT_REVIEW_SETTINGS, isAutomatic, isChosenProject, REPLY_WARNING, REVIEW_MODE_LABEL, REVIEW_MODES, sanitizeReviewSettings, withProject, type ReviewMode, type ReviewProjects, type ReviewSettings } from '@kestrel/server/review-settings';
import { useState } from 'react';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { openView } from '../route.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON, useApp } from '../store.ts';
import { SettingSection } from './SettingHelp.tsx';

const REVIEW_SETTINGS_PATH = '/api/review-settings';
const asSettings = (raw: unknown): Sourced<ReviewSettings> => ready(sanitizeReviewSettings(raw));

const save = async (change: Partial<ReviewSettings> & { confirmed?: boolean }): Promise<void> => {
  const stored = await act(() => call<ReviewSettings>(REVIEW_SETTINGS_PATH, { method: 'PUT', body: JSON.stringify(change) }));
  if (stored) putResource(REVIEW_SETTINGS_PATH, ready(sanitizeReviewSettings(stored)));
};

const MODE_NOTE: Record<ReviewMode, string> = {
  off: 'GitHub and GitLab are not asked, and nothing is listed.',
  list: 'Requests appear under CODE REVIEWS in the sidebar. You start each review.',
  start: 'A review session starts when a request arrives, two at a time at most; the rest wait. Nothing is posted to the host until you post it.',
  reply: 'A review session starts when a request arrives, and its review is posted in your name when it is finished, approval included.',
};

const HELP = (
  <p className="settings-help">
    Kestrel asks GitHub and GitLab for the pull requests you were asked to review by name; a request made of a team you are in is never listed. A review is a session in the request's project, checked out at the request's commit. A pull request is somebody
    else's text, and text in it can steer the model that reads it, so let reviews start on their own only in projects whose contributors you trust. Requests are listed for every project whichever projects you choose here.
  </p>
);

const NO_PROJECTS: readonly { id: string; name: string }[] = [];
/** The registered projects, as the store holds them: the same array until a project changes. */
const useProjects = (): readonly { id: string; name: string }[] => useApp((s) => s.workspace?.projects ?? NO_PROJECTS);

function Projects({ projects, registered }: { projects: ReviewProjects; registered: readonly { id: string; name: string }[] }) {
  const ids = registered.map((p) => p.id);
  return (
    <fieldset className="notify-events review-setting-projects">
      <legend>In which projects</legend>
      <label className="settings-choice">
        <input type="radio" name="review-projects" checked={projects === 'all'} onChange={() => void save({ projects: 'all' })} />
        All projects
      </label>
      <label className="settings-choice">
        <input type="radio" name="review-projects" checked={projects !== 'all'} onChange={() => void save({ projects: ids })} />
        Only these
      </label>
      {projects !== 'all' && (
        <div className="review-setting-list">
          {registered.length === 0 && <p className="settings-help">No projects yet.</p>}
          {registered.map((p) => (
            <label key={p.id} className="tag-rule-switch">
              <input type="checkbox" checked={projects.includes(p.id)} onChange={(e) => void save({ projects: withProject(projects, p.id, e.target.checked, ids) })} />
              {p.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function AppControls({ settings }: { settings: ReviewSettings }) {
  const registered = useProjects();
  // Posting in the user's name is stored only once its warning is agreed to; until then the
  // select shows the choice being made and the setting stays as it was.
  const [confirming, setConfirming] = useState(false);
  const choose = (mode: ReviewMode) => {
    if (mode === 'reply' && settings.mode !== 'reply') return setConfirming(true);
    setConfirming(false);
    void save({ mode });
  };
  if (confirming) {
    return (
      <>
        <select aria-label="Review requests" className="form-control review-setting-mode" value="reply" onChange={(e) => choose(e.target.value as ReviewMode)}>
          {REVIEW_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {REVIEW_MODE_LABEL[mode]}
            </option>
          ))}
        </select>
        <div className="review-setting-warning" role="alertdialog" aria-label="Confirm posting reviews on their own">
          <p>{REPLY_WARNING}</p>
          <div>
            <button type="button" className="primary-button small" onClick={() => (setConfirming(false), void save({ mode: 'reply', confirmed: true }))}>
              Post reviews on their own
            </button>
            <button type="button" className="secondary-button small" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      <select aria-label="Review requests" className="form-control review-setting-mode" value={settings.mode} onChange={(e) => choose(e.target.value as ReviewMode)}>
        {REVIEW_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {REVIEW_MODE_LABEL[mode]}
            {mode === DEFAULT_REVIEW_SETTINGS.mode ? ' (default)' : ''}
          </option>
        ))}
      </select>
      <p className="settings-help">{MODE_NOTE[settings.mode]}</p>
      {isAutomatic(settings.mode) && <Projects projects={settings.projects} registered={registered} />}
    </>
  );
}

function ProjectControls({ settings, projectId }: { settings: ReviewSettings; projectId: string }) {
  const registered = useProjects();
  if (!isAutomatic(settings.mode)) {
    return (
      <p className="settings-help">
        Reviews do not start on their own: Review requests is set to "{REVIEW_MODE_LABEL[settings.mode]}".{' '}
        <button type="button" className="link-button" onClick={() => openView({ kind: 'settings', section: 'git' })}>
          Change it in Settings → Git
        </button>
      </p>
    );
  }
  const ids = registered.map((p) => p.id);
  return (
    <label className="tag-rule-switch">
      <input type="checkbox" checked={isChosenProject(settings, projectId)} onChange={(e) => void save({ projects: withProject(settings.projects, projectId, e.target.checked, ids) })} />
      {settings.mode === 'reply' ? 'Start reviews in this project, and post them, on their own' : 'Start reviews in this project on their own'}
    </label>
  );
}

/** `projectId`: that project's switch; without one, the app's setting. */
export function ReviewRequestsSetting({ projectId }: { projectId?: string }) {
  const loaded = useResource(REVIEW_SETTINGS_PATH, asSettings).value;
  return (
    <SettingSection title="Review requests" help={HELP}>
      {loaded.state !== 'ready' ? (
        <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>
      ) : projectId ? (
        <ProjectControls settings={loaded.value} projectId={projectId} />
      ) : (
        <AppControls settings={loaded.value} />
      )}
    </SettingSection>
  );
}
