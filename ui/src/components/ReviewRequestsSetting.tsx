// Settings → Code reviews (0.0.23; before that, Settings → Git → Review requests) (server: shared/review-settings.ts, review-settings/api.ts): what
// Kestrel does with the requests you were asked to review, and in which projects a review may
// start on its own. With a `projectId` it is the same list seen from that project's Settings tab:
// one switch. Held once in the app store through useResource; a change writes back what the
// server stored.
import { DEFAULT_REVIEW_SETTINGS, isAutomatic, isChosenProject, REPLY_WARNING, REVIEW_MODE_LABEL, REVIEW_MODES, REVIEW_PLACE_LABEL, REVIEW_PLACES, withProject, type ReviewMode, type ReviewPlace, type ReviewProjects, type ReviewSettings, DEFAULT_REVIEW_INSTRUCTIONS, instructionsProblem } from '@kestrel/server/review-settings';
import { useEffect, useState } from 'react';
import { useDraft } from '../unsaved.ts';
import { PERMISSION_LEVELS, permissionHint, type PermissionLevel } from '@kestrel/server/permissions';
import { REVIEW_PERMISSIONS } from '@kestrel/server/review-requests';
import { useResource } from '../data/resources.ts';
import { openView } from '../route.ts';
import { asReviewSettings as asSettings, REVIEW_SETTINGS_PATH, saveReviewSettings as save } from '../reviewSettings.ts';
import { OLDER_SERVER, RESTART_REASON, useApp } from '../store.ts';
import { SettingSection } from './SettingHelp.tsx';

const MODE_NOTE: Record<ReviewMode, string> = {
  off: 'GitHub and GitLab are not asked, and nothing is listed.',
  list: 'Requests are listed where you choose below. You start each review.',
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

const PLACE_NOTE: Record<ReviewPlace, string> = {
  both: 'A CODE REVIEWS section in the sidebar, and a Code reviews row at its top that opens the page with all of them.',
  sidebar: 'A CODE REVIEWS section in the sidebar. Its "Show more" opens the page with all of them.',
  page: 'A Code reviews row at the top of the sidebar opens the page, with a dot and a count while some are new. A review session stays in its project.',
};

/** The numbers offered for how many requests the sidebar lists; the stored one is added when it is not among them. */
const LIMIT_CHOICES = [3, 5, 10, 15, 20, 30, 50];

/** Where the requests are shown, and how many of them the sidebar lists. Both save as they are changed. */
function Place({ settings }: { settings: ReviewSettings }) {
  const limits = LIMIT_CHOICES.includes(settings.sidebarLimit) ? LIMIT_CHOICES : [...LIMIT_CHOICES, settings.sidebarLimit].sort((a, b) => a - b);
  return (
    <div className="review-setting-place">
      <label className="review-setting-field">
        <span>Show them</span>
        <select aria-label="Where review requests are shown" className="form-control" value={settings.show} onChange={(e) => void save({ show: e.target.value as ReviewPlace })}>
          {REVIEW_PLACES.map((place) => (
            <option key={place} value={place}>
              {REVIEW_PLACE_LABEL[place]}
              {place === DEFAULT_REVIEW_SETTINGS.show ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>
      <p className="settings-help">{PLACE_NOTE[settings.show]}</p>
      {settings.show !== 'page' && (
        <>
          <label className="review-setting-field">
            <span>In the sidebar, list</span>
            <select aria-label="How many review requests the sidebar lists" className="form-control" value={settings.sidebarLimit} onChange={(e) => void save({ sidebarLimit: Number(e.target.value) })}>
              {limits.map((n) => (
                <option key={n} value={n}>
                  {n}
                  {n === DEFAULT_REVIEW_SETTINGS.sidebarLimit ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="settings-help">The most recent requests nobody has started on. The rest are behind "Show more". A review that is under way is always listed.</p>
        </>
      )}
    </div>
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
      {settings.mode !== 'off' && <Place settings={settings} />}
    </>
  );
}

function ProjectControls({ settings, projectId }: { settings: ReviewSettings; projectId: string }) {
  const registered = useProjects();
  if (!isAutomatic(settings.mode)) {
    return (
      <p className="settings-help">
        Reviews do not start on their own: Review requests is set to "{REVIEW_MODE_LABEL[settings.mode]}".{' '}
        <button type="button" className="link-button" onClick={() => openView({ kind: 'settings', section: 'code-reviews' })}>
          Change it in Settings → Code reviews
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

const MODE_HELP = (
  <p className="settings-help">
    The permission mode a review session starts in, whoever starts it. Auto is the default: a review reads a change and writes nothing, and one that stops to ask before each command it reads the change with cannot be left to get on with it. Whatever the mode, a
    review is posted only through its review card.
  </p>
);

const ANNOUNCE_HELP = (
  <p className="settings-help">
    When several people let reviews start on their own, one request sets several agents off at once, none knowing of the others. With this on, Kestrel posts a short comment in your name when a review begins: "Reviewing this now, at commit …". Whether it is on or
    not, Kestrel reads a request's recent comments before starting a review on its own, and does not start one when somebody else has said "Reviewing" within the last day; the request then says who, and you can still start a review yourself.
  </p>
);

const INSTRUCTIONS_HELP = (
  <p className="settings-help">
    What every review is told about how to review and how to write it up. It goes into the first message of a review session, after what is being reviewed and before how the review is handed over; those two parts are Kestrel's and are not changed here. Write your
    own, or keep Kestrel's: short comments, code quoted inline, and no building or testing, which is CI's work.
  </p>
);

/**
 * The instructions as a draft: typed here, saved by the screen's Save bar (ui/src/unsaved.ts).
 * Reset to default puts Kestrel's own wording back at once, as a switch would.
 */
function ReviewInstructions({ stored }: { stored: string }) {
  const shown = stored || DEFAULT_REVIEW_INSTRUCTIONS;
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const problem = instructionsProblem(text);
  const anchor = useDraft({ what: 'Review instructions', changed: text !== shown, problem, save: async () => (await save({ instructions: text }), true), discard: () => setText(shown) });
  const isDefault = stored === '' && text === DEFAULT_REVIEW_INSTRUCTIONS;
  return (
    <>
      <textarea aria-label="Review instructions" className="form-control review-setting-instructions" rows={12} spellCheck value={text} aria-invalid={problem !== null} onChange={(e) => setText(e.target.value)} />
      {problem && <p className="field-error" role="alert">{problem}</p>}
      <p className="settings-help review-setting-reset">
        <button type="button" className="secondary-button small" disabled={isDefault} onClick={() => (setText(DEFAULT_REVIEW_INSTRUCTIONS), void save({ instructions: '' }))}>
          Reset to default
        </button>
        <span>{stored === '' ? 'These are Kestrel’s own.' : 'These are your own.'}</span>
      </p>
      <span ref={anchor} className="draft-anchor" />
    </>
  );
}

/** How reviews run: the mode they start in, and whether Kestrel says so on the request when one begins. Both save as they are changed. */
function ReviewRunSettings() {
  const loaded = useResource(REVIEW_SETTINGS_PATH, asSettings).value;
  if (loaded.state !== 'ready') return null; // the section above says why
  const settings = loaded.value;
  const modes = PERMISSION_LEVELS.filter((m) => REVIEW_PERMISSIONS.includes(m.id));
  const chosen = modes.find((m) => m.id === settings.permission);
  return (
    <>
      <SettingSection title="Code reviews permissions mode" help={MODE_HELP}>
        <select aria-label="Code reviews permissions mode" className="form-control review-setting-mode" value={settings.permission} onChange={(e) => void save({ permission: e.target.value as PermissionLevel })}>
          {modes.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.label}
              {mode.id === DEFAULT_REVIEW_SETTINGS.permission ? ' (default)' : ''}
            </option>
          ))}
        </select>
        {chosen && <p className="settings-help">{permissionHint(chosen)}.</p>}
      </SettingSection>
      <SettingSection title="Review instructions" help={INSTRUCTIONS_HELP}>
        <ReviewInstructions stored={settings.instructions} />
      </SettingSection>
      <SettingSection title="When a review begins" help={ANNOUNCE_HELP}>
        <label className="tag-rule-switch">
          <input type="checkbox" checked={settings.announce} onChange={(e) => void save({ announce: e.target.checked })} />
          Post a "Reviewing" comment on the pull request
        </label>
        <p className="settings-help">{settings.announce ? 'Posted in your name on GitHub or GitLab as each review starts, by hand or on its own.' : 'Nothing is posted when a review starts.'}</p>
      </SettingSection>
    </>
  );
}

/** Settings → Code reviews: what is done with review requests, then how a review runs. */
export function CodeReviewsSettings() {
  return (
    <>
      <h1>Code reviews</h1>
      <ReviewRequestsSetting />
      <ReviewRunSettings />
    </>
  );
}
