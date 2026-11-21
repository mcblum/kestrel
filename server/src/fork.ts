// Fork: a new session that carries on from a copy of another's conversation (Matt, 2026-11-18, "as in
// Claude's own app"). The agent's own SDK copies the conversation (Claude: forkSession; Codex:
// thread/fork); Kestrel copies what it shows (the stored messages) and gives the fork a worktree of
// its own, cut from the old session's branch as it stands. The old session, its links and any
// workstream it is in are only read. The rules of who may fork are in shared/fork.ts.
//
// Order matters: the worktree is made first (the agent's copy is set to work there), then the agent
// forks, and only once both worked is the session stored, in one write. Anything made before a
// failure is removed again, so a failed fork leaves nothing behind and trying again makes one session.
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter } from './agents/types.ts';
import { createWorktree, git, oneAtATime, removeWorktree, uncommittedFiles, worktreeStart } from './git.ts';
import { AGENT_LABEL, type Agent, type ChatMessage, type Project, type ProjectFolder, type Session, type SessionView } from './model.ts';
import type { StoredDetail } from './persistence/types.ts';
import { clock } from './runtime/record.ts';
import { EARLIER_TURN_NOTICE, forkCut, forkRefusal, forkTitle, uncommittedNotice, type ForkCut } from './shared/fork.ts';
import { folderOf } from './shared/project-folders.ts';
import { isOpenWork } from './shared/workstreams.ts';
import { Refused, type Workspace } from './workspace.ts';

/** What forking needs from the runtime. */
export interface ForkDeps {
  workspace: Workspace;
  dataDir: string;
  adapterFor(agent: Agent): AgentAdapter | undefined;
  /** A turn is running or starting in this session right now. */
  isWorking(sessionId: string): boolean;
  /** The session's conversation as it stands: the live one when it is loaded, else what is stored. */
  conversation(sessionId: string): Promise<StoredDetail | null>;
  /** The folder the session works in (its worktree, its plain folder, or scratch). */
  directoryOf(sessionId: string): Promise<string | null>;
  checkPlainFolderFree(project: Project, folder: ProjectFolder, sessions: readonly Session[]): void;
  /** The prefix a new branch gets (Settings → Git). */
  branchPrefix(): Promise<string>;
  /** Folders of files a session's conversation refers to (its pictures, its attachments), by session. */
  sessionFolders(sessionId: string): string[];
}

/** Where the fork works, and what was made for it that a failure has to remove. */
interface Workdir {
  directory: string;
  worktree: { repo: string; path: string; branch: string } | null;
  /** Files changed but not committed in the old worktree: not carried over. */
  uncommitted: number;
}

/** What is known to be forkable once the checks pass, and the part of the conversation the fork gets. */
interface Forkable {
  fork: NonNullable<AgentAdapter['fork']>;
  conversation: StoredDetail & { agentSessionId: string };
  cut: ForkCut;
}

export class Forks {
  constructor(private readonly deps: ForkDeps) {}

  /**
   * Fork a session at a turn boundary: from the end of its conversation, or from the turn started by
   * the message `turnId` (the fork's conversation ends with that turn). Returns the new session;
   * refuses with the reason, leaving nothing behind.
   */
  async fork(sessionId: string, turnId?: string): Promise<Session> {
    const state = await this.deps.workspace.state();
    const old = state.sessions.find((s) => s.id === sessionId);
    if (!old) throw new Refused(`No such session: ${sessionId}`);
    const forkable = await this.check(old, turnId);
    const project = state.projects.find((p) => p.id === old.startedIn) ?? null;
    const source = project ? folderOf(project, old.folderId) : null;
    if (project && source) this.deps.checkPlainFolderFree(project, source, state.sessions);
    const id = randomUUID();
    const title = forkTitle(old.title);
    const workdir = await this.workdir(id, title, old, source);
    try {
      const agentSessionId = await this.agentFork(forkable, old.id, workdir.directory);
      this.copyFolders(old.id, id, forkable.cut.earlier ? referencedFiles(forkable.cut.messages) : null);
      const detail = forkDetail(forkable.conversation, forkable.cut.messages, agentSessionId, notices(forkable.cut, old.title, workdir.uncommitted));
      const session = { id, title, agent: old.agent, startedIn: old.startedIn, startedFolderId: old.startedFolderId, landedIn: old.landedIn, groupId: old.groupId, state: 'done' as const, note: FORKED_NOTE, worktreePath: workdir.worktree?.path ?? null, branch: workdir.worktree?.branch ?? null };
      return await this.deps.workspace.addFork(old.id, session, detail);
    } catch (error) {
      await this.undo(id, workdir);
      throw error;
    }
  }

  /** Whether the session can be forked now (`forkRefusal`, then what only the server knows), and with what. */
  private async check(old: SessionView, turnId: string | undefined): Promise<Forkable> {
    const refusal = forkRefusal({ agent: old.agent, working: isOpenWork(old) || this.deps.isWorking(old.id) });
    if (refusal) throw new Refused(`Cannot fork “${old.title}”: ${refusal}.`);
    const fork = this.deps.adapterFor(old.agent)?.fork;
    if (!fork) throw new Refused(`${AGENT_LABEL[old.agent]} in Kestrel cannot fork a conversation.`);
    const conversation = await this.deps.conversation(old.id);
    if (!conversation?.agentSessionId) throw new Refused(`“${old.title}” never got far enough to have a conversation to fork.`);
    if (old.worktreeDiscarded) throw new Refused(`The worktree of “${old.title}” was discarded, so there is no branch to fork from.`);
    if (old.worktreePath && !existsSync(old.worktreePath)) throw new Refused(`The worktree ${old.worktreePath} is gone, so there is no branch to fork from.`);
    const cut = forkCut(conversation.messages, turnId, (reason) => new Refused(`Cannot fork “${old.title}” from that turn: ${reason}.`));
    return { fork, conversation: { ...conversation, agentSessionId: conversation.agentSessionId }, cut };
  }

  /**
   * The fork's folder. In a git project, a worktree of its own on a new branch at the old session's
   * commit, with its base ("a worktree is changed only by the session it was made for"). In a plain
   * folder, the folder itself (one editing session at a time, checked before). With no project, scratch.
   */
  private async workdir(id: string, title: string, old: Session, source: ProjectFolder | null): Promise<Workdir> {
    if (!source?.isGit) return { directory: source?.path ?? this.scratch(), worktree: null, uncommitted: 0 };
    const start = old.worktreePath && old.branch ? await worktreeStart(old.worktreePath, old.branch) : undefined;
    const uncommitted = old.worktreePath ? await uncommittedFiles(old.worktreePath) : 0;
    const made = await createWorktree(source.path, join(this.deps.dataDir, 'worktrees'), id, title, await this.deps.branchPrefix(), start);
    return { directory: made.path, worktree: { repo: source.path, path: made.path, branch: made.branch }, uncommitted };
  }

  /** The agent copies its conversation. Its failure is said as Kestrel's reason. */
  private async agentFork(forkable: Forkable, oldId: string, to: string): Promise<string> {
    const from = (await this.deps.directoryOf(oldId)) ?? to;
    try {
      const at = forkable.cut.at;
      return await forkable.fork(forkable.conversation.agentSessionId, { from, to, ...(at ? { at } : {}) });
    } catch (error) {
      throw new Refused(`The agent could not fork the conversation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The pictures and attachments the copied conversation shows, under the fork's own id. `only`: the
   * names (a picture's file, an attachment's folder) the cut conversation refers to; null: all of them.
   */
  private copyFolders(fromId: string, toId: string, only: ReadonlySet<string> | null): void {
    const from = this.deps.sessionFolders(fromId);
    const to = this.deps.sessionFolders(toId);
    from.forEach((dir, i) => {
      const target = to[i];
      if (!existsSync(dir) || !target) return;
      if (!only) return void cpSync(dir, target, { recursive: true });
      for (const name of readdirSync(dir).filter((entry) => only.has(entry))) cpSync(join(dir, name), join(target, name), { recursive: true });
    });
  }

  /** Remove what a failed fork made: its copied folders, its worktree and its branch. Never throws: the first failure is the one to report. */
  private async undo(id: string, workdir: Workdir): Promise<void> {
    for (const dir of this.deps.sessionFolders(id)) rmSync(dir, { recursive: true, force: true });
    const made = workdir.worktree;
    if (!made) return;
    await removeWorktree(made.repo, made.path).catch(() => undefined);
    await oneAtATime(made.repo, () => git(made.repo, ['branch', '-D', made.branch], { allowFail: true })).catch(() => undefined);
  }

  private scratch(): string {
    const folder = join(this.deps.dataDir, 'scratch');
    mkdirSync(folder, { recursive: true });
    return folder;
  }
}

const FORKED_NOTE = 'Forked · waiting for your next message';

/** A line from Kestrel at the end of the copied conversation. */
const notice = (text: string): ChatMessage => ({ id: `notice-${randomUUID()}`, author: 'agent', time: clock(), text, notice: 'info' });

/** What the fork says at the end of its conversation: forked from an earlier turn, and changes left uncommitted in the old worktree. */
function notices(cut: ForkCut, oldTitle: string, uncommittedCount: number): ChatMessage[] {
  return [...(cut.earlier ? [notice(EARLIER_TURN_NOTICE)] : []), ...(uncommittedCount > 0 ? [notice(uncommittedNotice(oldTitle, uncommittedCount))] : [])];
}

/** The pictures and attachments a conversation refers to, by the name each is kept under. */
function referencedFiles(messages: readonly ChatMessage[]): ReadonlySet<string> {
  return new Set(messages.flatMap((m) => [...(m.images ?? []), ...(m.attachments ?? []).map((a) => a.id)]));
}

/** A copied message without the agent's point: the agent's copy has its own ids, so the old one would fork the wrong conversation. */
const withoutPoint = ({ forkPoint: _point, ...message }: ChatMessage): ChatMessage => message;

/**
 * What the fork stores: the old conversation as shown (through the turn forked from), its agent's tools and settings, and the new
 * agent conversation. Not carried: news, askers and queued messages meant for the old session, its
 * spending, the commands its agent ran, and "Allow all outside the sandbox", which holds for the
 * session it was chosen in only.
 */
function forkDetail(from: StoredDetail, messages: readonly ChatMessage[], agentSessionId: string, notices: readonly ChatMessage[]): StoredDetail {
  return {
    messages: [...messages.map(withoutPoint), ...notices],
    files: from.files,
    agentOutput: '',
    kestrelTools: from.kestrelTools,
    kestrelMissing: from.kestrelMissing ?? [],
    agentSessionId,
    ...(from.settings ? { settings: from.settings } : {}),
    ...(from.slashCommands ? { slashCommands: from.slashCommands } : {}),
  };
}
