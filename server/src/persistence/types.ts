// The persistence facade. Everything above this file (workspace logic, HTTP, adapters) talks to
// `Persistence` and never to a database. A cloud version swaps the provider, not the callers.
//
// Rules for this interface:
//  - Async everywhere, even though the local provider is synchronous underneath: a hosted
//    database will not be.
//  - Storage-shaped only. No filing rules, limits or tree logic in a provider.
//  - Multi-step writes go through `transaction`, and use the `tx` handle they are given.
import type { Guest, Review } from '../shared/worktree-guests.ts';
import type { RoleRun } from '../shared/who-does-what.ts';
import type { StoredCommands } from '../shared/commands.ts';
import type { WaitingStep } from '../shared/waiting-steps.ts';
import type { Group, Link, Pin, PinKind, Project, ProjectFolder, RequestLink, Session, SessionDetail, SessionRequestLink, SessionWait, TagRow, Workstream } from '../model.ts';
import type { PullRequestState } from '../shared/details.ts';
import type { HostKind } from '../shared/host-terms.ts';
import type { PinRef } from '../shared/pins.ts';

export type StoredDetail = Pick<SessionDetail, 'messages' | 'files' | 'agentOutput' | 'kestrelTools' | 'kestrelMissing' | 'agentSessionId' | 'settings' | 'queue' | 'usage' | 'slashCommands'> & {
  /** News from sessions this one started, waiting for its next turn. Never shown; absent when there is none. */
  inbox?: readonly string[];
  /** Started by `spawn`: it has no link to say so, and it is held to its own worktree like any other child. */
  spawned?: boolean;
  /** The user chose "Allow all outside the sandbox" in this session: it is not asked again, restarts included. */
  outsideAllowed?: boolean;
  /** Sessions that asked this one for work (`ask_session`) and have not yet heard how its turn ended. */
  askers?: readonly string[];
  /** It works in another session's worktree (shared/worktree-guests.ts): whose, for which role, and whether it writes. */
  guest?: Guest;
  /** A review of this session's work by another agent (shared/worktree-guests.ts): where it stands. */
  review?: Review;
  /** The role's part it was started for, and who has been tried (shared/who-does-what.ts). */
  roleRun?: RoleRun;
  /** The user picked its model themselves: Kestrel does not move it to the Orchestrate preset. */
  modelChosen?: boolean;
  /** The Commands pane: what the session's agent ran, and the end of what each printed. Absent when it ran nothing. */
  commands?: StoredCommands;
  /** Kestrel's own steps waiting on a card in this conversation, taken up again after a restart (shared/waiting-steps.ts). Absent when there is none. */
  steps?: readonly WaitingStep[];
};

/** What of a workstream can change in place. Its sessions are set with `setWorkstreamSessions`. */
export type WorkstreamPatch = Partial<Pick<Workstream, 'name' | 'objective' | 'status' | 'archivedAt'>>;

export type SessionPatch = Partial<Pick<Session, 'title' | 'state' | 'note' | 'startedIn' | 'startedFolderId' | 'landedIn' | 'worktreePath' | 'branch' | 'worktreeDiscarded' | 'groupId' | 'updatedAt' | 'lastActivityAt' | 'completedAt' | 'stopped' | 'turnByUser'>>;

export interface Persistence {
  isEmpty(): Promise<boolean>;

  /** Each with its folders, in their order, and its default folder (always one of them, or null when it has none). */
  listProjects(): Promise<Project[]>;
  /** The project and its directories, in the order given. */
  insertProject(project: Project): Promise<void>;
  /** Adds a directory after the project's others. */
  insertFolder(projectId: string, folder: ProjectFolder): Promise<void>;
  /** Returns false when the project has no such directory. */
  deleteFolder(projectId: string, folderId: string): Promise<boolean>;
  /** Puts the project's directories in this order; `ids` lists each of them once. */
  setFolderOrder(projectId: string, ids: readonly string[]): Promise<void>;
  /** Makes one of the project's folders its default; a folder not in the project changes nothing. */
  setDefaultFolder(projectId: string, folderId: string): Promise<void>;
  /** Returns false when the project does not exist. Callers check it has no sessions first. */
  deleteProject(id: string): Promise<boolean>;
  /** Returns false when the project does not exist. */
  renameProject(id: string, name: string): Promise<boolean>;

  listGroups(): Promise<Group[]>;
  insertGroup(group: Group): Promise<void>;
  /** Returns false when the group does not exist. */
  renameGroup(id: string, name: string): Promise<boolean>;
  /** Deletes the group record only; its sessions become ungrouped. */
  deleteGroup(id: string): Promise<void>;
  /** Puts the group in a project (null: the Sessions list). Returns false when the group does not exist. */
  setGroupProject(id: string, projectId: string | null): Promise<boolean>;

  listSessions(): Promise<Session[]>;
  getSession(id: string): Promise<Session | null>;
  insertSession(session: Session): Promise<void>;
  /** Removes the session with its stored conversation and its links. Returns false when it does not exist. */
  deleteSession(id: string): Promise<boolean>;
  /** Returns false when the session does not exist. */
  updateSession(id: string, patch: SessionPatch): Promise<boolean>;
  setSessionsGroup(ids: readonly string[], groupId: string | null, updatedAt: number): Promise<void>;
  /** Marks every running session interrupted; returns how many. */
  markRunningInterrupted(): Promise<number>;

  listLinks(): Promise<Link[]>;
  insertLink(link: Link): Promise<void>;

  /** Every session's tags, each session's in the order they were added. A deleted session's go with it. */
  listTags(): Promise<TagRow[]>;
  tagsOf(sessionId: string): Promise<string[]>;
  /** Replaces the session's tags with `tags`, in that order. */
  setTags(sessionId: string, tags: readonly string[]): Promise<void>;

  /** Every workstream, oldest first, each with its sessions in the order they joined. A deleted session leaves them. */
  listWorkstreams(): Promise<Workstream[]>;
  /** The workstream and its sessions, in the order given. */
  insertWorkstream(workstream: Workstream): Promise<void>;
  /** Returns false when the workstream does not exist. */
  updateWorkstream(id: string, patch: WorkstreamPatch): Promise<boolean>;
  /** Replaces the workstream's sessions with `sessionIds`, in that order. */
  setWorkstreamSessions(id: string, sessionIds: readonly string[]): Promise<void>;
  /** Deletes the workstream record only; its sessions are untouched. Its waits go with it. */
  deleteWorkstream(id: string): Promise<void>;

  /** Every declared wait between sessions, oldest first. A deleted session's, or workstream's, go with it. */
  listWaits(): Promise<SessionWait[]>;
  /** Records a wait; one already there for the same waiter and target is replaced. */
  putWait(wait: SessionWait): Promise<void>;
  /** Returns false when there was no such wait. */
  deleteWait(waiterId: string, targetId: string): Promise<boolean>;
  /** Deletes every wait the session is in, on either side. */
  deleteWaitsOf(sessionId: string): Promise<void>;

  /** Pinned items, in the user's order. */
  listPins(): Promise<Pin[]>;
  /** Pins an item at the end of the list; one already pinned keeps its place. */
  putPin(pin: Pin): Promise<void>;
  /** Puts the pins in this order; `order` lists every stored pin once. */
  setPinOrder(order: readonly PinRef[]): Promise<void>;
  /** Returns false when it was not pinned. */
  deletePin(kind: PinKind, id: string): Promise<boolean>;

  /** Small named values (UI state). Stored as text; the caller owns the format. */
  getSetting(key: string): Promise<string | null>;
  putSetting(key: string, value: string): Promise<void>;

  getDetail(sessionId: string): Promise<StoredDetail | null>;
  putDetail(sessionId: string, detail: StoredDetail): Promise<void>;

  /** The requests linked to a session, in the order they were linked. A deleted session's go with it. */
  listRequestLinks(sessionId: string): Promise<RequestLink[]>;
  /** Every session's linked requests, each session's in the order they were linked. */
  listAllRequestLinks(): Promise<SessionRequestLink[]>;
  /** Links a request; false (nothing changed) when that host and number are already linked. Throws when there is no such session. */
  insertRequestLink(sessionId: string, link: RequestLink): Promise<boolean>;
  /** Records a linked request's last-seen state; false when it is not linked or already had that state. */
  setRequestState(sessionId: string, host: HostKind, number: number, state: PullRequestState): Promise<boolean>;

  /**
   * Run `fn` atomically. Everything inside must use `tx`. If `fn` throws, nothing it wrote is
   * kept. Transactions and single calls on the same provider never interleave.
   */
  transaction<T>(fn: (tx: Persistence) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/**
 * What a local, synchronous storage engine implements. `createLocalPersistence` turns one of
 * these into a `Persistence` with serialized access and transactions. A remote provider
 * implements `Persistence` directly instead.
 */
export interface LocalDriver {
  isEmpty(): boolean;
  listProjects(): Project[];
  insertProject(project: Project): void;
  insertFolder(projectId: string, folder: ProjectFolder): void;
  deleteFolder(projectId: string, folderId: string): boolean;
  setFolderOrder(projectId: string, ids: readonly string[]): void;
  setDefaultFolder(projectId: string, folderId: string): void;
  deleteProject(id: string): boolean;
  renameProject(id: string, name: string): boolean;
  listGroups(): Group[];
  insertGroup(group: Group): void;
  renameGroup(id: string, name: string): boolean;
  deleteGroup(id: string): void;
  setGroupProject(id: string, projectId: string | null): boolean;
  listSessions(): Session[];
  getSession(id: string): Session | null;
  insertSession(session: Session): void;
  deleteSession(id: string): boolean;
  updateSession(id: string, patch: SessionPatch): boolean;
  setSessionsGroup(ids: readonly string[], groupId: string | null, updatedAt: number): void;
  markRunningInterrupted(): number;
  listLinks(): Link[];
  insertLink(link: Link): void;
  listTags(): TagRow[];
  tagsOf(sessionId: string): string[];
  setTags(sessionId: string, tags: readonly string[]): void;
  listWorkstreams(): Workstream[];
  insertWorkstream(workstream: Workstream): void;
  updateWorkstream(id: string, patch: WorkstreamPatch): boolean;
  setWorkstreamSessions(id: string, sessionIds: readonly string[]): void;
  deleteWorkstream(id: string): void;
  listWaits(): SessionWait[];
  putWait(wait: SessionWait): void;
  deleteWait(waiterId: string, targetId: string): boolean;
  deleteWaitsOf(sessionId: string): void;
  listPins(): Pin[];
  putPin(pin: Pin): void;
  setPinOrder(order: readonly PinRef[]): void;
  deletePin(kind: PinKind, id: string): boolean;
  getSetting(key: string): string | null;
  putSetting(key: string, value: string): void;
  getDetail(sessionId: string): StoredDetail | null;
  putDetail(sessionId: string, detail: StoredDetail): void;
  listRequestLinks(sessionId: string): RequestLink[];
  listAllRequestLinks(): SessionRequestLink[];
  insertRequestLink(sessionId: string, link: RequestLink): boolean;
  setRequestState(sessionId: string, host: HostKind, number: number, state: PullRequestState): boolean;
  begin(): void;
  commit(): void;
  rollback(): void;
  close(): void;
}
