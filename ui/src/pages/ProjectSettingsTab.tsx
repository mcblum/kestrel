// Project settings sections are selected by route, including direct links to folders.
import { SaveBar } from '../components/SaveBar.tsx';
import { SettingHeading } from '../components/SettingHelp.tsx';
import type { Project } from '@kestrel/server/model';
import type { ProjectSection } from '@kestrel/server/routes';
import { ProjectFolders } from '../components/ProjectFolders.tsx';
import { ProjectNameField } from '../components/ProjectNameField.tsx';
import { EnvSetting } from '../components/EnvSetting.tsx';
import { ReviewRequestsSetting } from '../components/ReviewRequestsSetting.tsx';
import { CleanupPolicySetting } from '../components/CleanupPolicySetting.tsx';
import { GitDefaultsSetting } from '../components/GitDefaultsSetting.tsx';
import { SavedActionsSetting } from '../components/SavedActionsSetting.tsx';
import { ProjectScriptsSetting } from '../components/ProjectScriptsSetting.tsx';
import { ProjectSetup } from '../components/ProjectSetup.tsx';
import { StartBaseSetting } from '../components/StartBaseSetting.tsx';
import { ConnectKeepOffSwitch } from '../components/ConnectHeldSetting.tsx';
import { openView, showLocal } from '../route.ts';
import { projectSettings } from '@kestrel/server/routes';
import { SettingsLayout, type SettingsItem } from '../components/SettingsLayout.tsx';

const sectionId = (projectId: string, section: ProjectSection) => `project-${projectId}-${section}`;

export function ProjectSettingsTab({ project, section }: { project: Project; section?: ProjectSection }) {
  const heading = (s: ProjectSection) => `${sectionId(project.id, s)}-heading`;
  const sections: SettingsItem<ProjectSection>[] = [
    { id: 'general', label: 'General', content: (
      <section className="settings-block" aria-labelledby={heading('general')}>
        <h2 id={heading('general')}>General</h2>
        <ProjectNameField projectId={project.id} name={project.name} />
        <StartBaseSetting project={project} />
        <ConnectKeepOffSwitch projectId={project.id} projectName={project.name} />
      </section>
    ) },
    { id: 'folders', label: 'Folders', content: <ProjectFolders project={project} headingId={heading('folders')} /> },
    { id: 'git', label: 'Git', content: (
      <section className="settings-block" aria-labelledby={heading('git')}>
        <SettingHeading id={heading('git')} title="Git" help={<p>Which branch {project.name}'s work is based on, and which remote it comes from, whatever the project's folder happens to have checked out. The app-wide Git settings (branch names, starting from the latest base) are in Settings → Git.</p>} />
        <GitDefaultsSetting key={project.id} project={project} />
        {project.folders.some((f) => f.isGit) && <CleanupPolicySetting key={`cleanup-${project.id}`} scope={project.id} />}
        {project.folders.some((f) => f.isGit) && <ReviewRequestsSetting projectId={project.id} />}
      </section>
    ) },
    { id: 'actions', label: 'Actions', content: (
      <section className="settings-block" aria-labelledby={heading('actions')}>
        <SettingHeading id={heading('actions')} title="Actions" help={<><p>Commands you run often in {project.name}: a dev server, the tests, a build. Run one from the ▶ button at the top of the Terminal pane, in any of the project's sessions or on the project's own page. Each runs in a terminal of its own, named after it, and gets the project's environment variables.</p><p>The folder is relative to where the terminal opens (a session's worktree); leave it empty for that folder itself. With a preview address, the browser pane opens there once the address answers.</p></>} />
        <SavedActionsSetting key={project.id} project={project} />
      </section>
    ) },
    { id: 'scripts', label: 'Scripts', content: (
      <section className="settings-block" aria-labelledby={heading('scripts')}>
        <SettingHeading id={heading('scripts')} title="Scripts" help={<p>Commands Kestrel runs for each session in {project.name}: one when its worktree is made, one before it is archived. Only you can change them here; an agent cannot.</p>} />
        <ProjectScriptsSetting key={project.id} project={project} />
      </section>
    ) },
    { id: 'environment', label: 'Environment', content: (
      <section className="settings-block" aria-labelledby={heading('environment')}>
        <SettingHeading id={heading('environment')} title="Environment" help={<p>What sessions in {project.name} get on top of the app-wide environment in Settings → Environment: variables, .env files, and files copied into each new worktree. Only you can change them here; an agent cannot.</p>} />
        <EnvSetting key={project.id} scope={project.id} />
      </section>
    ) },
    { id: 'agent-setup', label: 'Agent setup', content: (
      <section className="settings-block" aria-labelledby={heading('agent-setup')}>
        <SettingHeading id={heading('agent-setup')} title="Agent setup" help={<p>What sessions in {project.name} get from your own agent setup. Choose App defaults to follow your shared setup, or Custom to configure this project separately. Switching back restores your app defaults. Changes apply to sessions started from now on.</p>} />
        <ProjectSetup key={project.id} projectId={project.id} onEditDefaults={() => openView({ kind: 'settings', section: 'agent-setup' })} />
      </section>
    ) },
  ];
  return (
    <div className="project-settings">
      <SettingsLayout label="Project settings sections" sections={sections} active={section ?? 'general'} onSelect={(next) => showLocal(projectSettings(project.id, next))} />
      <SaveBar watch={section ?? 'general'} sticky />
    </div>
  );
}
