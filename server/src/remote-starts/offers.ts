// What this computer offers for a new session started from another device: one function builds it, for the
// live answer (`session.startChoices`, connect/dispatcher.ts) and for the computer's `offers` record on Kestrel
// Connect (connect/link/offers-sync.ts), so the two never disagree (kestrel-connect.md, "What a computer
// offers, as built"). Every string is cleaned (shared/machine-offers.ts) before either leaves the computer.
import { homedir, userInfo } from 'node:os';
import type { Agent, Project } from '../model.ts';
import type { SessionRuntime } from '../runtime.ts';
import { cleanOffers } from '../shared/machine-offers.ts';
import type { KestrelKind } from '../shared/host-kind.ts';
import { offeredClones } from '../shared/project-clone.ts';
import { defaultFolder, folderName } from '../shared/project-folders.ts';
import type { ModelPreset } from '../shared/who-does-what.ts';
import type { Workspace } from '../workspace.ts';
import { remoteStartsOff } from './prefs.ts';
import { rememberedSignature, remoteStartChoices, type AgentModels, type RemoteStartChoices, type RemoteStartProject } from './session-start.ts';

/** Everything but the agents: cheap to read, read on every pass. */
export interface OffersSettings {
  allowed: boolean;
  presets: ModelPreset[];
  uiState: string | null;
  /** The projects as the window lists them: this computer's, and on a worker node also the account's it does not have. */
  projects: readonly Project[];
}

/** Where the offers are read from, so a test can stand in for the runtime. */
export interface OffersSource {
  /** How refusals name this computer ("your Mac"). */
  here: string;
  /** The home folder, written as `~` in anything sent. */
  home: string;
  /** This computer's user name, never in anything sent. */
  user: string;
  /** A worker node also offers the account's projects it does not have, cloned when a session starts in one (item 64). */
  kind?: KestrelKind;
  settings(): Promise<OffersSettings>;
  /** Each agent: whether it can start now, and its model list. Asks the agents (their answers are cached a minute). */
  agents(): Promise<AgentModels[]>;
}

/**
 * Each agent here: whether it can start now, as the New session box judges it, and the one model list kept for it.
 * `only`: that agent alone (a start checks the agent it names and wakes no other). `withModels` false: whether it can
 * start, without asking its models.
 */
export async function agentModels(runtime: Pick<SessionRuntime, 'agentAvailability' | 'availableAgents' | 'models'>, only?: Agent, withModels = true): Promise<AgentModels[]> {
  const { available, notes } = await runtime.agentAvailability();
  return Promise.all(
    runtime.availableAgents().filter((agent) => only === undefined || agent === only).map(async (agent: Agent): Promise<AgentModels> => {
      if (!available.includes(agent)) return { agent, available: false, models: [], ...(notes[agent] ? { reason: notes[agent] } : {}) };
      const { models } = withModels ? await runtime.models(agent).catch(() => ({ models: [] })) : { models: [] };
      return { agent, available: true, models };
    }),
  );
}

/** The signed-in user's name on this computer, or '' where the system will not say. */
function userName(): string {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

export function offersSource(runtime: SessionRuntime, workspace: Workspace, here: string, home: string = homedir(), user: string = userName(), kind: KestrelKind = 'app'): OffersSource {
  return {
    here,
    home,
    user,
    kind,
    async settings() {
      const [{ allowed }, { presets }, uiState, state] = await Promise.all([runtime.remoteStarts.prefs(), runtime.whoDoesWhat.current(), workspace.getUiState(), kind === 'node' ? workspace.view() : workspace.state()]);
      return { allowed, presets, uiState, projects: state.projects };
    },
    agents: () => agentModels(runtime),
  };
}

/**
 * Watches a value read on each event, and calls `changed` only when it reads differently from last time. One read
 * at a time: events during a read are one more read after it. The first read only sets what "before" is.
 */
function onDifference(read: () => Promise<string>, changed: () => void): () => void {
  let last: string | null = null;
  let reading = false;
  let again = false;
  let closed = false;
  const check = (): void => {
    if (closed) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    read()
      .then((now) => {
        if (last !== null && now !== last && !closed) changed();
        last = now;
      })
      .catch(() => undefined)
      .finally(() => {
        reading = false;
        if (again) {
          again = false;
          check();
        }
      });
  };
  check();
  return check;
}

/** What of the projects the offers list, as text: the same for a write that changed only a session. */
export const projectsSignature = (projects: readonly Project[], kind: KestrelKind = 'app'): string => JSON.stringify([projects.filter((p) => !p.away).map(offeredProject), kind === 'node' ? offeredClones(projects, []) : []]);

/**
 * What tells that the offers may have changed: an agent's answer (`agents`), the presets, the switch, the New
 * session box's remembered choices, and the projects. A write of the UI state or of the workspace calls back only
 * when the part the offers are made from reads differently (`rememberedSignature`, `projectsSignature`), so a
 * streaming session or a moved tab schedules nothing. Returns the undo.
 */
export function offersWatch(runtime: SessionRuntime, workspace: Workspace, kind: KestrelKind = 'app'): (changed: (agents: boolean) => void) => () => void {
  return (changed) => {
    let closed = false;
    const other = () => !closed && changed(false);
    // A worker node's offers name the account's projects it could clone too: read from the view, which has them.
    const projects = onDifference(async () => projectsSignature((kind === 'node' ? await workspace.view() : await workspace.state()).projects, kind), other);
    const box = onDifference(async () => rememberedSignature(await workspace.getUiState()), other);
    const offs = [runtime.onAgentsChange(() => !closed && changed(true)), runtime.whoDoesWhat.onChange(other), runtime.remoteStarts.onChange(other), workspace.onUiState(box), workspace.onChange(projects)];
    return () => {
      closed = true;
      offs.forEach((off) => off());
    };
  };
}

/** A project as a device picks it: names only, never a path. */
export function offeredProject(project: Project): RemoteStartProject {
  return { id: project.id, name: project.name, folders: project.folders.map((f) => ({ id: f.id, name: folderName(f) })), defaultFolderId: defaultFolder(project)?.id ?? null };
}

/**
 * What this computer offers: the live answer and the record alike. Projects kept off Kestrel Connect are left out. On
 * a worker node, the account's projects it does not have and could clone follow its own, marked `clone`. Pure.
 */
export function offersOf(source: Pick<OffersSource, 'here' | 'home' | 'user' | 'kind'>, settings: OffersSettings, agents: readonly AgentModels[], keptOff: readonly string[]): RemoteStartChoices {
  const off = new Set(keptOff);
  const own = settings.projects.filter((p) => !p.away && !off.has(p.id)).map(offeredProject);
  const projects = source.kind === 'node' ? [...own, ...offeredClones(settings.projects, keptOff)] : own;
  const offers = remoteStartChoices(source.here, settings.allowed, remoteStartsOff(source.here), settings.presets, settings.uiState, agents, projects);
  return cleanOffers(offers, { home: source.home, user: source.user });
}

/** Read now, agents and all. */
export async function offersNow(source: OffersSource, keptOff: readonly string[]): Promise<RemoteStartChoices> {
  const [settings, agents] = await Promise.all([source.settings(), source.agents()]);
  return offersOf(source, settings, agents, keptOff);
}
