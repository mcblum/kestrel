import { FolderPlus, Folders, Plus } from 'lucide-react';
import { item } from '@kestrel/server/menu';
import type { Project } from '@kestrel/server/model';
import { tildePath } from '@kestrel/server/project-search';
import { NO_FOLDER_YET, projectPath } from '@kestrel/server/project-folders';
import { runMenuAction } from '../commands.ts';
import { opener } from '../route.ts';

/** Registered projects as compact tiles: name, repository path, and a way to start in it. */
export function ProjectTiles({ projects, onAddProject, onAddFromFolder }: { projects: readonly Project[]; onAddProject: () => void; onAddFromFolder: () => void }) {
  return (
    <section className="page-section" aria-label="Projects">
      <h2>
        Projects <span className="section-count">· {projects.length}</span>
      </h2>
      <div className="tiles">
        {projects.map((p) => (
          <div className="tile" key={p.id}>
            <div className="tile-text">
              <strong>{p.name}</strong>
              <small title={projectPath(p) ?? undefined}>{projectPath(p) ? tildePath(projectPath(p)!) : NO_FOLDER_YET}</small>
            </div>
            <button className="secondary-button small" {...opener((newTab) => void runMenuAction(item.newSession({ projectId: p.id }).action!, newTab))}>
              <Plus aria-hidden /> Start session
            </button>
          </div>
        ))}
        <button className="tile tile-add" onClick={onAddProject}>
          <FolderPlus aria-hidden /> Create a project
        </button>
        <button className="tile tile-add" onClick={onAddFromFolder}>
          <Folders aria-hidden /> Add several from a folder
        </button>
      </div>
    </section>
  );
}
