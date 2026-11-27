// Projects across the account's computers, the desk's side (docs/designs/account-sessions.md, sections
// 5.2 and 10; Matt, 2026-11-25): this computer writes one sealed record per project it has into the list
// `projects` (`ProjectUploader`, called from the held pass), and reads every other computer's into its
// replica (`ProjectSync`), so each computer lists the same projects whether or not it has their files.
//
// - Nothing is polled. The reader runs when the link comes up, when the service says `changed`, and when
//   the account's devices change, as the heads' reader does. With no account there is no key: nothing runs.
// - Only a computer in the keyring this one accepted may say it has a project, only under the record id
//   its project makes, and only as the writer the service names. Opening it at all proves the key.
// - A project kept off Kestrel Connect is never written, and one switched to kept off is deleted.
// - Records name the writer's own project id: two computers' clones of one repository are two records,
//   and one project in the list (account-view.ts matches them by repository key).
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { AccountProjects, HeldProject } from '../../account-projects.ts';
import type { Project } from '../../model.ts';
import { asProjectRecord, projectLabel, projectRecordOf, PROJECTS_LIST } from '../../shared/account-projects.ts';
import type { Machine } from '../../shared/machines.ts';
import { openRecord, sealRecord, tagOf } from '../account-key.ts';
import type { ReadyKey } from './account-keys.ts';
import type { HeldApi } from './held-api.ts';
import { WHOLE_AFTER_MS } from './replica-sync.ts';
import { ServiceRefusal } from './service.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('base64url').slice(0, 22);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What one upload is given by the held pass. */
export interface ProjectUpload {
  api: HeldApi;
  key: ReadyKey;
  desk: Machine;
  /** This computer's projects (not archived ones: archiving is the arrangement's, issue 51). */
  projects: readonly Project[];
  keptOff: readonly string[];
  repos(projectId: string): Promise<string[]>;
}

/**
 * Writes this computer's project records: every one once a run (the first pass after starting, or after
 * the key or device changed), then only the ones whose record would differ, and deletes the ones this
 * computer wrote that it no longer has or keeps off.
 */
export class ProjectUploader {
  private sent = new Map<string, string>();
  private scope: string | null = null;
  private reconciled = false;
  /** A service from before the change feed refuses a listed record: not tried again this run. */
  private refused = false;

  constructor(private readonly home: string = homedir()) {}

  async pass({ api, key, desk, projects, keptOff, repos }: ProjectUpload): Promise<void> {
    if (this.refused) return;
    const tag = (label: string) => tagOf(key.idKey, label);
    const scope = `${desk.id}|${tag('scope')}`;
    if (scope !== this.scope) {
      this.scope = scope;
      this.sent = new Map();
      this.reconciled = false;
    }
    const off = new Set(keptOff);
    const want = new Map<string, { project: Project; content: ReturnType<typeof projectRecordOf> }>();
    for (const project of projects) {
      if (off.has(project.id)) continue;
      want.set(tag(projectLabel(project.id)), { project, content: projectRecordOf(project, await repos(project.id), desk, this.home) });
    }
    const list = tag(PROJECTS_LIST);
    if (!this.reconciled) {
      // Records this computer wrote before (a project deleted or kept off while Kestrel was closed) go.
      let feed;
      try {
        feed = await api.changes(list, 0);
      } catch (error) {
        if (this.oldService(error)) return;
        throw error;
      }
      for (const c of feed.changes) if (!c.deleted && c.writer === desk.id && !want.has(c.id)) await this.remove(api, c.id);
      this.reconciled = true;
    }
    for (const [id, { project, content }] of want) {
      const h = hash(JSON.stringify(content));
      if (this.sent.get(id) === h) continue;
      try {
        await api.putRecord(id, { generation: key.generation, session: null, project: tag(`project|${desk.id}|${project.id}`), list, body: sealRecord(key.adk, 'record', id, key.generation, content) });
      } catch (error) {
        if (this.oldService(error)) return;
        throw error;
      }
      this.sent.set(id, h);
    }
    for (const id of [...this.sent.keys()]) {
      if (want.has(id)) continue;
      await this.remove(api, id);
      this.sent.delete(id);
    }
  }

  private async remove(api: HeldApi, id: string): Promise<void> {
    await api.deleteRecord(id).catch((error: unknown) => {
      if (!(error instanceof ServiceRefusal && error.status === 404)) throw error;
    });
  }

  private oldService(error: unknown): boolean {
    if (!(error instanceof ServiceRefusal && (error.status === 400 || error.status === 404))) return false;
    this.refused = true;
    console.error(`[kestrel] Kestrel Connect does not take project records yet, so other computers will list only the projects that have sessions: ${message(error)}`);
    return true;
  }
}

export interface ProjectSyncDeps {
  store: AccountProjects;
  /** The service, when the link is up; null otherwise. */
  api(): HeldApi | null;
  key(): ReadyKey | null;
  keyFor(generation: number): Buffer;
  desk(): { id: string } | null;
  /** The account's other computers that are in the keyring this computer accepted. */
  machines(): Machine[];
  now?(): number;
}

/** Reads the other computers' project records into the replica, as `ReplicaSync` reads heads. */
export class ProjectSync {
  private running: Promise<void> | null = null;
  private again = false;
  private closed = false;

  constructor(private readonly deps: ProjectSyncDeps) {}

  kick(): void {
    if (this.closed) return;
    void this.run();
  }

  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass()
      .catch((error: unknown) => console.error(`[kestrel] could not read the account's projects: ${message(error)}`))
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
    return this.running;
  }

  private async pass(): Promise<void> {
    const api = this.deps.api();
    const key = this.deps.key();
    const desk = this.deps.desk();
    if (!api || !key || !desk) return;
    const now = this.deps.now?.() ?? Date.now();
    const tag = (label: string) => tagOf(key.idKey, label);
    const machines = new Map(this.deps.machines().filter((m) => m.id !== desk.id).map((m) => [m.id, m]));
    const members = [...machines.keys()];
    const scope = `${desk.id}|${tag('scope')}`;
    const mark = await this.deps.store.feedMark();
    const known = new Set(Array.isArray(mark?.members) ? mark.members : []);
    const joined = members.some((id) => !known.has(id));
    const since = mark && mark.scope === scope && now - mark.at < WHOLE_AFTER_MS && !joined ? mark.seq : 0;

    const feed = await api.changes(tag(PROJECTS_LIST), since);
    const last = new Map(feed.changes.map((c) => [c.id, c]));
    const written = [...last.values()].filter((c) => !c.deleted && c.writer !== desk.id);
    const writers = new Map(written.map((c) => [c.id, c.writer]));
    const projects: HeldProject[] = [];
    for (const record of written.length > 0 ? await api.readRecords(written.map((c) => c.id)) : []) {
      if (!record.body) continue;
      try {
        const project = asProjectRecord(openRecord(this.deps.keyFor(record.generation), record.body, 'record', record.id, record.generation));
        if (!project) continue;
        const machine = machines.get(project.machine.id);
        // Only a computer of the keyring, as the writer the service names, under its project's own record.
        if (!machine || writers.get(record.id) !== machine.id || record.id !== tag(projectLabel(project.id))) continue;
        projects.push({ record: record.id, project: { ...project, machine: { id: machine.id, name: project.machine.name || machine.name } } });
      } catch {
        // Not something this account's key opens: left out.
      }
    }
    const gone = [...last.values()].filter((c) => c.deleted).map((c) => c.id);
    await this.deps.store.apply({ projects, gone, members, whole: since === 0, mark: { seq: feed.next, at: now, scope, members } });
  }

  /** Signed out: nothing of the account stays. */
  async forget(): Promise<void> {
    await this.running?.catch(() => undefined);
    await this.deps.store.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.running?.catch(() => undefined);
  }
}
