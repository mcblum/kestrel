// The one record of what's new: which notes were last shown, and the Settings → General switch
// "Show what's new after an update". The server owns it (one named setting, so every persistence
// provider keeps it); every window is pushed the view (`WhatsNewView`) and keeps no copy of its own.
//
// On start, `due` says whether this copy's notes are to open by themselves (shared/whats-new.ts
// `isDue`). The window opens them as a tab once and answers `markShown`; until it does, they stay due,
// so a quit before the window loaded loses nothing. With the switch off nothing opens, and the notes
// count as shown, so turning it on later does not bring back old notes.
import { firstRecord, isDue, releaseOf, sanitizeRecord, type CurrentNotes, type WhatsNewRecord, type WhatsNewView } from '../shared/whats-new.ts';
import type { SettingStore } from '../suggestions/prefs.ts';
import type { NotesSource } from './notes.ts';

export const WHATS_NEW_KEY = 'whats-new';
/** What the window kept its tabs in since before there were notes: its presence means this copy was used before. */
const UI_STATE_KEY = 'ui-state';

export interface WhatsNewDeps {
  settings: SettingStore;
  notes: NotesSource;
  /** This copy's version (KESTREL_APP_VERSION). */
  version: string;
  /** The installed app: only it opens notes by itself. A checkout or a plain browser never does. */
  packaged: boolean;
}

export class WhatsNew {
  private record: WhatsNewRecord | null = null;
  private current: CurrentNotes = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(view: WhatsNewView) => void>();
  readonly release: string | null;

  constructor(private readonly deps: WhatsNewDeps) {
    this.release = releaseOf(deps.version);
  }

  /** Called with the new view after every change. */
  onChange(listener: (view: WhatsNewView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The view now. The first call reads the record, and makes it when there is none. */
  view(): Promise<WhatsNewView> {
    return this.serial(async () => this.viewOf(await this.load()));
  }

  /** The window opened these notes (or the user did): they never open by themselves again. */
  markShown(shown: { release: string; hash: string }): Promise<WhatsNewView> {
    return this.change((r) => (r.shown?.release === shown.release && r.shown.hash === shown.hash ? r : { ...r, shown }));
  }

  setEnabled(enabled: boolean): Promise<WhatsNewView> {
    return this.change((r) => (r.enabled === enabled ? r : { ...r, enabled }));
  }

  private change(next: (record: WhatsNewRecord) => WhatsNewRecord): Promise<WhatsNewView> {
    return this.serial(async () => {
      const before = await this.load();
      const after = next(before);
      if (after !== before) {
        await this.save(after);
        const view = await this.viewOf(after);
        for (const listener of this.listeners) listener(view);
        return view;
      }
      return this.viewOf(after);
    });
  }

  private async viewOf(record: WhatsNewRecord): Promise<WhatsNewView> {
    const due = isDue({ packaged: this.deps.packaged, record, notes: this.current }) ? this.current : null;
    return { release: this.release, due, enabled: record.enabled, releases: await this.deps.notes.list() };
  }

  private async save(record: WhatsNewRecord): Promise<void> {
    await this.deps.settings.putSetting(WHATS_NEW_KEY, JSON.stringify(record));
    this.record = record;
  }

  private async load(): Promise<WhatsNewRecord> {
    if (this.record) return this.record;
    const notes = this.release ? await this.deps.notes.read(this.release) : null;
    this.current = notes ? { release: notes.release, hash: notes.hash } : null;
    const raw = await this.deps.settings.getSetting(WHATS_NEW_KEY);
    let stored: WhatsNewRecord | null = null;
    try {
      stored = sanitizeRecord(raw ? JSON.parse(raw) : null);
    } catch {
      stored = null; // unreadable: made again, as on a first run
    }
    let record = stored ?? firstRecord({ usedBefore: (await this.deps.settings.getSetting(UI_STATE_KEY)) !== null, notes: this.current });
    // Switched off: what would have opened counts as shown.
    if (!record.enabled && this.current && isDue({ packaged: this.deps.packaged, record: { ...record, enabled: true }, notes: this.current })) record = { ...record, shown: this.current };
    if (record !== stored && this.deps.packaged) await this.save(record);
    else this.record = record;
    return record;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
