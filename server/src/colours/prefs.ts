// Where Settings → Colours is kept (shared/colours.ts): one small named setting in the store, so
// both persistence backends keep it. Shaped like review-settings/prefs.ts: writes run one after another.
import { DEFAULT_COLOURS, nextWorkstreamColour, sanitizeColours, type ColourSettings } from '../shared/colours.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const COLOURS_KEY = 'colours';

export class ColourPrefs {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;

  constructor(opts: { settings?: SettingStore } = {}) {
    this.store = opts.settings ?? memorySettings();
  }

  async current(): Promise<ColourSettings> {
    const raw = await this.store.getSetting(COLOURS_KEY);
    if (!raw) return DEFAULT_COLOURS;
    try {
      return sanitizeColours(JSON.parse(raw));
    } catch {
      return DEFAULT_COLOURS; // unreadable: the default, and the next write replaces it
    }
  }

  /** Replace the settings with `next(current)`, made whole, and return what was stored. */
  update(next: (current: ColourSettings) => ColourSettings): Promise<ColourSettings> {
    const work = this.writes.then(async () => {
      const updated = sanitizeColours(next(await this.current()));
      await this.store.putSetting(COLOURS_KEY, JSON.stringify(updated));
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }

  /** Give a workstream just made its colour (`nextWorkstreamColour`), unless workstreams are not coloured or it has one. */
  autoColourWorkstream(id: string, liveIds: readonly string[]): Promise<ColourSettings> {
    return this.update((current) =>
      !current.workstreamColours || current.workstreams[id] ? current : { ...current, workstreams: { ...current.workstreams, [id]: nextWorkstreamColour(current, liveIds.filter((x) => x !== id)) } },
    );
  }
}
