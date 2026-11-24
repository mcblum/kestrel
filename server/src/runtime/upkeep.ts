// The slow, throttled work around a live session: storing its conversation, recomputing its
// changed files from git, and writing what it is doing onto its row. Each is a timer per
// session, so a burst of agent activity becomes one write.
import type { StoredCommands } from '../shared/commands.ts';
import { nextLandedIn } from '../filing.ts';
import { currentWorkingTree } from '../working-tree.ts';
import { MAIN_CHECKOUT, worktreeSharers } from '../shared/working-tree.ts';
import { baseOf, readChanges } from '../git.ts';
import type { ChangedFile, LivePatch } from '../model.ts';
import { reasonOf } from '../shared/sourced.ts';
import type { Workspace } from '../workspace.ts';
import type { Live } from './record.ts';

const PERSIST_MS = 400;
const REFRESH_MS = 250;
const NOTE_MS = 1000;
const NO_BASE = 'Kestrel cannot find the commit this session’s branch started from, so it cannot work out what changed.';

export class Upkeep {
  constructor(
    private readonly workspace: Workspace,
    /** Send something to whoever is watching the session. */
    private readonly emitLive: (id: string, patch: LivePatch) => void,
    /** Run work after the session's earlier side effects, in order. */
    private readonly queue: (rec: Live, work: () => Promise<unknown>) => void,
    /** What else is stored with a session's conversation: its commands (runtime/commands.ts). */
    private readonly commandsOf: (id: string) => StoredCommands | undefined = () => undefined,
    /** A session's live record, when it is loaded: how the others working in the same worktree are told it changed. */
    private readonly recordOf: (id: string) => Live | undefined = () => undefined,
  ) {}

  // ---- the row's status line -------------------------------------------------------------

  /** Show what the agent is doing on its row, throttled: a burst of tool calls is one write. */
  noteLatest(id: string, rec: Live, text: string): void {
    if (!text) return;
    rec.latestNote = text;
    if (rec.noteTimer) return;
    rec.noteTimer = setTimeout(() => {
      rec.noteTimer = null;
      this.queue(rec, async () => {
        const session = (await this.workspace.state()).sessions.find((s) => s.id === id);
        if (session?.state === 'running' && rec.latestNote && session.note !== rec.latestNote) await this.workspace.setState(id, 'running', rec.latestNote);
      });
    }, NOTE_MS);
  }

  cancelNote(rec: Live): void {
    if (rec.noteTimer) clearTimeout(rec.noteTimer);
    rec.noteTimer = null;
    rec.latestNote = '';
  }

  // ---- git evidence ----------------------------------------------------------------------

  scheduleRefresh(id: string, rec: Live): void {
    if (rec.refreshTimer) return;
    rec.refreshTimer = setTimeout(() => {
      rec.refreshTimer = null;
      this.queue(rec, () => this.refreshFiles(id, rec));
    }, REFRESH_MS);
  }

  cancelRefresh(rec: Live): void {
    if (rec.refreshTimer) clearTimeout(rec.refreshTimer);
    rec.refreshTimer = null;
  }

  /**
   * Recompute the changed-file list from the worktree the session works in (its own, or its host's
   * for a guest: shared/working-tree.ts), file the session from it, and note the branch it is on now.
   * A guest's list is the worktree's list, compared with its host's base.
   */
  async refreshFiles(id: string, rec: Live): Promise<void> {
    if (rec.refreshing) {
      rec.refreshAgain = true;
      return;
    }
    const state = await this.workspace.state();
    const session = state.sessions.find((s) => s.id === id) ?? state.archived.sessions.find((s) => s.id === id);
    if (!session) return;
    // The agent (or the user, in the terminal) may have renamed or switched the worktree's branch;
    // recorded on the worktree's owner (working-tree.ts). Looked at even when there is no base to
    // compare files with (a session carried over a restart).
    const where = await currentWorkingTree(this.workspace, state, session);
    if (!where.tree) {
      // A session that never had a worktree has nothing to read; one whose worktree it works in is gone says why.
      if (where.reason !== MAIN_CHECKOUT) this.setFilesProblem(id, rec, where.reason);
      return;
    }
    const { path, branch, ownerId } = where.tree;
    // Asked each time, under the name the worktree is on now: the base moves when the branch is
    // rebased (git.ts, `movedBase`), and a record loaded just after a rename had none at all.
    if (branch) rec.base = (await baseOf(path, branch)) ?? rec.base;
    if (!rec.base) return this.setFilesProblem(id, rec, NO_BASE);
    rec.refreshing = true;
    try {
      do {
        rec.refreshAgain = false;
        let files: ChangedFile[];
        let unlisted: string | null;
        try {
          const read = await readChanges(path, rec.base);
          files = read.files;
          unlisted = read.unlisted;
        } catch (error) {
          // Keep the last list rather than blank it, and say why it is not current.
          this.setFilesProblem(id, rec, reasonOf(error));
          continue;
        }
        // Null when every file is listed; otherwise the list is shown with what it is missing.
        this.setFilesProblem(id, rec, unlisted);
        if (JSON.stringify(files) !== JSON.stringify(rec.files)) {
          rec.files = files;
          this.emitLive(id, { files });
          this.schedulePersist(id, rec);
          // The worktree changed under everyone in it: a guest's edit is its host's change too, and a
          // host's is its guests'; nothing else tells them. Found from the rows (Session.hostId), so it
          // holds after a restart; a mate whose record is not loaded reads its list when it is opened
          // (Runtime.snapshot). Ends by itself: a mate whose list is already this one changes nothing.
          for (const mate of worktreeSharers(state.sessions, ownerId)) {
            const mateRec = mate.id === id ? undefined : this.recordOf(mate.id);
            if (mateRec) this.scheduleRefresh(mate.id, mateRec);
          }
        }
        // Filing is about owning the worktree: a guest is filed where it started (filing.ts).
        if (ownerId !== id) continue;
        const landed = nextLandedIn(session.landedIn, session.startedIn ? { projectId: session.startedIn, differsFromBase: files.length > 0 } : null);
        if (landed !== session.landedIn) await this.workspace.setLandedIn(id, landed);
      } while (rec.refreshAgain);
    } finally {
      rec.refreshing = false;
    }
  }

  /** Record why the list could not be read (null: it was), telling the window only when that changes. */
  private setFilesProblem(id: string, rec: Live, problem: string | null): void {
    if (rec.filesProblem === problem) return;
    rec.filesProblem = problem;
    this.emitLive(id, { filesProblem: problem });
  }

  // ---- storage ---------------------------------------------------------------------------

  schedulePersist(id: string, rec: Live): void {
    if (rec.persistTimer) return;
    rec.persistTimer = setTimeout(() => {
      rec.persistTimer = null;
      this.queue(rec, () => this.persist(id, rec));
    }, PERSIST_MS);
  }

  async flush(id: string, rec: Live): Promise<void> {
    if (rec.persistTimer) clearTimeout(rec.persistTimer);
    rec.persistTimer = null;
    await this.persist(id, rec);
  }

  // What is written is merged into what is stored (`setDetail`), so a list that can empty again
  // (the inbox, the askers) is always written: leaving it out would keep the old one, and news
  // already delivered would be delivered again after a restart.
  persist(id: string, rec: Live): Promise<void> {
    return this.workspace.setDetail(id, { messages: rec.messages, files: rec.files, agentOutput: rec.agentOutput, kestrelTools: rec.kestrelTools, kestrelMissing: rec.kestrelMissing, agentSessionId: rec.agentSessionId, settings: rec.settings, queue: rec.queue, ...(rec.usage ? { usage: rec.usage } : {}), inbox: rec.inbox, commands: this.commandsOf(id), ...(rec.slashCommands.length ? { slashCommands: rec.slashCommands } : {}), spawned: rec.spawned, ...(rec.guest ? { guest: rec.guest } : {}), ...(rec.review ? { review: rec.review } : {}), ...(rec.roleRun ? { roleRun: rec.roleRun } : {}), ...(rec.modelChosen ? { modelChosen: true } : {}), askers: rec.askers, outsideAllowed: rec.outsideAllowed });
  }

  /** Stop every timer for a session that is ending or being removed. */
  cancelTimers(rec: Live): void {
    this.cancelRefresh(rec);
    this.cancelNote(rec);
    if (rec.persistTimer) clearTimeout(rec.persistTimer);
    rec.persistTimer = null;
  }
}
