// Where the always-allowed list is kept: one small named setting in the store, so every persistence
// provider keeps it (shaped like project-edits/prefs.ts). Writes run one after another. The list
// is also held in memory once read, because the Claude adapter asks for it synchronously each time
// a run starts and at each command outside the sandbox.
import { homedir } from 'node:os';
import type { InputAnswer, SandboxAllowAccess } from '../agents/types.ts';
import type { InputCard } from '../model.ts';
import { Refused } from '../refused.ts';
import { entryId, type FolderAccess, type InactiveEntry, type SandboxAllowEntry, type SandboxAllowView, type SandboxOffer } from '../shared/sandbox-allow.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';
import { allowAnswer, chosenEntry, sandboxOffer } from './offer.ts';
import type { Bounds } from './match.ts';
import { commandEntryFromText, folderEntry, staleReason, type FolderContext } from './validate.ts';

export const SANDBOX_ALLOW_KEY = 'sandbox-allow';

export interface SandboxAllowOptions {
  settings?: SettingStore;
  /** The folders a folder entry must stay clear of, as they stand now. */
  context?: () => Promise<FolderContext>;
}

/** A context with nothing registered, for a list started without one (tests). */
const bareContext = async (): Promise<FolderContext> => ({ home: homedir(), dataDir: '/nonexistent-kestrel-data', projectFolders: [], worktrees: [] });

const isEntry = (v: unknown): v is SandboxAllowEntry => {
  const e = v as Record<string, unknown> | null;
  if (typeof e !== 'object' || e === null) return false;
  if (e.kind === 'command') return Array.isArray(e.words) && e.words.length > 0 && e.words.every((w) => typeof w === 'string');
  return e.kind === 'folder' && typeof e.path === 'string' && (e.access === 'read' || e.access === 'read-write');
};

/** A stored list made safe: anything malformed is dropped. */
export function sanitizeEntries(raw: unknown): SandboxAllowEntry[] {
  const list = (raw as { entries?: unknown } | null)?.entries;
  return Array.isArray(list) ? list.filter(isEntry) : [];
}

/** The list with `entry` in it: a folder already there takes the new access; a duplicate changes nothing. */
const withEntry = (list: readonly SandboxAllowEntry[], entry: SandboxAllowEntry): SandboxAllowEntry[] => [...list.filter((e) => entryId(e) !== entryId(entry)), entry];

/** The stored list split into what applies and what the rules now refuse (validate.ts `staleReason`). */
export function splitStored(stored: readonly SandboxAllowEntry[]): { applied: SandboxAllowEntry[]; inactive: InactiveEntry[] } {
  const judged = stored.map((entry) => ({ entry, reason: staleReason(entry) }));
  return {
    applied: judged.flatMap((j) => (j.reason === null ? [j.entry] : [])),
    inactive: judged.flatMap((j) => (j.reason === null ? [] : [{ entry: j.entry, reason: j.reason }])),
  };
}

interface Held {
  stored: readonly SandboxAllowEntry[];
  applied: readonly SandboxAllowEntry[];
  inactive: readonly InactiveEntry[];
}

const holding = (stored: readonly SandboxAllowEntry[]): Held => ({ stored, ...splitStored(stored) });

export class SandboxAllowList {
  private writes: Promise<unknown> = Promise.resolve();
  /** Everything stored, and the part of it in effect. */
  private held: Held | null = null;
  private readonly store: SettingStore;
  private readonly context: () => Promise<FolderContext>;

  constructor(opts: SandboxAllowOptions = {}) {
    this.store = opts.settings ?? memorySettings();
    this.context = opts.context ?? bareContext;
  }

  /** Everything stored, applied or not, read once. */
  private async load(): Promise<Held> {
    if (this.held) return this.held;
    const raw = await this.store.getSetting(SANDBOX_ALLOW_KEY);
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null; // unreadable: empty, and the next write replaces it
    }
    this.held = this.held ?? holding(sanitizeEntries(parsed));
    return this.held;
  }

  /** The entries in effect. */
  async entries(): Promise<SandboxAllowEntry[]> {
    return [...(await this.load()).applied];
  }

  /** What Settings shows: the entries in effect, and stored ones the rules now refuse, with the reason. */
  async view(): Promise<SandboxAllowView> {
    const held = await this.load();
    return { entries: [...held.applied], ...(held.inactive.length ? { inactive: [...held.inactive] } : {}) };
  }

  /** The entries in effect as last read or written; empty before the first read. */
  current(): readonly SandboxAllowEntry[] {
    return this.held?.applied ?? [];
  }

  private write(change: (list: readonly SandboxAllowEntry[]) => SandboxAllowEntry[]): Promise<SandboxAllowView> {
    const work = this.writes.then(async () => {
      const next = change((await this.load()).stored);
      await this.store.putSetting(SANDBOX_ALLOW_KEY, JSON.stringify({ entries: next }));
      this.held = holding(next);
      return this.view();
    });
    this.writes = work.catch(() => undefined);
    return work;
  }

  add(entry: SandboxAllowEntry): Promise<SandboxAllowView> {
    return this.write((list) => withEntry(list, entry));
  }

  /** From Settings: a command as typed, checked. */
  addCommand(text: string): Promise<SandboxAllowView> {
    return this.add(commandEntryFromText(text));
  }

  /** From Settings: a folder as typed, resolved and checked. */
  async addFolder(path: string, access: FolderAccess | unknown): Promise<SandboxAllowView> {
    return this.add(folderEntry(path, access, await this.context()));
  }

  /** Removes an entry, in effect or not. */
  async remove(id: string): Promise<SandboxAllowView> {
    if (!(await this.load()).stored.some((e) => entryId(e) === id)) throw new Refused('That entry is not on the always-allowed list any more.');
    return this.write((list) => list.filter((e) => entryId(e) !== id));
  }

  /**
   * The answer to pass to the agent for a card the user answered. An "Always allow" choice adds the
   * card's own offer to the list first (refused, with the reason, if it no longer passes), then allows.
   */
  async answerCard(card: InputCard | undefined, answer: InputAnswer): Promise<InputAnswer> {
    const entry = chosenEntry(card?.sandboxOffer, answer.optionId, await this.context());
    if (!entry) return answer;
    await this.add(entry);
    return allowAnswer(answer);
  }

  /** What a session's agent is handed: the list as it stands at each use, and the card's offer. */
  access(): SandboxAllowAccess {
    return {
      entries: () => this.current(),
      offer: async (command: string, bounds: Bounds): Promise<SandboxOffer> => sandboxOffer(command, bounds, await this.context()),
    };
  }
}
