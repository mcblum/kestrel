// A project another computer of the account lists is added here by itself when its folder is already on this
// disk (Matt, 2026-11-26): cloned to the same place under the home folder and never added to Kestrel. Looked
// for when Kestrel starts and when a project this computer lacks first shows up, never per change after that;
// a clone made somewhere else is added from the project's page (account-project-here.ts).
//
// A repository is added this way once. If the person then removes the project, it stays removed: the
// repositories already added are remembered in a setting.
import type { Project, WorkspaceState } from './model.ts';
import type { FolderHere } from './account-project-here.ts';

/** The setting the repositories added this way are kept under: a JSON array of repository keys. */
export const ADOPTED_KEY = 'account-adopted';

export interface AdoptDeps {
  view(): Promise<Pick<WorkspaceState, 'projects'>>;
  find(project: Project): Promise<FolderHere | null>;
  /** Adds the folder as a project of that name; throws when it cannot (the name is taken, the folder is held). */
  create(name: string, path: string): Promise<unknown>;
  settings: { getSetting(key: string): Promise<string | null>; putSetting(key: string, value: string): Promise<void> };
  /** What the look found, step by step, for the log. */
  report?(project: Project): Promise<string>;
  log?(text: string): void;
  /**
   * A worker node, where not having a project is the normal state (it clones one when a session starts in it): one
   * line with how many were not found, instead of a line per project.
   */
  quiet?: boolean;
}

/** The one line a worker node logs for the account's projects it does not have. */
export const notHereCount = (count: number): string => `${count} project${count === 1 ? '' : 's'} of the account ${count === 1 ? 'is' : 'are'} not on this computer; each is cloned when a session starts in it`;

function keysOf(json: string | null): string[] {
  try {
    const raw: unknown = json === null ? [] : JSON.parse(json);
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export class AdoptHere {
  private looked = '';
  private running: Promise<string[]> | null = null;
  private again = false;

  constructor(private readonly deps: AdoptDeps) {}

  /** Looks again if the projects this computer lacks are not the ones last looked for. The names added. */
  check(): Promise<string[]> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = this.once().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.check().catch(() => undefined);
      }
    });
    this.running = run;
    return run;
  }

  private async once(): Promise<string[]> {
    const lacking = (await this.deps.view()).projects.filter((p) => p.away && (p.elsewhere?.repos.length ?? 0) > 0);
    const signature = lacking.map((p) => p.id).sort().join('\n');
    if (signature === this.looked) return [];
    this.looked = signature;
    const adopted = new Set(keysOf(await this.deps.settings.getSetting(ADOPTED_KEY)));
    const added: string[] = [];
    let missing = 0;
    for (const project of lacking) {
      const repos = project.elsewhere?.repos ?? [];
      if (repos.some((k) => adopted.has(k))) continue;
      const found = await this.deps.find(project).catch((error: unknown) => {
        this.deps.log?.(`could not look for ${project.name} on this computer: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (!found) {
        missing += 1;
        if (this.deps.quiet) continue;
        // Said once per look, so a clone that is here and was missed can be traced from the log.
        this.deps.log?.(`${project.name} was not found on this computer: ${(await this.deps.report?.(project).catch(() => null)) ?? 'nothing more is known'}`);
        continue;
      }
      try {
        await this.deps.create(project.name, found.path);
      } catch (error) {
        // Left for the person to add from its page, which says why.
        this.deps.log?.(`${project.name} was found on this computer and not added: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const key of repos) adopted.add(key);
      await this.deps.settings.putSetting(ADOPTED_KEY, JSON.stringify([...adopted]));
      this.deps.log?.(`${project.name} was found on this computer and added`);
      added.push(project.name);
    }
    if (this.deps.quiet && missing > 0) this.deps.log?.(notHereCount(missing));
    return added;
  }
}
