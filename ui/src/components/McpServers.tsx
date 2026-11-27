// Kestrel's own MCP servers (docs/designs/mcp-servers.md): the list in Settings → Agent setup (the
// default set, "Default: every session", and those kept to one project) and on a project's Settings tab
// ("This project"). Each row opens the server's page; Add a server opens a page too, never a panel.
// The list is held once in the store through useResource; a secret shows only as set or not.
import { Plus, Server } from 'lucide-react';
import type { McpServerView } from '@kestrel/server/mcp-servers';
import { KIND_LABEL } from '@kestrel/server/mcp-servers';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { opener, openView } from '../route.ts';
import { OLDER_SERVER, RESTART_REASON } from '../store.ts';
import { SettingHeading } from './SettingHelp.tsx';
import '../styles/mcp-servers.css';
import { useHereProjects } from '../awayProjects.ts';

export const MCP_SERVERS_PATH = '/api/mcp-servers';

export interface McpServerList {
  servers: McpServerView[];
  storage: 'keystore' | 'file';
}

export const asServerList = (raw: unknown): Sourced<McpServerList> => ready(raw as McpServerList);

export function useMcpServers(): Sourced<McpServerList> {
  return useResource(MCP_SERVERS_PATH, asServerList).value;
}

/** The page of one server, or Add a server (for one project when `projectId` is given). */
export const serverSection = (name: string): string => `agent-setup/mcp/${name}`;
export const addSection = (projectId?: string): string => (projectId ? `agent-setup/mcp/new/${projectId}` : 'agent-setup/mcp/new');

/** What a server's values lack, in words; null when it has them all. */
export function needsText(server: McpServerView): string | null {
  const missing = [...server.env, ...server.headers].filter((v) => !v.set).map((v) => v.key);
  return missing.length ? `Needs ${missing.join(', ')}` : null;
}

function ServerRow({ server }: { server: McpServerView }) {
  const needs = needsText(server);
  const kind = server.kind === 'stdio' ? `runs ${server.where}` : `${KIND_LABEL[server.kind]} · ${server.where}`;
  return (
    <button type="button" className="mcp-server-row" {...opener((newTab) => openView({ kind: 'settings', section: serverSection(server.name) }, newTab))}>
      <Server aria-hidden />
      <span className="mcp-server-text">
        <strong>{server.name}</strong>
        <small>
          {kind}
          {needs && <span className="mcp-server-needs"> · {needs}</span>}
          {server.cannot?.codex && <span> · not in Codex sessions (SSE only)</span>}
        </small>
      </span>
    </button>
  );
}

function AddButton({ projectId, label }: { projectId?: string; label: string }) {
  return (
    <button type="button" className="secondary-button small" {...opener((newTab) => openView({ kind: 'settings', section: addSection(projectId) }, newTab))}>
      <Plus aria-hidden />
      {label}
    </button>
  );
}

const HELP = (
  <>
    <p className="settings-help">MCP servers set up here are handed to every agent a session runs (Claude, Codex and OpenCode) when it starts. Nothing is written into an agent's own settings. Secret values are kept sealed on this computer and are never shown again after saving.</p>
    <p className="settings-help">A server for every project is in the default set: sessions in every project get it (a project can switch it off for itself below), and so do sessions with no project and reviews of somebody else's pull request. A session another session handed work to or delegated to gets the same servers as the one that started it; one it spawned for an unrelated task gets its own project's. A server for one project is only in that project's sessions.</p>
    <p className="settings-help">Codex speaks only streamable HTTP, so a server that speaks only SSE is left out of Codex sessions.</p>
  </>
);

/** Settings → Agent setup: Kestrel's own servers, above the switches. */
export function McpServersSetting() {
  const list = useMcpServers();
  const projects = useHereProjects();
  if (list.state !== 'ready') return <p className="settings-help">{list.state === 'loading' ? 'Loading…' : list.reason === RESTART_REASON ? OLDER_SERVER : list.reason}</p>;
  const every = list.value.servers.filter((s) => s.projectId === null);
  const ownByProject = projects.map((p) => ({ project: p, servers: list.value.servers.filter((s) => s.projectId === p.id) })).filter((g) => g.servers.length > 0);
  return (
    <section className="settings-section wide mcp-servers">
      <SettingHeading title="MCP servers" help={HELP} />
      <h3 className="setup-heading">Default: every session</h3>
      {every.length === 0 ? <p className="setup-none">None yet.</p> : every.map((s) => <ServerRow key={s.name} server={s} />)}
      {ownByProject.map(({ project, servers }) => (
        <div key={project.id}>
          <h3 className="setup-heading">{project.name} only</h3>
          {servers.map((s) => <ServerRow key={s.name} server={s} />)}
        </div>
      ))}
      <div className="mcp-servers-actions">
        <AddButton label="Add a server" />
      </div>
      {list.value.storage === 'file' && <p className="settings-help">This computer has no keystore Kestrel can use, so secret values are kept in a file in Kestrel's data folder that only you can read.</p>}
    </section>
  );
}

/** A project's Settings tab: the servers kept to this project. */
export function ProjectMcpServers({ projectId }: { projectId: string }) {
  const list = useMcpServers();
  if (list.state !== 'ready') return null;
  const own = list.value.servers.filter((s) => s.projectId === projectId);
  return (
    <div className="mcp-servers">
      <h3 className="setup-heading">This project</h3>
      {own.length === 0 ? <p className="setup-none">No MCP server of Kestrel's is kept to this project.</p> : own.map((s) => <ServerRow key={s.name} server={s} />)}
      <div className="mcp-servers-actions">
        <AddButton projectId={projectId} label="Add a server to this project" />
      </div>
    </div>
  );
}
