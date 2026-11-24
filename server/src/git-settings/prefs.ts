// Where Settings → Git is kept: the branch name prefix (shared/branch-prefix.ts), whether new
// sessions start from the latest base branch (base-refresh.ts), and which reasons a session's pull
// request needs the user for are watched and offered a card (shared/request-attention.ts), as one small named setting in the store, so both persistence backends keep it. Shaped like suggestions/prefs.ts: writes
// run one after another, so two quick changes never lose one. Also resolves the prefix a new
// worktree's branch gets, which never fails: anything wrong falls back to the default.
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';
import { customPrefixProblem, DEFAULT_PREFIX, readBranchPrefixChoice, resolvePrefix, sanitizeBranchPrefix, type BranchPrefixSetting } from '../shared/branch-prefix.ts';
import { DEFAULT_ATTENTION_PREFS, isAttentionReason, sanitizeAttentionPrefs, type AttentionPrefs } from '../shared/request-attention.ts';
import { githubLoginLookup, type AccountLogin } from './github-login.ts';
import { gitlabLoginLookup } from './gitlab-login.ts';
import { usernameLookup } from './username.ts';

export const GIT_PREFS_KEY = 'git';
/** "Start new sessions from the latest base branch" is on until the user turns it off. */
export const DEFAULT_START_FROM_LATEST = true;

export interface GitPrefsView {
  branchPrefix: BranchPrefixSetting;
  /** Fetch the base branch and cut a new session's worktree from its newest commit. */
  startFromLatest: boolean;
  /** The account "Your username" uses: gh's login, else glab's. */
  username: AccountLogin;
}

export interface GitSettingsOptions {
  /** Where the setting is kept: the store's settings. In memory when absent (tests). */
  settings?: SettingStore;
  /** Who gh (else glab) is signed in as; asks the real ones once when absent. */
  username?: () => Promise<AccountLogin>;
}

/** A change the user asked for that cannot be saved, with what to fix. */
export class GitPrefsRefused extends Error {}

/** A stored or sent value checked strictly: refuses what sanitizing would quietly drop. */
function checked(raw: unknown, username: AccountLogin): BranchPrefixSetting {
  if (typeof raw !== 'object' || raw === null) throw new GitPrefsRefused('branchPrefix must be { choice, custom }.');
  const { custom } = raw as Record<string, unknown>;
  const choice = readBranchPrefixChoice((raw as Record<string, unknown>).choice);
  if (!choice) throw new GitPrefsRefused('choice must be username, custom, kestrel or none.');
  if (typeof custom !== 'string') throw new GitPrefsRefused('custom must be text.');
  const problem = custom === '' && choice !== 'custom' ? null : customPrefixProblem(custom);
  if (problem) throw new GitPrefsRefused(problem);
  if (choice === 'username' && !username.available) throw new GitPrefsRefused(`Your username is not available: ${username.reason}.`);
  return { choice, custom };
}

export class GitPrefs {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly attentionListeners = new Set<(prefs: AttentionPrefs) => void>();
  private readonly store: SettingStore;
  readonly username: () => Promise<AccountLogin>;

  constructor(opts: GitSettingsOptions = {}) {
    this.store = opts.settings ?? memorySettings();
    this.username = opts.username ?? usernameLookup(githubLoginLookup(), gitlabLoginLookup());
  }

  /** What is stored, as an object; {} when nothing or something unreadable is (the next write replaces it). */
  private async stored(): Promise<Record<string, unknown>> {
    const raw = await this.store.getSetting(GIT_PREFS_KEY);
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  async branchPrefix(): Promise<BranchPrefixSetting> {
    return sanitizeBranchPrefix((await this.stored()).branchPrefix ?? null);
  }

  /** Whether new sessions start from the latest base branch. Never throws: on any failure, the default. */
  async startFromLatest(): Promise<boolean> {
    try {
      const value = (await this.stored()).startFromLatest;
      return typeof value === 'boolean' ? value : DEFAULT_START_FROM_LATEST;
    } catch (error) {
      console.error('[kestrel] could not read "Start new sessions from the latest base branch"; using the default', error);
      return DEFAULT_START_FROM_LATEST;
    }
  }

  /** Pull requests that need you: which reasons are watched, and whether each one's card is offered. Never throws. */
  async attention(): Promise<AttentionPrefs> {
    try {
      return sanitizeAttentionPrefs((await this.stored()).requestAttention);
    } catch (error) {
      console.error('[kestrel] could not read "Pull requests that need you"; using the defaults', error);
      return DEFAULT_ATTENTION_PREFS;
    }
  }

  /** Calls `listener` after every saved change to `attention()`; returns how to stop. */
  onAttentionChange(listener: (prefs: AttentionPrefs) => void): () => void {
    this.attentionListeners.add(listener);
    return () => void this.attentionListeners.delete(listener);
  }

  /**
   * Change one reason's choices: `{ reason, watch?, card? }`. Refuses anything else with the reason.
   * The card's "Don't ask again" calls this too, so there is one stored choice.
   */
  async setAttention(raw: unknown): Promise<AttentionPrefs> {
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    if (!isAttentionReason(body.reason)) throw new GitPrefsRefused('reason must be checks-failed, conflicts or changes-requested.');
    if (body.watch !== undefined && typeof body.watch !== 'boolean') throw new GitPrefsRefused('watch must be true or false.');
    if (body.card !== undefined && body.card !== 'ask' && body.card !== 'never') throw new GitPrefsRefused('card must be ask or never.');
    if (body.watch === undefined && body.card === undefined) throw new GitPrefsRefused('Nothing to change: send watch or card.');
    const reason = body.reason;
    await this.write(async () => {
      const now = await this.attention();
      const changed = { ...now[reason], ...(body.watch !== undefined ? { watch: body.watch as boolean } : {}), ...(body.card !== undefined ? { card: body.card as 'ask' | 'never' } : {}) };
      return { requestAttention: { ...now, [reason]: changed } };
    });
    const saved = await this.attention();
    for (const listener of this.attentionListeners) listener(saved);
    return saved;
  }

  async view(): Promise<GitPrefsView> {
    const [branchPrefix, startFromLatest, username] = await Promise.all([this.branchPrefix(), this.startFromLatest(), this.username()]);
    return { branchPrefix, startFromLatest, username };
  }

  /** Save a new branch prefix setting; throws GitPrefsRefused with the reason when it is not usable. */
  setBranchPrefix(raw: unknown): Promise<GitPrefsView> {
    return this.write(async (username) => ({ branchPrefix: checked(raw, username) }));
  }

  /** Turn "Start new sessions from the latest base branch" on or off; refuses anything but true or false. */
  setStartFromLatest(raw: unknown): Promise<GitPrefsView> {
    return this.write(async () => {
      if (typeof raw !== 'boolean') throw new GitPrefsRefused('startFromLatest must be true or false.');
      return { startFromLatest: raw };
    });
  }

  /** One change after another, each keeping the other settings as they are. */
  private write(change: (username: AccountLogin) => Promise<Partial<Omit<GitPrefsView, 'username'> & { requestAttention: AttentionPrefs }>>): Promise<GitPrefsView> {
    const work = this.writes.then(async () => {
      const username = await this.username();
      const changed = await change(username);
      const next = { branchPrefix: await this.branchPrefix(), startFromLatest: await this.startFromLatest(), requestAttention: await this.attention(), ...changed };
      await this.store.putSetting(GIT_PREFS_KEY, JSON.stringify(next));
      return { branchPrefix: next.branchPrefix, startFromLatest: next.startFromLatest, username };
    });
    this.writes = work.catch(() => undefined);
    return work;
  }

  /** The prefix for a branch made now ('' for none). Never throws: on any failure, the default. */
  async prefixForNewBranch(): Promise<string> {
    try {
      const setting = await this.branchPrefix();
      const username = setting.choice === 'username' ? await this.username() : null;
      return resolvePrefix(setting, username?.available ? username.login : null);
    } catch (error) {
      console.error('[kestrel] could not read the branch name prefix; using the default', error);
      return DEFAULT_PREFIX;
    }
  }
}
