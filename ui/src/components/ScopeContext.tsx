// Context for a project page or a group page, in the same compact lines as a session's.
import { Folder, FolderGit2, GitBranch, Layers, MessagesSquare } from 'lucide-react';
import type { Group, Project, SessionView } from '@kestrel/server/model';
import { projectName } from '../labels.ts';
import { useApp } from '../store.ts';
import { baseOf, Line, parentOf } from './ContextLines.tsx';
import { useProjectChanges } from './ProjectChanges.tsx';
import { AddFolderLink } from './AddFolderLink.tsx';
import { defaultFolder, NO_FOLDER_YET } from '@kestrel/server/project-folders';

const sessionsLine = (n: number) => `${n} ${n === 1 ? 'session' : 'sessions'}`;

/** A project: its directories (git or plain), the default one's branch, how many sessions it has. */
export function ProjectContext({ project, sessions }: { project: Project; sessions: number }) {
  const { changes } = useProjectChanges(project.id, 0);
  const home = defaultFolder(project);
  const many = project.folders.length > 1;
  return (
    <div className="context-content">
      <h3>Project</h3>
      {!home && <Line icon={Folder} text={NO_FOLDER_YET} detail="sessions work in a scratch folder" />}
      {!home && <AddFolderLink projectId={project.id} />}
      {project.folders.map((f) => (
        <Line key={f.id} icon={f.isGit ? FolderGit2 : Folder} text={baseOf(f.path)} detail={`${parentOf(f.path)}${many && f === home ? ' · default' : ''}${f.isGit ? '' : ' · plain folder'}`} copy={f.path} label="folder path" />
      ))}
      {changes?.branch && <Line icon={GitBranch} text={changes.branch} detail={many && home ? `in ${baseOf(home.path)}` : undefined} copy={changes.branch} label="branch name" />}
      <div className="ctx-rule" />
      <h3>Sessions</h3>
      <Line icon={MessagesSquare} text={sessionsLine(sessions)} />
    </div>
  );
}

/** A group: its name, how many sessions, and the projects those sessions touch. */
export function GroupContext({ group, sessions }: { group: Group; sessions: readonly SessionView[] }) {
  const projects = useApp((s) => s.workspace?.projects) ?? [];
  const touched = [...new Set(sessions.map((s) => projectName(s, projects)))].sort((a, b) => a.localeCompare(b));
  return (
    <div className="context-content">
      <h3>Group</h3>
      <Line icon={Layers} text={group.name} detail={group.auto ? 'created by a delegate' : 'group'} />
      <Line icon={MessagesSquare} text={sessionsLine(sessions.length)} />
      <Line icon={Folder} text="No folder" detail="terminals open in your home folder" />
      {touched.length > 0 && (
        <>
          <div className="ctx-rule" />
          <h3>Projects</h3>
          {touched.map((name) => (
            <Line key={name} icon={FolderGit2} text={name} />
          ))}
        </>
      )}
    </div>
  );
}
