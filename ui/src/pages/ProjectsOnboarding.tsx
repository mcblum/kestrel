// First run, before any project: the Overview offers to add the user's projects in one step, from the
// folder that holds them, leading to Create project's "Several from a folder". One project at a time
// stays one click away. Grey, like the starter beside it.
import { Folders } from 'lucide-react';
import { opener } from '../route.ts';
import { openCreateProject } from '../projectNav.ts';

export function ProjectsOnboarding() {
  return (
    <section className="onboard-projects" aria-label="Add your projects">
      <Folders className="onboard-icon" aria-hidden />
      <div className="onboard-text">
        <h2>Add your projects</h2>
        <p>Choose the folder that holds them, such as ~/Code, and tick the ones to add. Git repositories are ticked for you.</p>
      </div>
      <div className="onboard-actions">
        <button type="button" className="quiet-button" {...opener((newTab) => openCreateProject(newTab))}>
          One project
        </button>
        <button type="button" className="primary-button" {...opener((newTab) => openCreateProject(newTab, true))}>
          Add from a folder
        </button>
      </div>
    </section>
  );
}
