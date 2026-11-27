// A project only another computer of the account has (account-sessions.md, 10.2 and 10.3): the quiet line
// under its title says which computers have it and what to do to work on it here, and its empty list says
// where its sessions come from. Grey, as every other quiet line; the words are shared/account-projects.ts's.
import { useState } from 'react';
import { FolderPlus, FolderX } from 'lucide-react';
import { alreadyHereText } from '@kestrel/server/account-projects';
import type { Project } from '@kestrel/server/model';
import { ready, unavailable, type Sourced } from '@kestrel/server/sourced';
import { notHere } from '../awayProjects.ts';
import { useResource } from '../data/resources.ts';
import { thisComputer } from '../platform.ts';
import { AddFolderInput } from '../components/AddFolderInput.tsx';
import { call } from '../store.ts';
import { openView } from '../route.ts';

/** The folder of this computer that is already the project's repository, as the server found it. */
type Here = { path: string; shown: string } | null;

function asHere(raw: unknown): Sourced<Here> {
  const folder = (raw as { folder?: { path?: unknown; shown?: unknown } | null } | null)?.folder;
  if (folder === null) return ready(null);
  return typeof folder?.path === 'string' && typeof folder.shown === 'string' ? ready({ path: folder.path, shown: folder.shown }) : unavailable('Could not look for its folder.');
}

/** `text` with each `quoted` part as code, as the sentence names a repository. */
function withCode(text: string) {
  return text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

const names = (project: Project) => project.elsewhere?.machines.map((m) => m.name).join(' and ') || 'another computer';

export function ProjectElsewhereLine({ project }: { project: Project }) {
  const folders = project.elsewhere?.folders ?? [];
  const where = folders.map((f) => f.path ?? f.name).join(', ');
  const plain = (project.elsewhere?.repos.length ?? 0) === 0;
  return (
    <span className="project-elsewhere">
      {notHere.mark(project)}
      {plain ? (where ? `, in ${where}. ` : '. ') : ` · On ${names(project)}${where ? ` in ${where}` : ''}.`}
      {plain && withCode(notHere.text(project))}
    </span>
  );
}

/**
 * How a repository only another computer lists gets here, said plainly at the top of its page: one click when
 * its folder was found on this disk, else the folder chooser. Either way the folder becomes the project at
 * once; nothing sends the person to Create project for a project that already exists.
 */
export function ProjectElsewhereAdd({ project }: { project: Project }) {
  const route = `/api/projects/${encodeURIComponent(project.id)}/here`;
  const found = useResource(route, asHere).value;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if ((project.elsewhere?.repos.length ?? 0) === 0) return null;
  const here = found.state === 'ready' ? found.value : null;
  /** Adds `path` as this project; the error to show, or null once it is added. */
  const add = async (path: string): Promise<string | null> => {
    setBusy(true);
    try {
      const made = await call<Project>(route, { method: 'POST', body: JSON.stringify({ path }) });
      openView({ kind: 'project', id: made.id });
      return null;
    } catch (problem) {
      return problem instanceof Error ? problem.message : String(problem);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="project-elsewhere-add" aria-label={`Add ${project.name} on ${thisComputer()}`}>
      <FolderX aria-hidden className="project-elsewhere-icon" />
      {here ? (
        <div className="project-elsewhere-body">
          <p className="project-elsewhere-title">{withCode(alreadyHereText(here.shown, thisComputer()))}</p>
          <div className="dir-add-row">
            <button type="button" className="primary-button" disabled={busy} onClick={() => void add(here.path).then(setError)}>
              <FolderPlus aria-hidden /> Add to Kestrel
            </button>
          </div>
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>
      ) : (
        <div className="project-elsewhere-body">
          <p className="project-elsewhere-title">{withCode(notHere.text(project))}</p>
          <AddFolderInput onAdd={add} busy={busy} placeholder="Full path of its folder, e.g. ~/Code/website" />
        </div>
      )}
    </section>
  );
}

export function ProjectElsewhereEmpty({ project }: { project: Project }) {
  return (
    <div className="empty-quiet">
      <p className="empty-quiet-title">No sessions yet</p>
      <p>Sessions started in {project.name} on {names(project)} show here.</p>
    </div>
  );
}
