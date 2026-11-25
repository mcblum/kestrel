// Agent setup for a project: how much of the user's own Claude Code setup its sessions get.
// Their instructions and skills are on by default. Each MCP server is off until switched on
// here, because a server can reach outside services.
import { useState, type ReactNode } from 'react';
import type { McpServerInfo, ProjectSetup } from '@kestrel/server/setup';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { call, putResource } from '../store.ts';
import { SettingHeading } from './SettingHelp.tsx';

interface Loaded {
  setup: ProjectSetup;
  /** The project has no setup of its own and follows the defaults. */
  inherits: boolean;
  servers: McpServerInfo[];
}

const asLoaded = (raw: unknown): Sourced<Loaded> => ready(raw as Loaded);

const SCOPE: Record<McpServerInfo['scope'], string> = { user: 'from Claude Code, all your projects', project: 'from this project (.mcp.json)', local: 'from Claude Code, this project only', desktop: 'from the Claude desktop app', codex: 'from Codex', opencode: 'from OpenCode', kestrel: "Kestrel's own, every project" };

/**
 * The switches. With no `projectId` these are the defaults every project follows. With one, the
 * project follows the defaults until "Custom" is selected, and then has its own; while
 * it follows them only that is said (with Edit defaults), never the defaults' switches.
 */
export function ProjectSetup({ projectId, onEditDefaults, mcpHelp }: { projectId?: string; onEditDefaults?: () => void; mcpHelp?: ReactNode }) {
  const url = projectId ? `/api/projects/${encodeURIComponent(projectId)}/setup` : '/api/setup';
  // Held once in the app store; each save writes what the server stored back into it.
  const answer = useResource(url, asLoaded).value;
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const data = answer.state === 'ready' ? answer.value : null;
  const problem = saveProblem ?? (answer.state === 'unavailable' ? answer.reason || 'Could not read the setup.' : null);

  /** Each switch saves at once; what the server stored comes back and is what is shown. */
  const put = (body: object) =>
    call<Loaded>(url, { method: 'PUT', body: JSON.stringify(body) }).then(
      (d) => putResource(url, ready(d)),
      (e: unknown) => setSaveProblem(e instanceof Error ? e.message : 'Could not save.'),
    );
  const save = (next: ProjectSetup) => {
    if (data) putResource(url, ready({ ...data, setup: next, inherits: false }));
    void put(next);
  };
  /** Back onto the defaults, or onto a copy of them that this project then owns. */
  const setInherits = (inherits: boolean) => data && void put(inherits ? { inherits: true } : data.setup);
  const toggleServer = (name: string, on: boolean) => data && save({ ...data.setup, mcpServers: on ? [...data.setup.mcpServers, name] : data.setup.mcpServers.filter((n) => n !== name) });

  if (problem) return <p className="setup-problem">{problem}</p>;
  if (!data) return <p className="settings-help">Loading…</p>;
  const locked = projectId !== undefined && data.inherits;
  return (
    <div className="setup">
      {projectId !== undefined && (
        <div className="setup-source">
          <fieldset className="setup-source-options">
            <legend className="visually-hidden">Agent setup source</legend>
            <label>
              <input type="radio" name={`setup-source-${projectId}`} value="defaults" checked={data.inherits} onChange={() => setInherits(true)} />
              <span><span aria-hidden="true">App defaults</span><span>App defaults</span></span>
            </label>
            <label>
              <input type="radio" name={`setup-source-${projectId}`} value="custom" checked={!data.inherits} onChange={() => setInherits(false)} />
              <span><span aria-hidden="true">Custom</span><span>Custom</span></span>
            </label>
          </fieldset>
          {onEditDefaults && <button type="button" className="link-button" onClick={onEditDefaults}>Edit app defaults</button>}
        </div>
      )}
      {/* Following the defaults, the defaults are not shown here as if they were this project's own. */}
      {!locked && <SetupSwitches data={data} save={save} toggleServer={toggleServer} mcpHelp={mcpHelp} />}
    </div>
  );
}

/** The switches themselves: the defaults' own, or a project's own once it has its own. */
function SetupSwitches({ data, save, toggleServer, mcpHelp }: { data: Loaded; save: (next: ProjectSetup) => void; toggleServer: (name: string, on: boolean) => void; mcpHelp?: ReactNode }) {
  return (
    <fieldset className="setup-fields">
      <label className="setup-row">
        <input type="checkbox" checked={data.setup.loadSettings} onChange={(e) => save({ ...data.setup, loadSettings: e.target.checked })} />
        <span>
          <strong>Your Claude Code settings</strong>
          <small>CLAUDE.md (yours and the project's), skills, slash commands, hooks and permission rules.</small>
        </span>
      </label>
      {mcpHelp ? <SettingHeading level={3} className="setup-heading" title="MCP servers switched on" help={mcpHelp} /> : <h3 className="setup-heading">MCP servers switched on</h3>}
      {data.servers.length === 0 ? (
        <p className="setup-none">No MCP servers are set up in Kestrel, Claude Code, the Claude desktop app, Codex or OpenCode.</p>
      ) : (
        data.servers.map((server) => (
          <label className="setup-row" key={server.name}>
            <input type="checkbox" checked={data.setup.mcpServers.includes(server.name)} onChange={(e) => toggleServer(server.name, e.target.checked)} />
            <span>
              <strong>{server.name}</strong>
              <small>
                {server.kind === 'stdio' ? `runs ${server.where}` : `connects to ${server.where}`} · {SCOPE[server.scope]}
              </small>
            </span>
          </label>
        ))
      )}
    </fieldset>
  );
}
