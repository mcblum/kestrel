// Workspace logic: the operations that keep sessions, groups and links consistent.
// Depends only on the Persistence facade. Holds the one cached copy of the derived state.
// Pure derivation is in workspace-derive.ts, the session record and limit checks in
// workspace-records.ts, and the settings-backed parts (archive, project setup) in workspace-settings.ts.
import { pruneArchived, setArchived, type ArchiveKind } from './shared/archive.ts';
import type { ProjectSetup } from './shared/setup.ts';
import { randomUUID } from 'node:crypto';
import { Onboarding } from './onboarding/setup.ts';
import { addTag, parseTag, removeTag } from './shared/tags.ts';
import { isPermutation, storedPinOrder, visiblePins, type PinRef } from './shared/pins.ts';
import { DelegationLimitsPrefs, limitMessage } from './limits.ts';
import { handoffChain, subtreeIds } from './tree.ts';

/** How many times in a row a task may be handed from session to session before it has to be done where it is. */
export const MAX_HANDOFFS_IN_A_ROW = 5;
import { worktreeRepo } from './worktree-repo.ts';
import { fitsGroup, joinRefusal, moveGroupRefusal } from './shared/project-groups.ts';
import { visibleWaits } from './shared/waits.ts';
import { afterUserMessage, archiveRefusal, removeRefusal, childGroupId, delegateWorkstream, shownWorkstreams, visibleWorkstreams, workstreamName, workstreamObjective, workstreamOf } from './shared/workstreams.ts';
import { nameTakenBy, projectRecord, type NewProject } from './project-record.ts';
import { Refused } from './refused.ts';
import { SeenStore } from './seen.ts';
import { AccountReplica, machineCards } from './account-replica.ts';
import { withRemote } from './account-view.ts';
import { AccountProjects, heldProjects } from './account-projects.ts';
import { AccountOffers } from './account-offers.ts';
import { RepoKeys } from './repo-keys.ts';
import { deriveState, trailFor, withoutArchived } from './workspace-derive.ts';
import { checkLimits, checkLive, copyTags, EMPTY_DETAIL, insertSession, projectNamer, refuseWhileWorking, type DelegateTask, type NewSession } from './workspace-records.ts';
import * as settings from './workspace-settings.ts';
import type { AutopilotRecord } from './shared/autopilot.ts';
import type { Agent, Group, PinKind, Project, RequestLink, Session, SessionDetail, SessionRequestLink, SessionState, SessionWait, WorkstreamStatus, WorkspaceState, Workstream } from './model.ts';
import type { Persistence, StoredDetail } from './persistence/types.ts';

export { Refused, deriveState, withoutArchived };
export type { DelegateTask, NewSession };

export class Workspace {
  readonly onboarding: Onboarding;
  /** Settings → Workflow → Delegation limits: what delegate, handoff and spawn are checked against. */
  readonly limits: DelegationLimitsPrefs;
  /** The one record of what the user has looked at, for every window and a paired phone (seen.ts). */
  readonly seen: SeenStore;
  /** What this computer keeps of the account's other machines' sessions (account-replica.ts). */
  readonly account: AccountReplica;
  /** What this computer keeps of the projects the account's other machines have (account-projects.ts). */
  readonly accountProjects: AccountProjects;
  /** What the account's other machines offer for a new session (account-offers.ts), pushed to the windows. */
  readonly accountOffers: AccountOffers;
  /** Which repositories each project is, as every computer of the account names them. */
  readonly repos = new RepoKeys();
  private viewCache: WorkspaceState | null = null;
  private viewLoading: Promise<WorkspaceState> | null = null;
  private cache: WorkspaceState | null = null;
  private loading: Promise<WorkspaceState> | null = null;
  private version = 0;
  private listeners = new Set<() => void>();

  constructor(
    private readonly db: Persistence,
    private readonly clock: () => number = Date.now,
  ) {
    this.onboarding = new Onboarding(db);
    this.limits = new DelegationLimitsPrefs({ settings: db });
    this.account = new AccountReplica(db, () => this.changed());
    this.accountProjects = new AccountProjects(db, () => this.changed());
    this.accountOffers = new AccountOffers(db);
    this.seen = new SeenStore({
      settings: db,
      // What is drawn is what can be looked at: another computer's sessions are marked seen here too.
      sessions: async () => {
        const state = await this.view();
        return [...state.sessions, ...state.archived.sessions];
      },
      now: clock,
    });
  }

  /** Called after every committed write. Listeners should read `state()` when they are ready to. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.version++;
    this.cache = null;
    this.loading = null;
    this.viewCache = null;
    this.viewLoading = null;
    for (const listener of this.listeners) listener();
  }

  // ---- reads --------------------------------------------------------------------

  /**
   * The derived workspace state. Computed once per change and shared by every reader;
   * concurrent callers during a load wait on the same promise instead of querying again.
   */
  state(): Promise<WorkspaceState> {
    if (this.cache) return Promise.resolve(this.cache);
    if (this.loading) return this.loading;
    const version = this.version;
    const load = Promise.all([this.db.listProjects(), this.db.listGroups(), this.db.listSessions(), this.db.listLinks(), settings.readArchived(this.db), this.db.listTags(), this.db.listPins(), this.db.listAllRequestLinks(), this.db.listWorkstreams(), this.db.listWaits(), settings.readAutopilot(this.db)]).then(([projects, groups, sessions, links, archived, tags, pins, requests, workstreams, waits, autopilot]) => {
      const derived = withoutArchived(deriveState(projects, groups, sessions, links, tags, worktreeRepo, requests, autopilot), archived);
      const shown = { sessions: new Set(derived.sessions.map((x) => x.id)), projects: new Set(derived.projects.map((x) => x.id)), groups: new Set(derived.groups.map((x) => x.id)) };
      // An archived workstream is out of the sidebar's list and kept apart, still pointing at its sessions.
      const split = shownWorkstreams(workstreams, shown.sessions);
      // A wait shows only between sessions in sight, whether or not their workstream is archived.
      const state: WorkspaceState = { ...derived, workstreams: split.active, archivedWorkstreams: split.archived, waits: visibleWaits(waits, visibleWorkstreams(workstreams, shown.sessions)), pins: visiblePins(pins, shown) };
      if (version === this.version) this.cache = state;
      if (this.loading === load) this.loading = null;
      return state;
    });
    this.loading = load;
    return load;
  }

  /**
   * What a window draws: this computer's state with the sessions the account's other computers run
   * (shared/machines.ts, `runsOn`) and the projects they have that this computer does not. Computed once per change and shared, as `state()` is. Everything that
   * runs, files, counts or acts on sessions reads `state()`, which holds this computer's own and no other;
   * with no account, or no other computer, this is that same object.
   */
  view(): Promise<WorkspaceState> {
    if (this.viewCache) return Promise.resolve(this.viewCache);
    if (this.viewLoading) return this.viewLoading;
    const version = this.version;
    const load = Promise.all([this.state(), this.db.listAccountSessions(), this.db.listAccountRecords()]).then(async ([state, heads, records]) => {
      const projects = heldProjects(records).map((h) => h.project);
      const keys = heads.length > 0 || projects.length > 0 ? new Map(await Promise.all(state.projects.map(async (p) => [p.id, await this.repos.ofProject(p)] as const))) : new Map<string, string[]>();
      const view = withRemote(state, heads, machineCards(records), keys, projects);
      if (version === this.version) this.viewCache = view;
      if (this.viewLoading === load) this.viewLoading = null;
      return view;
    });
    this.viewLoading = load;
    return load;
  }

  async detail(sessionId: string): Promise<SessionDetail | null> {
    const state = await this.state();
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) return null;
    const stored = (await this.db.getDetail(sessionId)) ?? EMPTY_DETAIL;
    return { session, ...EMPTY_DETAIL, ...stored, trail: trailFor(sessionId, state) };
  }

  /** The stored detail as it is, without defaults; null for a session that never had one. */
  storedDetail(sessionId: string): Promise<StoredDetail | null> {
    return this.db.getDetail(sessionId);
  }

  /** The pull or merge requests linked to a session, in the order they were linked. */
  requestLinks(sessionId: string): Promise<RequestLink[]> {
    return this.db.listRequestLinks(sessionId);
  }

  /** Every session's linked requests, each with its session: one read for the Pull requests page. */
  allRequestLinks(): Promise<SessionRequestLink[]> {
    return this.db.listAllRequestLinks();
  }

  // ---- writes ---------------------------------------------------------------------

  private autopilotWrites: Promise<unknown> = Promise.resolve();
  private readonly mergedListeners = new Set<(sessionId: string) => void>();
  private readonly requestListeners = new Set<(sessionId: string, link: RequestLink) => void>();

  /** Told each time a request is first linked to a session (one its agent opened, or one the form did). Returns the undo. */
  onRequestLinked(listener: (sessionId: string, link: RequestLink) => void): () => void {
    this.requestListeners.add(listener);
    return () => void this.requestListeners.delete(listener);
  }

  /** Told each time a session's pull request is first seen merged. Returns the undo. */
  onMerged(listener: (sessionId: string) => void): () => void {
    this.mergedListeners.add(listener);
    return () => void this.mergedListeners.delete(listener);
  }

  /**
   * Records requests a lookup saw: each not linked to the session yet is linked, stamped with the
   * clock; each already linked takes the state it was seen in. Returns the links it added. Nothing
   * for a session that is gone. A session's newest request decides its status (status.ts), so the
   * state is invalidated and broadcast when anything was added or changed state, and only then.
   */
  async recordRequests(sessionId: string, requests: readonly Omit<RequestLink, 'linkedAt'>[]): Promise<RequestLink[]> {
    if (requests.length === 0) return [];
    const linkedAt = this.clock();
    let merged = false;
    const { added, updated } = await this.db.transaction(async (tx) => {
      if (!(await tx.getSession(sessionId))) return { added: [], updated: 0 };
      const added: RequestLink[] = [];
      let updated = 0;
      for (const request of requests) {
        const link = { ...request, linkedAt };
        if (await tx.insertRequestLink(sessionId, link)) {
          added.push(link);
          if (request.state === 'merged') merged = true;
        } else if (request.state && (await tx.setRequestState(sessionId, request.host, request.number, request.state))) {
          updated++;
          if (request.state === 'merged') merged = true;
        }
      }
      return { added, updated };
    });
    if (added.length + updated > 0) this.changed();
    for (const link of added) for (const listener of this.requestListeners) listener(sessionId, link);
    // A request seen merged for the first time: whoever cleans up after a merge is told (cleanup/on-merge.ts).
    if (merged) for (const listener of this.mergedListeners) listener(sessionId);
    return added;
  }

  /**
   * Set or clear one session's Autopilot (shared/autopilot.ts). Writes run one after another, and the
   * state changes only when the record really did, so a look that changes nothing broadcasts nothing.
   */
  setAutopilot(sessionId: string, record: AutopilotRecord | null): Promise<void> {
    const work = this.autopilotWrites.then(async () => {
      const all = new Map(await settings.readAutopilot(this.db));
      const before = all.get(sessionId);
      if (JSON.stringify(before ?? null) === JSON.stringify(record)) return;
      if (record) all.set(sessionId, record);
      else all.delete(sessionId);
      await settings.saveAutopilot(this.db, all);
      this.changed();
    });
    this.autopilotWrites = work.catch(() => undefined);
    return work;
  }

  /** One session's Autopilot as stored; null when it has none. */
  async autopilot(sessionId: string): Promise<AutopilotRecord | null> {
    return (await settings.readAutopilot(this.db)).get(sessionId) ?? null;
  }

  /** Store a project as given (project-record.ts); checking it is the caller's job (project-store.ts). */
  async addProject(p: NewProject): Promise<Project> {
    const project = projectRecord(p);
    await this.db.insertProject(project);
    this.changed();
    return project;
  }

  /** Several writes to projects as one; the state changes once, after they are all kept. */
  async changeProjects<T>(work: (tx: Persistence) => Promise<T>): Promise<T> {
    const result = await this.db.transaction(work);
    this.changed();
    return result;
  }

  /** A project can go only when no session was started in it or landed in it. */
  async removeProject(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const project = (await tx.listProjects()).find((p) => p.id === id);
      if (!project) throw new Refused('No such project.');
      const used = (await tx.listSessions()).filter((s) => s.startedIn === id || s.landedIn === id).length;
      if (used > 0) throw new Refused(`${project.name} still has ${used} session${used === 1 ? '' : 's'}. Remove or move them first.`);
      // Its groups hold nothing (it has no sessions) and belong nowhere else: they go with it.
      for (const g of (await tx.listGroups()).filter((g) => g.projectId === id)) {
        await tx.deleteGroup(g.id);
        await tx.deletePin('group', g.id);
      }
      await tx.deleteProject(id);
      await tx.deletePin('project', id);
    });
    this.changed();
  }

  // ---- rename, archive, delete --------------------------------------------------------

  async renameSession(id: string, title: string): Promise<void> {
    const trimmed = title.trim().slice(0, 200);
    if (!trimmed) throw new Refused('A session needs a name.');
    if (!(await this.db.updateSession(id, { title: trimmed }))) throw new Refused('No such session.');
    this.changed();
  }

  /** Renames the session only if its title is still exactly `from` (no one renamed it meanwhile). False if not, or if it is gone. */
  async retitleSession(id: string, from: string, to: string): Promise<boolean> {
    const title = to.trim().slice(0, 200);
    if (!title) return false;
    const renamed = await this.db.transaction(async (tx) => {
      const session = await tx.getSession(id);
      if (!session || session.title !== from) return false;
      return tx.updateSession(id, { title });
    });
    if (renamed) this.changed();
    return renamed;
  }

  async renameProject(id: string, name: string): Promise<void> {
    const trimmed = name.trim().slice(0, 80);
    if (!trimmed) throw new Refused('A project needs a name.');
    await this.db.transaction(async (tx) => {
      const taken = nameTakenBy(await tx.listProjects(), trimmed, id);
      if (taken) throw new Refused(`There is already a project called ${taken.name}.`);
      if (!(await tx.renameProject(id, trimmed))) throw new Refused('No such project.');
    });
    this.changed();
  }

  /** Removes the session's record, its conversation and its links. The caller has already stopped it and dealt with its worktree. */
  async deleteSession(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Its sidebars go with it: they are about its conversation and drawn only beside it (shared/asides.ts).
      for (const aside of (await tx.listSessions()).filter((s) => s.aside?.sessionId === id)) await tx.deleteSession(aside.id);
      if (!(await tx.deleteSession(id))) throw new Refused('No such session.');
      await tx.deletePin('session', id);
      await settings.unarchive(tx, 'session', id);
    });
    this.changed();
  }

  /**
   * Archive or restore a session, a project or a group. Archiving is out of sight, not deleted.
   * Something with a session still working cannot be archived: stop it first.
   */
  async setArchived(kind: ArchiveKind, id: string, on: boolean): Promise<void> {
    // The three full lists are needed anyway: pruning forgets every id that no longer exists.
    const changed = await this.db.transaction(async (tx) => {
      const [sessions, projects, groups, current] = await Promise.all([tx.listSessions(), tx.listProjects(), tx.listGroups(), settings.readArchived(tx)]);
      const exists = kind === 'session' ? sessions.some((s) => s.id === id) : kind === 'project' ? projects.some((p) => p.id === id) : groups.some((g) => g.id === id);
      if (!exists) throw new Refused(`No such ${kind}.`);
      if (on) refuseWhileWorking(kind, id, sessions);
      const pruned = pruneArchived(current, { sessions: new Set(sessions.map((s) => s.id)), projects: new Set(projects.map((p) => p.id)), groups: new Set(groups.map((g) => g.id)) });
      const next = setArchived(pruned, kind, id, on);
      // Archiving something takes its pin off; restoring it does not pin it again.
      const unpinned = on && (await tx.deletePin(kind, id));
      if (next === current && !unpinned) return false;
      if (next !== current) await settings.saveArchived(tx, next);
      return true;
    });
    if (changed) this.changed();
  }

  // ---- tags ---------------------------------------------------------------------------

  /** Add a tag to a session (shared/tags.ts). Returns its tags. */
  tagSession(id: string, raw: unknown): Promise<readonly string[]> {
    return this.retag(id, raw, addTag);
  }

  /** Take a tag off a session, in any case. Returns its tags. */
  untagSession(id: string, raw: unknown): Promise<readonly string[]> {
    return this.retag(id, raw, removeTag);
  }

  private async retag(id: string, raw: unknown, change: (tags: readonly string[], tag: string) => readonly string[]): Promise<readonly string[]> {
    const parsed = parseTag(raw);
    if ('reason' in parsed) throw new Refused(parsed.reason);
    const { tags, changed } = await this.db.transaction(async (tx) => {
      if (!(await tx.getSession(id))) throw new Refused('No such session.');
      const before = await tx.tagsOf(id);
      const after = change(before, parsed.tag);
      if (after !== before) await tx.setTags(id, after);
      return { tags: after, changed: after !== before };
    });
    if (changed) this.changed();
    return tags;
  }

  // ---- pins ---------------------------------------------------------------------------

  /** Pin or unpin a session, a project or a group. Pinning one already pinned keeps its place. */
  async setPinned(kind: PinKind, id: string, on: boolean): Promise<void> {
    if (!on) {
      if (await this.db.deletePin(kind, id)) this.changed();
      return;
    }
    const pinnedAt = this.clock();
    await this.db.transaction(async (tx) => {
      // One row for a session; there is no single-row read for a project or a group.
      // A review request is not the workspace's to check (review-requests/store.ts holds them): its key is taken as given.
      const exists = kind === 'review' || (kind === 'session' ? (await tx.getSession(id)) !== null : (await (kind === 'project' ? tx.listProjects() : tx.listGroups())).some((x) => x.id === id));
      if (!exists) throw new Refused(`No such ${kind}.`);
      await tx.putPin({ kind, id, pinnedAt });
    });
    this.changed();
  }

  /** Put the pins in sight in this order. Refused unless it lists exactly those pins, each once. */
  async setPinOrder(order: readonly PinRef[]): Promise<void> {
    const shown = (await this.state()).pins;
    if (!isPermutation(shown, order)) throw new Refused('The pinned items changed. Try again.');
    await this.db.transaction(async (tx) => tx.setPinOrder(storedPinOrder(await tx.listPins(), order)));
    this.changed();
  }

  // ---- what of the user's agent setup each project's sessions get -------------------------

  /** What every project's sessions get unless the project says otherwise. Set once, in Settings. */
  defaultSetup(): Promise<ProjectSetup> {
    return settings.defaultSetup(this.db);
  }

  setDefaultSetup(setup: unknown): Promise<ProjectSetup> {
    return settings.setDefaultSetup(this.db, setup);
  }

  /**
   * The setup a project's sessions run with, and whether it is the project's own or the
   * defaults. A session with no project always uses the defaults.
   */
  projectSetup(projectId: string | null): Promise<{ setup: ProjectSetup; inherits: boolean }> {
    return settings.projectSetup(this.db, projectId);
  }

  /** Give a project its own setup, or pass null to put it back on the defaults. */
  setProjectSetup(projectId: string, setup: unknown | null): Promise<{ setup: ProjectSetup; inherits: boolean }> {
    return settings.setProjectSetup(this.db, projectId, setup);
  }

  /** UI state (open tabs, last composer choices) is kept here, not in the browser, so every shell agrees. */
  async getUiState(): Promise<string | null> {
    return this.db.getSetting('ui-state');
  }
  async setUiState(json: string): Promise<void> {
    await this.db.putSetting('ui-state', json);
    for (const listener of this.uiStateListeners) listener();
  }

  private readonly uiStateListeners = new Set<() => void>();
  /** Told after each write of the UI state (where the New session box's choices are remembered). Returns the undo. */
  onUiState(listener: () => void): () => void {
    this.uiStateListeners.add(listener);
    return () => void this.uiStateListeners.delete(listener);
  }

  /** A group in the Sessions list, or in a project when `projectId` is given (shared/project-groups.ts). */
  async addGroup(name: string, opts: { id?: string; projectId?: string | null } = {}): Promise<Group> {
    const trimmed = name.trim();
    if (!trimmed) throw new Refused('A group needs a name.');
    const projectId = opts.projectId ?? null;
    if (projectId !== null && !(await this.db.listProjects()).some((p) => p.id === projectId)) throw new Refused('No such project.');
    const group: Group = { id: opts.id ?? randomUUID(), name: trimmed, auto: false, createdAt: this.clock(), projectId };
    await this.db.insertGroup(group);
    this.changed();
    return group;
  }

  /**
   * Moves a Sessions-list group into a project, with its sessions. Refused, saying why, when any of
   * them belongs to another project, or when the group is already another project's.
   */
  async moveGroupToProject(id: string, projectId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [groups, projects, sessions] = await Promise.all([tx.listGroups(), tx.listProjects(), tx.listSessions()]);
      const group = groups.find((g) => g.id === id);
      if (!group) throw new Refused('No such group.');
      if (!projects.some((p) => p.id === projectId)) throw new Refused('No such project.');
      const reason = moveGroupRefusal(group, projectId, sessions.filter((s) => s.groupId === id), projectNamer(projects));
      if (reason) throw new Refused(reason);
      await tx.setGroupProject(id, projectId);
    });
    this.changed();
  }

  /** Automatic and manual groups rename the same way; `auto` stays as a record of how it was made. */
  async renameGroup(id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new Refused('A group needs a name.');
    if (!(await this.db.renameGroup(id, trimmed))) throw new Refused('No such group.');
    this.changed();
  }

  /**
   * Deleting a group never deletes sessions or links; its sessions become ungrouped (the provider
   * clears their group with the record). Its pin and its place in the archive go with it.
   */
  async deleteGroup(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.deleteGroup(id);
      await tx.deletePin('group', id);
      await settings.unarchive(tx, 'group', id);
    });
    this.changed();
  }

  async addSession(s: NewSession): Promise<Session> {
    const session = await this.db.transaction(async (tx) => {
      if (s.startedIn !== null && !(await tx.listProjects()).some((p) => p.id === s.startedIn)) throw new Refused(`No such project: ${s.startedIn}`);
      if (s.groupId) {
        const group = (await tx.listGroups()).find((g) => g.id === s.groupId);
        if (!group) throw new Refused('No such group.');
        if (!fitsGroup(group, { startedIn: s.startedIn, landedIn: null })) throw new Refused(`“${group.name}” is a group in another project. Start the session in that project, or in another group.`);
      }
      return this.insertSession(tx, s);
    });
    this.changed();
    return session;
  }

  private insertSession(tx: Persistence, s: NewSession): Promise<Session> {
    return insertSession(tx, s, this.clock());
  }

  /**
   * Change a session's state and status line. `activity` marks it as activity the user would call
   * so (a turn starting or ending, the agent stopping to ask): it moves the session up a list sorted
   * by most recent (shared/session-order.ts). A status-line update while working is not activity.
   * `stopped`: a `done` that the user's Stop caused (Session.stopped); every other change clears it.
   * `byUser`: a turn starts, and the user started it by writing here (Session.turnByUser); left as it
   * was when not given.
   */
  async setState(id: string, state: SessionState, note?: string, opts: { activity?: boolean; completed?: boolean; stopped?: boolean; byUser?: boolean } = {}): Promise<void> {
    const now = this.clock();
    await this.db.transaction(async (tx) => {
      const session = opts.completed && state === 'done' ? await tx.getSession(id) : null;
      const completion = session && session.completedAt === undefined ? { completedAt: now } : {};
      if (!(await tx.updateSession(id, { state, note, stopped: state === 'done' && opts.stopped === true, ...(opts.byUser === undefined ? {} : { turnByUser: opts.byUser }), updatedAt: now, ...(opts.activity ? { lastActivityAt: now } : {}), ...completion }))) throw new Refused(`No such session: ${id}`);
    });
    this.changed();
  }

  /** Store the result of `nextLandedIn`. Only ever called with git evidence behind it. */
  async setLandedIn(id: string, projectId: string | null): Promise<void> {
    if (!(await this.db.updateSession(id, { landedIn: projectId, updatedAt: this.clock() }))) throw new Refused(`No such session: ${id}`);
    this.changed();
  }

  /** Record the worktree the worktree manager created for a session. */
  async attachWorktree(id: string, worktree: { path: string; branch: string }): Promise<void> {
    if (!(await this.db.updateSession(id, { worktreePath: worktree.path, branch: worktree.branch, worktreeDiscarded: false, updatedAt: this.clock() }))) throw new Refused(`No such session: ${id}`);
    this.changed();
  }

  /**
   * A session with no project moves into one (runtime/move-project.ts): its project, the folder of
   * it, and the worktree made for it there, in one write. Refused for a session already in a project.
   */
  async moveToProject(id: string, to: { projectId: string; folderId: string; worktree: { path: string; branch: string } | null }): Promise<void> {
    const session = await this.db.getSession(id);
    if (!session) throw new Refused(`No such session: ${id}`);
    if (session.startedIn) throw new Refused('This session is already in a project.');
    const now = this.clock();
    await this.db.updateSession(id, { startedIn: to.projectId, startedFolderId: to.folderId, ...(to.worktree ? { worktreePath: to.worktree.path, branch: to.worktree.branch, worktreeDiscarded: false } : {}), updatedAt: now });
    this.changed();
  }

  /**
   * The branch the session's worktree is on now, when it is no longer the one it was made with (a
   * rename or a switch inside the worktree). Not activity: the session's last-active time stays.
   */
  async setBranch(id: string, branch: string): Promise<void> {
    if (!(await this.db.updateSession(id, { branch }))) throw new Refused(`No such session: ${id}`);
    this.changed();
  }

  async discardWorktree(id: string): Promise<void> {
    if (!(await this.db.updateSession(id, { worktreeDiscarded: true, worktreePath: null, updatedAt: this.clock() }))) throw new Refused(`No such session: ${id}`);
    this.changed();
  }

  /** After a restart agent processes are gone: anything that was running is interrupted. */
  async markRunningInterrupted(): Promise<number> {
    const n = await this.db.markRunningInterrupted();
    if (n > 0) this.changed();
    return n;
  }

  async setDetail(sessionId: string, detail: Partial<StoredDetail>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const current = (await tx.getDetail(sessionId)) ?? EMPTY_DETAIL;
      await tx.putDetail(sessionId, { ...current, ...detail });
    });
  }

  /**
   * Move a session to a group (or to no group). Links are never touched.
   * A session with children moves with the part of its subtree that sits in the same group;
   * a child moves alone and then shows at the top level of its new group with a "from" mark.
   */
  async moveSession(id: string, groupId: string | null): Promise<string[]> {
    const moved = await this.db.transaction((tx) => this.moveWithin(tx, id, groupId));
    this.changed();
    return moved;
  }

  private async moveWithin(tx: Persistence, id: string, groupId: string | null): Promise<string[]> {
    const [sessions, links, groups] = await Promise.all([tx.listSessions(), tx.listLinks(), tx.listGroups()]);
    const session = sessions.find((s) => s.id === id);
    if (!session) throw new Refused(`No such session: ${id}`);
    const target = groupId === null ? null : groups.find((g) => g.id === groupId);
    if (target === undefined) throw new Refused('No such group.');
    const groupOf = new Map(sessions.map((s) => [s.id, s.groupId]));
    const moving = subtreeIds(id, links).filter((sid) => sid === id || groupOf.get(sid) === session.groupId);
    if (target) {
      const projects = await tx.listProjects();
      const byId = new Map(sessions.map((s) => [s.id, s]));
      for (const sid of moving) {
        const reason = joinRefusal(target, byId.get(sid)!, projectNamer(projects));
        if (reason) throw new Refused(reason);
      }
    }
    await tx.setSessionsGroup(moving, groupId, this.clock());
    return moving;
  }

  /**
   * "This work belongs in another repo." Starts a linked child in the target project. The child
   * goes in `to.groupId` when given (a group in that project, or in the Sessions list), else joins
   * its parent's group when that group can hold it (not another project's). The parent is kept and
   * shown as done. The manual "move to project" action is this same operation.
   */
  async handoff(parentId: string, to: { projectId: string; folderId?: string | null; summary: string; agent?: Agent; title?: string; markParentDone?: boolean; groupId?: string | null }): Promise<Session> {
    const limits = await this.limits.current();
    const child = await this.db.transaction(async (tx) => {
      const [sessions, links, projects, groups] = await Promise.all([tx.listSessions(), tx.listLinks(), tx.listProjects(), tx.listGroups()]);
      const parent = sessions.find((s) => s.id === parentId);
      if (!parent) throw new Refused(`No such session: ${parentId}`);
      if (!projects.some((p) => p.id === to.projectId)) throw new Refused(`No such project: ${to.projectId}. Call list_projects to see where you may work.`);
      // A handoff is not a delegation: the caller is finished and the new session is nobody's
      // child, so the delegation limits do not count it. A task may still not be passed on forever.
      if (handoffChain(parentId, links) + 1 > MAX_HANDOFFS_IN_A_ROW) throw new Refused(`This task has been handed off ${MAX_HANDOFFS_IN_A_ROW} times in a row. Do the work here, or tell the user where it belongs.`);
      const landing = { startedIn: to.projectId, landedIn: null };
      let groupId: string | null = null;
      if (to.groupId) {
        const group = groups.find((g) => g.id === to.groupId);
        if (!group) throw new Refused('No such group.');
        if (!fitsGroup(group, landing)) throw new Refused(`“${group.name}” is a group in another project than the one the session moves to.`);
        groupId = group.id;
      } else if (to.groupId === undefined && parent.groupId) {
        const group = groups.find((g) => g.id === parent.groupId);
        groupId = group && fitsGroup(group, landing) ? group.id : null;
      }
      const created = await this.insertSession(tx, { title: to.title ?? to.summary, agent: to.agent ?? parent.agent, startedIn: to.projectId, startedFolderId: to.folderId ?? null, groupId, state: 'running', note: 'Started by handoff' });
      await tx.insertLink({ id: randomUUID(), parentId, childId: created.id, kind: 'handoff' });
      await copyTags(tx, parentId, [created.id]);
      // A running caller is still finishing its turn: the runtime marks it done when that ends.
      if (to.markParentDone !== false) await tx.updateSession(parentId, { state: 'done', note: 'Handed off', updatedAt: this.clock() });
      return created;
    });
    this.changed();
    return child;
  }

  /**
   * Store a fork (fork.ts) in one write: its row, its copy of the conversation, the `fork` link to
   * the session it came from (lineage only) and that session's tags. The old session is only read.
   */
  /**
   * A sidebar about a finding (asides.ts): a session with its conversation, marked as one and linked
   * to nothing (the mark names where it comes from), so it is in no list and moves with nothing.
   */
  async addAside(fromId: string, aside: NewSession & { aside: NonNullable<NewSession['aside']> }, detail: StoredDetail): Promise<Session> {
    const created = await this.db.transaction(async (tx) => {
      if (!(await tx.getSession(fromId))) throw new Refused(`No such session: ${fromId}`);
      const session = await this.insertSession(tx, aside);
      await tx.putDetail(session.id, detail);
      return session;
    });
    this.changed();
    return created;
  }

  async addFork(fromId: string, fork: NewSession, detail: StoredDetail): Promise<Session> {
    const created = await this.db.transaction(async (tx) => {
      if (!(await tx.getSession(fromId))) throw new Refused(`No such session: ${fromId}`);
      const session = await this.insertSession(tx, fork);
      await tx.putDetail(session.id, detail);
      await tx.insertLink({ id: randomUUID(), parentId: fromId, childId: session.id, kind: 'fork' });
      await copyTags(tx, fromId, [session.id]);
      return session;
    });
    this.changed();
    return created;
  }

  /**
   * "An unrelated new task." A session with no link, not in the caller's folder. It still counts
   * against the live-session limit of the caller's tree, so a runaway caller cannot flood the app.
   */
  async spawn(callerId: string, task: { projectId: string; folderId?: string | null; title: string; agent?: Agent }): Promise<Session> {
    const limits = await this.limits.current();
    const created = await this.db.transaction(async (tx) => {
      const [sessions, links, projects] = await Promise.all([tx.listSessions(), tx.listLinks(), tx.listProjects()]);
      const caller = sessions.find((s) => s.id === callerId);
      if (!caller) throw new Refused(`No such session: ${callerId}`);
      if (!projects.some((p) => p.id === task.projectId)) throw new Refused(`No such project: ${task.projectId}. Call list_projects to see where you may work.`);
      checkLive(limits, callerId, 1, sessions, links);
      const spawned = await this.insertSession(tx, { title: task.title, agent: task.agent ?? caller.agent, startedIn: task.projectId, startedFolderId: task.folderId ?? null, groupId: null, state: 'running', note: 'Started by spawn' });
      await copyTags(tx, callerId, [spawned.id]);
      return spawned;
    });
    this.changed();
    return created;
  }

  /** The limit checks of `delegate`/`handoff`/`spawn`, without writing: ask before showing a card for a call that would be refused. */
  async checkLimits(callerId: string, adding: number, opts: { depth: boolean }): Promise<void> {
    const [sessions, links, limits] = await Promise.all([this.db.listSessions(), this.db.listLinks(), this.limits.current()]);
    if (!sessions.some((s) => s.id === callerId)) throw new Refused(`No such session: ${callerId}`);
    if (opts.depth) return checkLimits(limits, callerId, adding, sessions, links);
    checkLive(limits, callerId, adding, sessions, links);
  }

  /**
   * "This needs work in several repos." One child per task, each linked to the caller, which stays
   * as the orchestrator. Nothing is moved: every session stays filed where it is, and a child
   * begins in the orchestrator's group only when that group can hold it. A split that reaches
   * across projects makes a workstream pointing at the orchestrator and the children, or adds the
   * children to the one the orchestrator is already in (`delegateWorkstream`).
   */
  async delegate(orchestratorId: string, tasks: readonly DelegateTask[], named: { name?: string; objective?: string } = {}): Promise<{ workstream: Workstream | null; created: boolean; children: Session[] }> {
    const limits = await this.limits.current();
    const result = await this.db.transaction(async (tx) => {
      const [sessions, links, projects, groups, workstreams] = await Promise.all([tx.listSessions(), tx.listLinks(), tx.listProjects(), tx.listGroups(), tx.listWorkstreams()]);
      const orchestrator = sessions.find((s) => s.id === orchestratorId);
      if (!orchestrator) throw new Refused(`No such session: ${orchestratorId}`);
      if (tasks.length === 0) throw new Refused(limitMessage.noTasks());
      if (tasks.length > limits.maxChildrenPerDelegate) throw new Refused(limitMessage.tooManyTasks(limits, tasks.length));
      const known = new Set(projects.map((p) => p.id));
      for (const t of tasks) if (!known.has(t.projectId)) throw new Refused(`No such project: ${t.projectId}. Call list_projects to see where you may work.`);
      checkLimits(limits, orchestratorId, tasks.length, sessions, links);

      const group = groups.find((g) => g.id === orchestrator.groupId) ?? null;
      const children: Session[] = [];
      for (const t of tasks) {
        const child = await this.insertSession(tx, { title: t.title ?? t.brief, agent: t.agent ?? orchestrator.agent, startedIn: t.projectId, startedFolderId: t.folderId ?? null, groupId: childGroupId(group, t.projectId), state: 'running', note: 'Started by delegate', ...(t.hostId ? { hostId: t.hostId } : {}) });
        await tx.insertLink({ id: randomUUID(), parentId: orchestratorId, childId: child.id, kind: 'delegate' });
        children.push(child);
      }
      await copyTags(tx, orchestratorId, children.map((c) => c.id));

      const current = workstreamOf(workstreams, orchestratorId);
      const plan = delegateWorkstream(orchestrator, tasks.map((t) => t.projectId), current);
      if (plan === 'none') return { workstream: null, created: false, children };
      const added = children.map((c) => c.id);
      if (plan === 'create') {
        const workstream: Workstream = { id: randomUUID(), name: workstreamName(named.name ?? '') || workstreamName(orchestrator.title) || 'Workstream', objective: workstreamObjective(named.objective ?? ''), createdAt: this.clock(), sessionIds: [orchestratorId, ...added], status: 'active', archivedAt: null };
        await tx.insertWorkstream(workstream);
        return { workstream, created: true, children };
      }
      const workstream = { ...current!, sessionIds: [...current!.sessionIds, ...added] };
      await tx.setWorkstreamSessions(workstream.id, workstream.sessionIds);
      return { workstream, created: false, children };
    });
    this.changed();
    return result;
  }

  // ---- workstreams -----------------------------------------------------------------------

  /** Rename a workstream. An empty name is refused. */
  async renameWorkstream(id: string, name: string): Promise<void> {
    const cleaned = workstreamName(name);
    if (!cleaned) throw new Refused('A workstream needs a name.');
    if (!(await this.db.updateWorkstream(id, { name: cleaned }))) throw new Refused('No such workstream.');
    this.changed();
  }

  /** Say what a workstream is for. An empty objective clears it. */
  async setWorkstreamObjective(id: string, objective: string): Promise<void> {
    if (!(await this.db.updateWorkstream(id, { objective: workstreamObjective(objective) }))) throw new Refused('No such workstream.');
    this.changed();
  }

  /** Mark the work finished, or not finished after all. It stays in the sidebar until it is archived. */
  async setWorkstreamStatus(id: string, status: WorkstreamStatus): Promise<void> {
    if (!(await this.db.updateWorkstream(id, { status }))) throw new Refused('No such workstream.');
    this.changed();
  }

  /**
   * Archive a workstream: it leaves the sidebar and stays searchable. Only the grouping is
   * archived. Its sessions keep their history, their places and their links, and none is stopped:
   * it waits until none of them is still at work (`archiveRefusal`, Matt 2026-11-19).
   */
  async archiveWorkstream(id: string): Promise<void> {
    // The sessions in sight, as the sidebar has them: one archived by itself (or with its project or group) is put away.
    const { sessions, workstreams, archivedWorkstreams } = await this.state();
    const workstream = [...workstreams, ...archivedWorkstreams].find((w) => w.id === id);
    const refusal = workstream ? archiveRefusal(workstream, sessions) : null;
    if (refusal) throw new Refused(refusal);
    if (!(await this.db.updateWorkstream(id, { archivedAt: this.clock() }))) throw new Refused('No such workstream.');
    this.changed();
  }

  /** Back to the sidebar, with the work status it had. */
  async restoreWorkstream(id: string, opts: { withSessions?: boolean } = {}): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (!(await tx.updateWorkstream(id, { archivedAt: null }))) throw new Refused('No such workstream.');
      if (!opts.withSessions) return;
      // Its archived sessions come back with it (Settings → Archived): restored alone it would have none in sight.
      const sessionIds = (await tx.listWorkstreams()).find((w) => w.id === id)?.sessionIds ?? [];
      const current = await settings.readArchived(tx);
      const next = sessionIds.reduce((archived, sessionId) => setArchived(archived, 'session', sessionId, false), current);
      if (next !== current) await settings.saveArchived(tx, next);
    });
    this.changed();
  }

  /**
   * The user sent a new message in a session: continuing the work brings its workstream back
   * (`afterUserMessage`). True when an archived one was restored, so the session can say so.
   */
  async resumeWorkstreamOf(sessionId: string): Promise<boolean> {
    const result = await this.db.transaction(async (tx) => {
      const workstream = workstreamOf(await tx.listWorkstreams(), sessionId);
      const change = workstream ? afterUserMessage(workstream) : null;
      if (!workstream || !change) return { updated: false, restored: false };
      return { updated: await tx.updateWorkstream(workstream.id, change.patch), restored: change.restored };
    });
    if (!result.updated) return false;
    this.changed();
    return result.restored;
  }

  /**
   * Take a session out of a workstream. Only the reference goes: the session and its links stay, its
   * waits go. The lead stays (`removeRefusal`). Answers the place it had, for `addBackToWorkstream`.
   */
  async removeFromWorkstream(id: string, sessionId: string): Promise<{ index: number }> {
    const index = await this.db.transaction(async (tx) => {
      const workstream = (await tx.listWorkstreams()).find((w) => w.id === id);
      if (!workstream) throw new Refused('No such workstream.');
      const at = workstream.sessionIds.indexOf(sessionId);
      if (at < 0) throw new Refused(`That session is not in “${workstream.name}”.`);
      const refusal = removeRefusal(workstream, sessionId);
      if (refusal) throw new Refused(`${refusal}.`);
      await tx.deleteWaitsOf(sessionId);
      await tx.setWorkstreamSessions(id, workstream.sessionIds.filter((s) => s !== sessionId));
      return at;
    });
    this.changed();
    return { index };
  }

  /** Undo of `removeFromWorkstream`: put the session back at the place it had, never ahead of the lead. */
  async addBackToWorkstream(id: string, sessionId: string, index: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const workstreams = await tx.listWorkstreams();
      const workstream = workstreams.find((w) => w.id === id);
      if (!workstream) throw new Refused('No such workstream.');
      if (!(await tx.getSession(sessionId))) throw new Refused('That session no longer exists.');
      const other = workstreamOf(workstreams, sessionId);
      if (other) throw new Refused(other.id === id ? `That session is already in “${workstream.name}”.` : `That session is in “${other.name}” now.`);
      const at = Math.min(Math.max(1, Math.trunc(index)), workstream.sessionIds.length);
      await tx.setWorkstreamSessions(id, [...workstream.sessionIds.slice(0, at), sessionId, ...workstream.sessionIds.slice(at)]);
    });
    this.changed();
  }

  /** Record a wait between two sessions of a workstream, or replace its reason. Checked first by `checkWait` (shared/waits.ts). */
  async putWait(wait: Omit<SessionWait, 'createdAt'>): Promise<void> {
    await this.db.putWait({ ...wait, createdAt: this.clock() });
    this.changed();
  }

  /** End one wait. False when there was none. */
  async dropWait(waiterId: string, targetId: string): Promise<boolean> {
    const dropped = await this.db.deleteWait(waiterId, targetId);
    if (dropped) this.changed();
    return dropped;
  }

  /** Every declared wait as stored, archived sessions' included. */
  listWaits(): Promise<SessionWait[]> {
    return this.db.listWaits();
  }

  /** Deleting a workstream never deletes sessions or links; only the grouping goes. */
  async deleteWorkstream(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (!(await tx.listWorkstreams()).some((w) => w.id === id)) throw new Refused('No such workstream.');
      await tx.deleteWorkstream(id);
    });
    this.changed();
  }
}
