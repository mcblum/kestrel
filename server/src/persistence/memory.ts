// In-memory provider. It exists to keep the facade honest: the same contract tests run against
// this and SQLite, so nothing above the facade can come to depend on SQL.
import type { WorkstreamPatch } from './types.ts';
import type { Group, Link, Pin, PinKind, Project, ProjectFolder, RequestLink, Session, SessionRequestLink, SessionWait, TagRow, Workstream } from '../model.ts';
import type { PullRequestState } from '../shared/details.ts';
import type { HostKind } from '../shared/host-terms.ts';
import { withSettledDefault } from '../shared/project-folders.ts';
import { pinKey, type PinRef } from '../shared/pins.ts';
import { createLocalPersistence } from './local.ts';
import type { LocalDriver, Persistence, SessionPatch, StoredDetail } from './types.ts';

interface Data {
  projects: Project[];
  groups: Group[];
  sessions: Session[];
  links: Link[];
  details: Map<string, StoredDetail>;
  settings: Map<string, string>;
  tags: Map<string, readonly string[]>;
  pins: Pin[];
  requests: Map<string, readonly RequestLink[]>;
  workstreams: Workstream[];
  waits: SessionWait[];
}

const empty = (): Data => ({ projects: [], groups: [], sessions: [], links: [], details: new Map(), settings: new Map(), tags: new Map(), pins: [], requests: new Map(), workstreams: [], waits: [] });
const copy = (d: Data): Data => ({ projects: [...d.projects], groups: [...d.groups], sessions: [...d.sessions], links: [...d.links], details: new Map(d.details), settings: new Map(d.settings), tags: new Map(d.tags), pins: [...d.pins], requests: new Map(d.requests), workstreams: [...d.workstreams], waits: [...d.waits] });

class MemoryDriver implements LocalDriver {
  private data = empty();
  private snapshot: Data | null = null;

  isEmpty() {
    return this.data.projects.length + this.data.sessions.length === 0;
  }
  listProjects() {
    return this.data.projects.map((p) => ({ ...p, folders: [...p.folders] }));
  }
  insertProject(p: Project) {
    this.data.projects = [...this.data.projects, withSettledDefault({ ...p, folders: [...p.folders] })];
  }
  private withFolders(projectId: string, change: (folders: readonly ProjectFolder[]) => ProjectFolder[]) {
    this.data.projects = this.data.projects.map((p) => (p.id === projectId ? withSettledDefault({ ...p, folders: change(p.folders) }) : p));
  }
  setDefaultFolder(projectId: string, folderId: string) {
    this.data.projects = this.data.projects.map((p) => (p.id === projectId && p.folders.some((f) => f.id === folderId) ? { ...p, defaultFolderId: folderId } : p));
  }
  insertFolder(projectId: string, folder: ProjectFolder) {
    this.withFolders(projectId, (folders) => [...folders, folder]);
  }
  deleteFolder(projectId: string, folderId: string) {
    const found = this.data.projects.some((p) => p.id === projectId && p.folders.some((f) => f.id === folderId));
    this.withFolders(projectId, (folders) => folders.filter((f) => f.id !== folderId));
    return found;
  }
  setFolderOrder(projectId: string, ids: readonly string[]) {
    this.withFolders(projectId, (folders) => [...folders].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)));
  }
  deleteProject(id: string) {
    const before = this.data.projects.length;
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    return this.data.projects.length < before;
  }
  renameProject(id: string, name: string) {
    const found = this.data.projects.some((p) => p.id === id);
    this.data.projects = this.data.projects.map((p) => (p.id === id ? { ...p, name } : p));
    return found;
  }
  getSetting(key: string) {
    return this.data.settings.get(key) ?? null;
  }
  putSetting(key: string, value: string) {
    this.data.settings = new Map(this.data.settings).set(key, value);
  }
  listGroups() {
    return [...this.data.groups].sort((a, b) => a.createdAt - b.createdAt);
  }
  insertGroup(g: Group) {
    this.data.groups = [...this.data.groups, g];
  }
  renameGroup(id: string, name: string) {
    const found = this.data.groups.some((g) => g.id === id);
    this.data.groups = this.data.groups.map((g) => (g.id === id ? { ...g, name } : g));
    return found;
  }
  setGroupProject(id: string, projectId: string | null) {
    const found = this.data.groups.some((g) => g.id === id);
    this.data.groups = this.data.groups.map((g) => (g.id === id ? { ...g, projectId } : g));
    return found;
  }
  deleteGroup(id: string) {
    this.data.groups = this.data.groups.filter((g) => g.id !== id);
    this.data.sessions = this.data.sessions.map((s) => (s.groupId === id ? { ...s, groupId: null } : s));
  }
  listSessions() {
    return [...this.data.sessions].sort((a, b) => a.createdAt - b.createdAt);
  }
  getSession(id: string) {
    return this.data.sessions.find((s) => s.id === id) ?? null;
  }
  deleteSession(id: string) {
    const found = this.data.sessions.some((s) => s.id === id);
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    this.data.links = this.data.links.filter((l) => l.parentId !== id && l.childId !== id);
    const details = new Map(this.data.details);
    details.delete(id);
    this.data.details = details;
    const tags = new Map(this.data.tags);
    tags.delete(id);
    this.data.tags = tags;
    const requests = new Map(this.data.requests);
    requests.delete(id);
    this.data.requests = requests;
    this.data.workstreams = this.data.workstreams.map((w) => (w.sessionIds.includes(id) ? { ...w, sessionIds: w.sessionIds.filter((s) => s !== id) } : w));
    this.deleteWaitsOf(id);
    return found;
  }
  insertSession(s: Session) {
    if (this.getSession(s.id)) throw new Error(`duplicate session ${s.id}`);
    this.data.sessions = [...this.data.sessions, s];
  }
  updateSession(id: string, patch: SessionPatch) {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const found = this.getSession(id) !== null;
    this.data.sessions = this.data.sessions.map((s) => (s.id === id ? { ...s, ...defined } : s));
    return found;
  }
  setSessionsGroup(ids: readonly string[], groupId: string | null, updatedAt: number) {
    const set = new Set(ids);
    this.data.sessions = this.data.sessions.map((s) => (set.has(s.id) ? { ...s, groupId, updatedAt } : s));
  }
  markRunningInterrupted() {
    const n = this.data.sessions.filter((s) => s.state === 'running').length;
    this.data.sessions = this.data.sessions.map((s) => (s.state === 'running' ? { ...s, state: 'interrupted' as const } : s));
    return n;
  }
  listLinks() {
    return [...this.data.links];
  }
  insertLink(l: Link) {
    if (this.data.links.some((x) => x.childId === l.childId)) throw new Error(`session ${l.childId} already has a parent`);
    this.data.links = [...this.data.links, l];
  }
  listTags(): TagRow[] {
    const order = [...this.data.tags.keys()].sort();
    return order.flatMap((sessionId) => this.data.tags.get(sessionId)!.map((tag) => ({ sessionId, tag })));
  }
  tagsOf(sessionId: string) {
    return [...(this.data.tags.get(sessionId) ?? [])];
  }
  setTags(sessionId: string, tags: readonly string[]) {
    const next = new Map(this.data.tags);
    if (tags.length) next.set(sessionId, [...tags]);
    else next.delete(sessionId);
    this.data.tags = next;
  }
  // The array is the order: a new pin goes on the end, a reorder rearranges it.
  listPins() {
    return [...this.data.pins];
  }
  putPin(p: Pin) {
    if (!this.data.pins.some((x) => x.kind === p.kind && x.id === p.id)) this.data.pins = [...this.data.pins, p];
  }
  setPinOrder(order: readonly PinRef[]) {
    const byKey = new Map(this.data.pins.map((p) => [pinKey(p), p]));
    const placed = order.flatMap((ref) => byKey.get(pinKey(ref)) ?? []);
    const placedKeys = new Set(placed.map(pinKey));
    this.data.pins = [...placed, ...this.data.pins.filter((p) => !placedKeys.has(pinKey(p)))];
  }
  deletePin(kind: PinKind, id: string) {
    const before = this.data.pins.length;
    this.data.pins = this.data.pins.filter((x) => !(x.kind === kind && x.id === id));
    return this.data.pins.length < before;
  }
  getDetail(sessionId: string) {
    return this.data.details.get(sessionId) ?? null;
  }
  putDetail(sessionId: string, detail: StoredDetail) {
    this.data.details = new Map(this.data.details).set(sessionId, detail);
  }
  listRequestLinks(sessionId: string) {
    return [...(this.data.requests.get(sessionId) ?? [])];
  }
  listAllRequestLinks(): SessionRequestLink[] {
    return [...this.data.requests].flatMap(([sessionId, links]) => links.map((link) => ({ ...link, sessionId })));
  }
  insertRequestLink(sessionId: string, link: RequestLink) {
    if (!this.getSession(sessionId)) throw new Error(`no session ${sessionId}`); // as SQLite's foreign key would
    const linked = this.data.requests.get(sessionId) ?? [];
    if (linked.some((l) => l.host === link.host && l.number === link.number)) return false;
    this.data.requests = new Map(this.data.requests).set(sessionId, [...linked, { ...link }]);
    return true;
  }
  setRequestState(sessionId: string, host: HostKind, number: number, state: PullRequestState) {
    const linked = this.data.requests.get(sessionId) ?? [];
    const target = linked.find((l) => l.host === host && l.number === number);
    if (!target || target.state === state) return false;
    this.data.requests = new Map(this.data.requests).set(sessionId, linked.map((l) => (l === target ? { ...l, state } : l)));
    return true;
  }
  listWorkstreams() {
    return [...this.data.workstreams].sort((a, b) => a.createdAt - b.createdAt).map((w) => ({ ...w, sessionIds: [...w.sessionIds] }));
  }
  insertWorkstream(w: Workstream) {
    this.data.workstreams = [...this.data.workstreams, { ...w, sessionIds: [...w.sessionIds] }];
  }
  updateWorkstream(id: string, patch: WorkstreamPatch) {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const found = this.data.workstreams.some((w) => w.id === id);
    this.data.workstreams = this.data.workstreams.map((w) => (w.id === id ? { ...w, ...defined } : w));
    return found;
  }
  setWorkstreamSessions(id: string, sessionIds: readonly string[]) {
    this.data.workstreams = this.data.workstreams.map((w) => (w.id === id ? { ...w, sessionIds: [...sessionIds] } : w));
  }
  deleteWorkstream(id: string) {
    this.data.workstreams = this.data.workstreams.filter((w) => w.id !== id);
    this.data.waits = this.data.waits.filter((w) => w.workstreamId !== id);
  }
  listWaits() {
    return this.data.waits.map((w) => ({ ...w }));
  }
  putWait(wait: SessionWait) {
    const same = (w: SessionWait) => w.waiterId === wait.waiterId && w.targetId === wait.targetId;
    this.data.waits = this.data.waits.some(same) ? this.data.waits.map((w) => (same(w) ? { ...wait } : w)) : [...this.data.waits, { ...wait }];
  }
  deleteWait(waiterId: string, targetId: string) {
    const before = this.data.waits.length;
    this.data.waits = this.data.waits.filter((w) => w.waiterId !== waiterId || w.targetId !== targetId);
    return this.data.waits.length < before;
  }
  deleteWaitsOf(sessionId: string) {
    this.data.waits = this.data.waits.filter((w) => w.waiterId !== sessionId && w.targetId !== sessionId);
  }
  begin() {
    this.snapshot = copy(this.data);
  }
  commit() {
    this.snapshot = null;
  }
  rollback() {
    if (this.snapshot) this.data = this.snapshot;
    this.snapshot = null;
  }
  close() {
    this.data = empty();
  }
}

export function memoryPersistence(): Persistence {
  return createLocalPersistence(new MemoryDriver());
}
