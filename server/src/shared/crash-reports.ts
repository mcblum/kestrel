// Crash reports (Settings → General → Crash reports; Matt, 2026-11-21). When Kestrel itself fails,
// the error and where in Kestrel's code it happened go to Kestrel's own GlitchTip, so it can be
// fixed. On by default, with a switch. Pure, and shared by the server (crash-reports/) and the
// page (ui/src/crashReports.ts) so both decide and scrub the same way.
//
// What a report never carries: conversations, code, file contents, prompts, project names, the
// computer's name, the user's name or an IP address. Nothing is recorded on the way to a failure
// (no breadcrumbs), and the home folder is replaced with `~` wherever a path appears.

/**
 * Where reports go: the `kestrel` organization's project in Kestrel's GlitchTip. A DSN only lets a
 * client send reports, so it is not a secret and ships in the app. Empty would mean nothing is sent.
 */
export const CRASH_REPORTS_DSN = 'https://b54b35ef654a4dfca354fc74b2d4bfec@whoops.nationalmachine.io/13';

export interface CrashReportPrefs {
  /** Send a report when Kestrel fails. On by default. */
  enabled: boolean;
}

export const DEFAULT_CRASH_REPORT_PREFS: CrashReportPrefs = { enabled: true };

/** Stored or sent prefs made safe: anything that is not exactly `false` leaves it on. */
export function sanitizeCrashReportPrefs(value: unknown): CrashReportPrefs {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return { enabled: v.enabled !== false };
}

/** What a reporter is started with. */
export interface CrashReportSetup {
  dsn: string;
  /** `kestrel@<version>`. */
  release: string;
  environment: 'production' | 'development';
}

export interface CrashReportHost {
  /** The installed app, not a checkout. */
  packaged: boolean;
  version: string;
  /** KESTREL_CRASH_DSN: a test address. With it a checkout reports too, as `development`. */
  dsnOverride?: string;
}

/**
 * How this copy of Kestrel reports, or null when it never does: there is no address, or it is
 * run from a checkout (which never reports unless a test address is given). The switch is not
 * part of this: it is asked again for every report, so turning it off takes effect at once.
 */
export function crashReportSetup(host: CrashReportHost, dsn: string = CRASH_REPORTS_DSN): CrashReportSetup | null {
  const override = host.dsnOverride?.trim();
  const address = override || dsn;
  if (!address) return null;
  if (!host.packaged && !override) return null;
  return { dsn: address, release: `kestrel@${host.version || '0.0.0'}`, environment: host.packaged ? 'production' : 'development' };
}

/** What the page is told: the switch, and how to report (null: this copy never reports). */
export interface CrashReportStatus extends CrashReportPrefs {
  reporting: CrashReportSetup | null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `/Users/<name>` and the like, wherever they appear in a string, become `~`. */
export function scrubHome(text: string, home: string | undefined): string {
  const named = home && home.length > 1 ? text.replace(new RegExp(escapeRegExp(home), 'g'), '~') : text;
  return named.replace(/\/(Users|home)\/[^/\s:"'<>()]+/g, '~');
}

function scrubValue(value: unknown, home: string | undefined, depth: number): unknown {
  if (typeof value === 'string') return scrubHome(value, home);
  if (depth > 12 || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, home, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item, home, depth + 1)]));
}

/** The parts of a report that could say who or where the user is. Dropped whole. */
const DROPPED = ['user', 'request', 'breadcrumbs', 'server_name', 'extra', 'modules'] as const;
/** The only context kept: which system and runtime it failed on. */
const KEPT_CONTEXTS = ['os', 'runtime', 'app'] as const;

/**
 * A report made safe to send: a new object, the original untouched. Identifying parts are
 * dropped, only the system and runtime context is kept, and every path loses the home folder.
 */
export function scrubReport<T extends Record<string, unknown>>(event: T, home: string | undefined): T {
  const kept = Object.fromEntries(Object.entries(event).filter(([key]) => !(DROPPED as readonly string[]).includes(key)));
  const contexts = typeof kept.contexts === 'object' && kept.contexts !== null ? (kept.contexts as Record<string, unknown>) : null;
  const trimmed = contexts ? { ...kept, contexts: Object.fromEntries(Object.entries(contexts).filter(([key]) => (KEPT_CONTEXTS as readonly string[]).includes(key))) } : kept;
  return scrubValue(trimmed, home, 0) as T;
}
