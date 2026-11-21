import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { ArrowRight, Bird, X } from 'lucide-react';
import type { SessionView, WorkspaceState } from '@kestrel/server/model';
import { activityDayKey, activityGarden } from '@kestrel/server/overview';
import { opener, openSession } from '../route.ts';
import './activity-garden.css';

const dateLabel = (date: Date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const countLabel = (count: number) => `${count} session${count === 1 ? '' : 's'} finished`;
type Selection = { kind: 'day' | 'project'; key: string };

export function ActivityGarden({ workspace }: { workspace: WorkspaceState }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const { days, total } = useMemo(() => activityGarden([...workspace.sessions, ...workspace.archived.sessions], now), [workspace.sessions, workspace.archived.sessions, now]);
  const projects = useMemo(() => {
    const names = new Map([...workspace.projects, ...workspace.archived.projects].map(p => [p.id, p.name]));
    const grouped = new Map<string, { key: string; name: string; sessions: SessionView[] }>();
    for (const session of days.flatMap(day => day.sessions)) {
      const id = session.filing.projectId;
      const key = id ? `project:${id}` : 'unscoped';
      const group = grouped.get(key) ?? { key, name: id ? names.get(id) ?? 'Unknown project' : 'No project', sessions: [] };
      group.sessions.push(session);
      grouped.set(key, group);
    }
    const sorted = [...grouped.values()].sort((a, b) => b.sessions.length - a.sessions.length || a.name.localeCompare(b.name));
    return sorted;
  }, [days, workspace.projects, workspace.archived.projects]);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const today = activityDayKey(now);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const pickedDay = selected?.kind === 'day' ? days.find(day => day.key === selected.key) : undefined;
  const pickedProject = selected?.kind === 'project' ? projects.find(project => project.key === selected.key) : undefined;
  const picked = pickedDay ? { name: dateLabel(pickedDay.date), sessions: pickedDay.sessions } : pickedProject;
  const preview = days.find(day => day.key === (hovered ?? focused)) ?? pickedDay;
  const tabDay = days.some(day => day.key === focused) ? focused : today;
  const select = (kind: Selection['kind'], key: string) => setSelected(selected?.kind === kind && selected.key === key ? null : { kind, key });
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -15, ArrowDown: 15, Home: -index, End: days.length - 1 - index };
    if (!(event.key in offsets)) return;
    event.preventDefault();
    const target = days[Math.max(0, Math.min(days.length - 1, index + offsets[event.key]!))]!;
    event.currentTarget.closest('.activity-garden-grid')?.querySelector<HTMLButtonElement>(`[data-day="${target.key}"]`)?.focus();
  };
  return (
    <section className="activity-garden" aria-labelledby="activity-garden-title">
      <div className="activity-garden-summary">
        <h2 id="activity-garden-title"><Bird aria-hidden /> Last 30 days</h2>
        <p><strong>{total}</strong> session{total === 1 ? '' : 's'} finished</p>
      </div>
      <div className="activity-garden-calendar">
        <div className="activity-garden-caption"><span>Daily activity</span><span>{dateLabel(days[0]!.date)} – Today</span></div>
        <div className="activity-garden-grid" role="group" aria-label="Finished sessions over the last 30 days. Two rows of fifteen days, oldest first. Use arrow keys to explore days, Enter to view sessions.">
          {days.map((day, index) => <button key={day.key} type="button" className="activity-garden-day" data-level={day.level} data-day={day.key} data-today={day.key === today || undefined}
            tabIndex={day.key === tabDay ? 0 : -1} aria-label={`${dateLabel(day.date)}: ${countLabel(day.sessions.length)}`} aria-pressed={selected?.kind === 'day' && selected.key === day.key}
            title={`${dateLabel(day.date)} · ${countLabel(day.sessions.length)}`} onMouseEnter={() => setHovered(day.key)} onMouseLeave={() => setHovered(null)}
            onFocus={() => setFocused(day.key)} onBlur={() => setFocused(null)} onKeyDown={event => move(event, index)} onClick={() => select('day', day.key)} />)}
        </div>
        {preview && <p className="activity-garden-day-detail">{dateLabel(preview.date)} · {countLabel(preview.sessions.length)}</p>}
      </div>
      <div className="activity-garden-projects">
        <div className="activity-garden-caption"><span>By project</span>
          {projects.length > 3 && <button type="button" className="link-button activity-garden-project-more" aria-label={showAllProjects ? 'Show fewer projects' : `Show ${projects.length - 3} more projects`} aria-expanded={showAllProjects} aria-controls="activity-garden-project-list" onClick={() => setShowAllProjects(!showAllProjects)}>
            {showAllProjects ? 'Show fewer' : `+${projects.length - 3} more`}
          </button>}
        </div>
        <div className="activity-garden-project-list" id="activity-garden-project-list" role="group" aria-label="Finished sessions by project over the last 30 days">
          {(showAllProjects ? projects : projects.slice(0, 3)).map(project => <button type="button" className="activity-garden-project-row" key={project.key}
            title={`${project.name} · ${countLabel(project.sessions.length)}`} aria-label={`${project.name}: ${countLabel(project.sessions.length)}`}
            aria-pressed={selected?.kind === 'project' && selected.key === project.key} onClick={() => select('project', project.key)}>
            <span className="activity-garden-project-name">{project.name}</span>
            <span className="activity-garden-project-track" aria-hidden><span style={{ width: `${project.sessions.length / total * 100}%` }} /></span>
            <b>{project.sessions.length}</b>
          </button>)}
          {projects.length === 0 && <p className="activity-garden-detail">Your finished work will appear here.</p>}
        </div>

      </div>
      {picked && <div className="activity-garden-selection">
        <div className="activity-garden-selection-heading"><h3>{picked.name} <span>· {countLabel(picked.sessions.length)}</span></h3><button type="button" aria-label="Close activity details" onClick={() => setSelected(null)}><X aria-hidden /></button></div>
        {picked.sessions.length ? <ul>{picked.sessions.map(session => <li key={session.id}><button type="button" {...opener(newTab => openSession(session.id, newTab))}><span>{session.title}</span><ArrowRight aria-hidden /></button></li>)}</ul> : <p>No sessions finished on this day.</p>}
      </div>}
    </section>
  );
}
