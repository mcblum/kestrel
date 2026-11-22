// Settings → Colours (shared/colours.ts; colours.ts): the colour of each project, tag and workstream, picked from one short muted palette with one circle each (ColourPicker.tsx). Each pick saves at once, as a
// switch does; nothing here is typed.
import { useMemo } from 'react';
import { FolderGit2, Tag, Waypoints } from 'lucide-react';
import { projectColour, tagColour, workstreamColour } from '@kestrel/server/colours';
import { tagCounts } from '@kestrel/server/tags';
import { setProjectColour, setTagColour, setWorkstreamColour, setWorkstreamColours, useColours } from '../colours.ts';
import { useApp } from '../store.ts';
import { ColourPicker } from './ColourPicker.tsx';
import { SettingHeading, SettingSection } from './SettingHelp.tsx';

function WorkstreamColours() {
  const workstreams = useApp((s) => s.workspace?.workstreams);
  const on = useColours().workstreamColours;
  return (
    <SettingSection title="Workstreams" help={<p className="settings-help">A workstream's colour is used for its icon and the line down the side of its sessions under WORKSTREAMS, and for its chip on a session. A new workstream is given the colour the fewest others have; change it here or on its page.</p>}>
      <label className="tag-rule-switch">
        <input type="checkbox" checked={on} onChange={(e) => void setWorkstreamColours(e.target.checked)} />
        Colour workstreams
      </label>
      {!on ? null : !workstreams || workstreams.length === 0 ? (
        <p className="settings-help">There are no workstreams yet.</p>
      ) : (
        <div className="colour-rows">
          {workstreams.map((workstream) => [
            <span key={`${workstream.id}-name`} className="colour-name" title={workstream.name}>
              <Waypoints aria-hidden />
              {workstream.name}
            </span>,
            <WorkstreamColourPicker key={workstream.id} workstreamId={workstream.id} name={workstream.name} />,
          ])}
        </div>
      )}
    </SettingSection>
  );
}

/** A workstream's colour, as one circle: in the corner of the workstream's page. */
export function WorkstreamColourPicker({ workstreamId, name }: { workstreamId: string; name: string }) {
  const colours = useColours();
  // Workstreams not coloured (the switch in Settings → Colours): no circle to pick from.
  if (!colours.workstreamColours) return null;
  return <ColourPicker label={`Colour of the workstream ${name}`} value={workstreamColour(colours, workstreamId)} onPick={(picked) => void setWorkstreamColour(workstreamId, picked)} />;
}

function TagColours() {
  const sessions = useApp((s) => s.workspace?.sessions);
  const tags = useMemo(() => (sessions ? tagCounts(sessions) : []), [sessions]);
  return (
    <SettingSection title="Tags" help={<p className="settings-help">A tag's colour is used for its icon and guide line under TAGS, and for its chip on a session.</p>}>
      {tags.length === 0 ? (
        <p className="settings-help">No session has a tag yet.</p>
      ) : (
        <div className="colour-rows">
          {tags.map(({ tag }) => [
            <span key={`${tag}-name`} className="colour-name" title={tag}>
              <Tag aria-hidden />
              {tag}
            </span>,
            <TagColourPicker key={tag} tag={tag} />,
          ])}
        </div>
      )}
    </SettingSection>
  );
}

/** A tag's colour, as one circle: in the corner of the tag's page (Matt, 2026-11-22). */
export function TagColourPicker({ tag }: { tag: string }) {
  const colours = useColours();
  return <ColourPicker label={`Colour of the tag ${tag}`} value={tagColour(colours, tag)} onPick={(picked) => void setTagColour(tag, picked)} />;
}

/** A project's colour, as one circle: in the corner of the project's page. */
export function ProjectColourPicker({ projectId, name }: { projectId: string; name: string }) {
  const colours = useColours();
  return <ColourPicker label={`Colour of the project ${name}`} value={projectColour(colours, projectId)} onPick={(picked) => void setProjectColour(projectId, picked)} />;
}

function ProjectColours() {
  const projects = useApp((s) => s.workspace?.projects);
  return (
    <SettingSection title="Projects" help={<p className="settings-help">A project's colour is used for its icon and the line down the side of its sessions.</p>}>
      {!projects || projects.length === 0 ? (
        <p className="settings-help">There are no projects yet.</p>
      ) : (
        <div className="colour-rows">
          {projects.map((project) => [
            <span key={`${project.id}-name`} className="colour-name" title={project.name}>
              <FolderGit2 aria-hidden />
              {project.name}
            </span>,
            <ProjectColourPicker key={project.id} projectId={project.id} name={project.name} />,
          ])}
        </div>
      )}
    </SettingSection>
  );
}

export function ColoursSetting() {
  return (
    <>
      <SettingHeading
        level={1}
        title="Colours"
        help={<p className="settings-help">A colour says where a row belongs, so you can find things at a glance. It never colours a title, and status is still the dot at a row's end. A project's, tag's or workstream's colour is its icon and the line down the side of its sessions.</p>}
      />
      <ProjectColours />
      <TagColours />
      <WorkstreamColours />
    </>
  );
}
