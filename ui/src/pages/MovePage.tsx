// "Move to project…": the same handoff the agent can start, started by hand with a summary.
// A page in the main canvas, like everything else that asks for more than a click. Also where a
// session dropped on another project's group lands (`groupId`): it can only join that group by
// moving, so the page says so before anything happens.
import { useEffect, useState } from 'react';
import type { Project } from '@kestrel/server/model';
import { defaultFolder } from '@kestrel/server/project-folders';
import { openSession, openView } from '../route.ts';
import { actions, useApp } from '../store.ts';

/** Where the new session works: a worktree of its own in a git repository, the folder itself otherwise. */
function worktreeNote(project: Project): string {
  return defaultFolder(project)?.isGit ? ' with a new worktree of its own' : '';
}

export function MovePage({ sessionId, projectId, groupId }: { sessionId: string; projectId: string; groupId?: string }) {
  const project = useApp((s) => s.workspace?.projects.find((p) => p.id === projectId));
  const group = useApp((s) => (groupId ? s.workspace?.groups.find((g) => g.id === groupId && g.projectId === projectId) : undefined));
  const session = useApp((s) => s.sessionsById.get(sessionId));
  const [summary, setSummary] = useState('');
  const [state, setState] = useState<'asking' | 'ready' | 'moving'>('asking');
  const [asked, setAsked] = useState(false);
  const cancel = () => (session ? openSession(session.id) : openView({ kind: 'overview' }));

  // Kestrel asks the agent to write the summary; if it cannot be asked, you write it.
  useEffect(() => {
    let live = true;
    void actions.draftSummary(sessionId, projectId).then((text) => {
      if (!live) return;
      setAsked(text !== null);
      if (text) setSummary(text);
      setState('ready');
    });
    return () => {
      live = false;
    };
  }, [sessionId, projectId]);

  const move = async () => {
    setState('moving');
    const child = await actions.moveToProject(sessionId, projectId, summary, group?.id);
    if (!child) return setState('ready');
    openSession(child.id); // in place of this page
  };

  if (!project || !session) return <div className="page column form-page"><p className="form-lede">That session or project no longer exists.</p></div>;
  return (
    <div className="page column form-page move-page">
      <div className="form-head">
        <h1>Move to {project.name}</h1>
        <p className="form-lede">“{session.title}” stays as it is, marked as handed off. A new session starts in {project.name} with this summary.</p>
      </div>
      {group && (
        <p className="move-notice" role="note">
          “{group.name}” holds only {project.name}’s sessions, so this session cannot join it as it is. Moving it starts a new session in {project.name}{worktreeNote(project)}, and that session joins the group.
        </p>
      )}
      <div className="form-field">
        <label htmlFor="move-summary">Summary for the new session</label>
        <textarea id="move-summary" className="move-summary" value={summary} disabled={state !== 'ready'} placeholder={state === 'asking' ? 'Asking the agent to write it…' : 'What the new session needs to know: the goal, what was found, what is left.'} onChange={(e) => setSummary(e.target.value)} />
        <p className="form-note">{state === 'asking' ? 'The agent is writing a summary of the work so far. You can edit it before moving.' : asked ? 'Written by the agent. Edit it if you like.' : 'The agent could not be asked, so write the summary yourself.'}</p>
      </div>
      <div className="form-actions">
        <button type="button" className="quiet-button" disabled={state === 'moving'} onClick={cancel}>
          Cancel
        </button>
        <button type="button" className="primary-button" disabled={state !== 'ready' || !summary.trim()} aria-busy={state === 'moving'} onClick={() => void move()}>
          {state === 'moving' ? 'Moving…' : 'Move'}
        </button>
      </div>
    </div>
  );
}
