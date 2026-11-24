// What the agents can tell without running a turn: which can start now, the models each offers, the
// controls under the message box, what "/" offers (before a session exists, and for one opened
// without a list), and how full a session's context window is. Each answer that is slow to get is
// asked once and shared. Moved out of runtime.ts as it was (0.0.18).
import type { AgentSignIn } from '../agents/sign-in.ts';
import type { AgentCapabilities, ModelOption } from '../agents/types.ts';
import { AGENT_LABEL, type Agent, type Session } from '../model.ts';
import { contextNote, type ContextUsage } from '../shared/context-usage.ts';
import { DEFAULT_PERMISSION, PERMISSION_LEVELS } from '../shared/permissions.ts';
import { defaultFolder, folderOf } from '../shared/project-folders.ts';
import type { SlashCommand } from '../shared/slash-commands.ts';
import { Refused } from '../workspace.ts';
import { noteContext } from './events.ts';
import type { RuntimeHost } from './host.ts';
import { isWorking, type Live } from './record.ts';
import { agentStartOptions } from './start-options.ts';

/** Stands in for a session id where one is asked for before the session exists (the new-session box's slash commands). */
const DRAFT_SESSION = 'draft';

/** A session's context window as a device shows it: the measurement, or the words in its place. */
export type ContextShown = { context: ContextUsage; contextNote?: undefined } | { context: null; contextNote: string };

export interface ModelList {
  models: ModelOption[];
  fromSdk: boolean;
}

/** GET /api/agents. */
export interface AgentAvailability {
  available: Agent[];
  notes: Partial<Record<Agent, string>>;
  signIn: Agent[];
}

export type AgentInfoHost = Pick<RuntimeHost, 'workspace' | 'adapters' | 'emitLive' | 'onEvent' | 'scratch' | 'toolHost' | 'optionsFor' | 'sessionOrThrow' | 'recordFor' | 'now'>;

/**
 * How long a model list is kept before the agent is asked again. What an agent offers follows how
 * it is signed in and configured (Codex pointed at a cloud provider, then at a ChatGPT sign-in), and
 * that can change while Kestrel runs: kept for the whole run, the picker showed the old list until a restart.
 */
export const MODELS_TTL_MS = 5 * 60_000;

export class AgentInfo {
  /** The models an agent offers, and when it said so. Kept for `MODELS_TTL_MS` once it has answered from the SDK. */
  private readonly modelCache = new Map<Agent, { at: number; list: ModelList }>();
  /** What "/" offers before a session exists, by agent and folder: asked once per server run, and again only after it could not say. */
  private readonly draftSlash = new Map<string, Promise<SlashCommand[] | null>>();
  /** A context measurement being asked of a session's agent, so a second click waits for the first answer. */
  private readonly contextAsks = new Map<string, Promise<ContextUsage | null>>();

  constructor(private readonly host: AgentInfoHost) {}

  /** Which agents Kestrel has an adapter for. Whether one can start right now is `availability`. */
  agents(): Agent[] {
    return Object.keys(this.host.adapters) as Agent[];
  }

  /**
   * Which agents can start a session now (installed, signed in), and for the others why not.
   * `signIn`: the ones that are not signed in and that Kestrel can sign in from here.
   */
  async availability(): Promise<AgentAvailability> {
    const checked = await Promise.all(
      this.agents().map(async (agent) => {
        const adapter = this.host.adapters[agent]!;
        const answer: { available: boolean; reason?: string; signIn?: boolean } = adapter.availability ? await adapter.availability().catch((error: unknown) => ({ available: false, reason: error instanceof Error ? error.message : String(error) })) : { available: true };
        return { agent, ...answer, signIn: Boolean(answer.signIn && adapter.signIn) };
      }),
    );
    return {
      available: checked.filter((c) => c.available).map((c) => c.agent),
      notes: Object.fromEntries(checked.filter((c) => !c.available && c.reason).map((c) => [c.agent, c.reason])) as Partial<Record<Agent, string>>,
      signIn: checked.filter((c) => !c.available && c.signIn).map((c) => c.agent),
    };
  }

  /** The agent's sign-in, for the routes that start, follow and cancel one. Refused where Kestrel cannot do it. */
  signIn(agent: Agent): AgentSignIn {
    const adapter = this.host.adapters[agent];
    if (!adapter) throw new Refused(`${AGENT_LABEL[agent]} is not available in Kestrel.`);
    if (!adapter.signIn) throw new Refused(`Kestrel cannot sign ${AGENT_LABEL[agent]} in: it signs in to a model provider chosen in its own prompt. Run its sign-in command in a terminal.`);
    return adapter.signIn;
  }

  async models(agent: Agent): Promise<ModelList> {
    const adapter = this.host.adapters[agent];
    if (!adapter) throw new Refused(`${AGENT_LABEL[agent]} is not available in Kestrel.`);
    const cached = this.modelCache.get(agent);
    if (cached && this.host.now() - cached.at < MODELS_TTL_MS) return cached.list;
    const found = await adapter.models();
    // An agent that answered with nothing but its Default entry did not list its models (the
    // listing failed or came back empty while the agent itself was reachable): that is not an
    // answer to keep, and the page is told the agent has not listed them, so it asks again
    // instead of the picker holding one option until Kestrel restarts.
    const listed = found.fromSdk && found.models.some((m) => m.id !== '');
    if (listed) {
      this.modelCache.set(agent, { at: this.host.now(), list: found });
      return found;
    }
    // It could not say this time: the last list it gave still stands; with none, what it has, as unknown.
    return cached?.list ?? { ...found, fromSdk: false };
  }

  /**
   * The slash commands a new session in this project would offer, for the new-session box: the
   * agent is asked without running a turn, with the project's own setup (its skills and commands),
   * in the project's folder. Nothing is made for it: no session, worktree or attachment folder.
   * Empty when the agent lists none or cannot say.
   */
  async draftSlashCommands(agent: Agent, projectId: string | null, folderId: string | null): Promise<SlashCommand[]> {
    const { workspace } = this.host;
    const adapter = this.host.adapters[agent];
    if (!adapter) throw new Refused(`${AGENT_LABEL[agent]} is not available in Kestrel.`);
    if (!adapter.slashCommands) return [];
    const project = projectId ? ((await workspace.state()).projects.find((p) => p.id === projectId) ?? null) : null;
    if (projectId && !project) throw new Refused(`No such project: ${projectId}`);
    // The folder chosen in the box, or the project's default: where a session started there would work.
    const folder = project ? (folderOf(project, folderId) ?? defaultFolder(project)) : null;
    const directory = folder?.path ?? this.host.scratch();
    const key = `${agent}\n${directory}`;
    const held = this.draftSlash.get(key);
    if (held) return (await held) ?? [];
    const asked = agentStartOptions(workspace, { sessionId: DRAFT_SESSION, directory, branch: null, project, folder, settings: { model: '', permission: project ? DEFAULT_PERMISSION : 'readonly' }, tools: this.host.toolHost(DRAFT_SESSION), browserElement: () => null })
      .then((options) => adapter.slashCommands!(options))
      .catch(() => null);
    this.draftSlash.set(key, asked);
    const commands = await asked;
    // It could not say (not installed, not signed in): ask again next time, not never.
    if (!commands) this.draftSlash.delete(key);
    return commands ?? [];
  }

  /** What an agent offers for the controls under the message box (agents/types.ts, AgentCapabilities). */
  async capabilities(agent: Agent): Promise<AgentCapabilities> {
    const adapter = this.host.adapters[agent];
    if (!adapter) throw new Refused(`${agent} is not connected yet.`);
    const { models, fromSdk } = await this.models(agent);
    return { models, fromSdk, permissions: adapter.permissions ?? PERMISSION_LEVELS.map((l) => l.id), contextUsage: typeof adapter.contextUsage === 'function' };
  }

  /**
   * How full a session's context window is: the measurement taken as its last turn ended, or, for
   * a session that has not run a turn since the server started, the agent asked once without
   * running a turn. Null while it cannot be known: no agent conversation yet, a turn running with
   * nothing measured, or an agent that cannot say.
   */
  async contextUsage(sessionId: string): Promise<ContextUsage | null> {
    const session = await this.host.sessionOrThrow(sessionId);
    const rec = await this.host.recordFor(session);
    if (!rec) return null;
    if (rec.context || isWorking(rec) || !rec.agentSessionId) return rec.context;
    const adapter = this.host.adapters[session.agent];
    if (!adapter?.contextUsage) return null;
    // One question at a time per session: a second click waits for the first answer.
    let asking = this.contextAsks.get(sessionId);
    if (!asking) {
      const agentSessionId = rec.agentSessionId;
      asking = this.host.optionsFor(session, rec, false).then((options) => adapter.contextUsage!(agentSessionId, options)).catch(() => null);
      this.contextAsks.set(sessionId, asking);
      void asking.finally(() => this.contextAsks.delete(sessionId));
    }
    const usage = await asking;
    // A turn that ended meanwhile measured it more recently.
    if (usage && !rec.context) noteContext(this.host, session.id, rec, usage);
    return rec.context;
  }

  /**
   * How full the window is, as every device shows it (kestrel-connect.md, "The context window, and
   * Compact"): the measurement `contextUsage` gives, or, when there is none, the words shown in its place.
   */
  async contextShown(sessionId: string): Promise<ContextShown> {
    const context = await this.contextUsage(sessionId);
    if (context) return { context };
    const session = await this.host.sessionOrThrow(sessionId);
    return this.noteFor(session, (await this.host.recordFor(session)) ?? null);
  }

  /** The same, from what is known now, asking no agent (the held index, which must not start one). */
  contextKnown(session: Session, rec: Live | null): ContextShown {
    return rec?.context ? { context: rec.context } : this.noteFor(session, rec);
  }

  private noteFor(session: Session, rec: Live | null): ContextShown {
    const reports = typeof this.host.adapters[session.agent]?.contextUsage === 'function';
    return { context: null, contextNote: contextNote({ reports, agentLabel: AGENT_LABEL[session.agent], started: !!rec?.agentSessionId, working: isWorking(rec) }) };
  }

  /** Ask the session's agent what "/" offers, once per server run, in the background; the answer arrives like any other list. */
  askSlashCommands(session: Session, rec: Live): void {
    const adapter = this.host.adapters[session.agent];
    if (rec.slashAsked || rec.slashCommands.length > 0 || !adapter?.slashCommands) return;
    rec.slashAsked = true;
    void this.host
      .optionsFor(session, rec, false)
      .then((options) => adapter.slashCommands!(options))
      .then((commands) => commands && this.host.onEvent(session.id, rec, { type: 'slash-commands', commands }))
      .catch(() => undefined); // it cannot say (not installed, not signed in): the menu just stays shut
  }
}
