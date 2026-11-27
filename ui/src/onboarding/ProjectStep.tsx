import { useState } from 'react';
import { Check, Folder, Folders } from 'lucide-react';
import { OneProjectForm } from '../pages/CreateProjectPage.tsx';
import { ProjectsFromFolder } from '../pages/ProjectsFromFolder.tsx';
import { useHereProjects } from '../awayProjects.ts';

export function ProjectStep({ onBusyChange, onEditingChange }: { onBusyChange: (busy: boolean) => void; onEditingChange: (editing: boolean) => void }) {
  const [way, setWay] = useState<'one' | 'many' | null>(null);
  const [added, setAdded] = useState(false);
  const projects = useHereProjects();
  const choose = (next: typeof way) => { setWay(next); onEditingChange(next !== null); };
  const done = () => { choose(null); setAdded(true); };
  if (way) return <div className="setup-project-form">
    <h2>{way === 'one' ? 'Add one project' : 'Add many projects'}</h2>
    {way === 'one'
      ? <OneProjectForm onCreated={done} onCancel={() => choose(null)} onBusyChange={onBusyChange} />
      : <ProjectsFromFolder onCreated={done} onCancel={() => choose(null)} onBusyChange={onBusyChange} />}
  </div>;
  return <>
    {added && <p className="setup-success" role="status"><Check aria-hidden /> Projects added. Add more, or continue when you’re ready.</p>}
    <div className="setup-choices">
      <button className="setup-choice" onClick={() => choose('one')}>
        <Folder aria-hidden /><strong>Add one</strong><span>Choose a folder for a single project.</span>
      </button>
      <button className="setup-choice" onClick={() => choose('many')}>
        <Folders aria-hidden /><strong>Add many</strong><span>Choose a parent folder, then pick the projects inside.</span>
      </button>
    </div>
    <p className="form-note">Git repositories are preselected when you add many. You choose what gets added.</p>
    {!!projects?.length && <div className="setup-project-summary">
      <span>{projects.length} project{projects.length === 1 ? '' : 's'} in your workspace</span>
      <div>{projects.slice(0, 6).map((project) => <span className="setup-project-chip" key={project.id}><Folder aria-hidden />{project.name}</span>)}{projects.length > 6 && <span className="setup-project-chip">+{projects.length - 6} more</span>}</div>
    </div>}
  </>;
}
