// File records (docs/designs/onboarding.md, 18.3): what Bring over writes on another computer. One sealed
// record per Agent settings line, at `tag("setup-files|<machine id>|<line id>")`, written beside the
// set-up record. Only what the set-up record already carries goes in: a file in which a key shape was
// found is left out whole (O11), and a settings file is split first (`settingsFileOf`): the values of
// its `env` blocks and headers, and any value whose name says it is a key or that looks like one, at
// any depth, become named blanks, entered on the computer it is brought to. Pure.
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { Agent } from '../model.ts';
import { homePath, keyLineIn, looksLikeKey, type FoundFile, type MachineInventory } from './setup-record.ts';

export const SETUP_FILES_VERSION = 1;

/** One file as carried. */
export interface CarriedFile {
  /** `~/…` */
  path: string;
  text: string;
}

/** A value left out of a settings file: its name as the line shows it, and where it goes in the file. */
export interface FileBlank {
  path: string;
  name: string;
  at: string[];
}

export interface SetupFileRecord {
  v: number;
  kind: 'setup-files';
  machine: string;
  line: string;
  agent: Agent;
  files: CarriedFile[];
  blanks: FileBlank[];
  /** Files not carried, and why ("a binary file", "did not parse"). Never their text. */
  skipped: { path: string; why: string }[];
}

export const setupFilesLabel = (machineId: string, lineId: string): string => `setup-files|${machineId}|${lineId}`;

/** The service takes a record of up to 30 MB (Matt, Q1); a line larger than this is not carried. */
export const FILE_RECORD_MAX_BYTES = 24 * 1024 * 1024;

const GROUPED = new Set(['skill', 'rules']);
const BLANK_PARENTS = new Set(['env', 'http_headers', 'env_http_headers', 'headers']);
const KEY_NAME = /(api[_-]?key|token|secret|password|passwd|credential|private[_-]?key|auth(orization)?$)/i;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Blanks out what may be a secret in a parsed settings value; answers the copy and where each blank was. */
function blankOut(value: unknown, at: string[], blanks: { name: string; at: string[] }[], underBlankParent = false): unknown {
  if (Array.isArray(value)) return value.map((v, i) => blankOut(v, [...at, String(i)], blanks));
  if (isObj(value)) {
    // Every value directly under `env`, `headers` and the like is a blank, whatever it looks like.
    const blankChildren = BLANK_PARENTS.has(at[at.length - 1] ?? '');
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, blankOut(v, [...at, key], blanks, blankChildren)]));
  }
  if (typeof value !== 'string') return value;
  const name = at[at.length - 1] ?? '';
  // A key inside a longer value (`run <key>`) counts: every word is checked.
  if (underBlankParent || KEY_NAME.test(name) || looksLikeKey(value) || value.split(/[\s=:,;'"]+/).some((word) => looksLikeKey(word))) {
    blanks.push({ name: underBlankParent ? name : at.join('.'), at });
    return '';
  }
  return value;
}

/** A settings file with every possible secret left out, or null when it does not parse (then it is not carried). */
export function settingsFileOf(path: string, text: string): { text: string; blanks: { name: string; at: string[] }[] } | null {
  const blanks: { name: string; at: string[] }[] = [];
  if (path.endsWith('.toml')) {
    let parsed: Record<string, unknown>;
    try {
      parsed = parseToml(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    // MCP servers come through Kestrel's own list, never through an agent's file.
    const { mcp_servers: _dropped, ...rest } = parsed;
    return { text: stringifyToml(blankOut(rest, [], blanks) as Record<string, unknown>) + '\n', blanks };
  }
  let parsed: unknown;
  try {
    // OpenCode allows comments (`.jsonc`): a file with them is not carried rather than guessed at.
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return { text: JSON.stringify(blankOut(parsed, [], blanks), null, 2) + '\n', blanks };
}

/** The line a found file belongs to, as `setupListOf` names it. */
function lineIdOf(found: FoundFile, home: string): string {
  return GROUPED.has(found.kind) ? `files:${found.agent}:${found.kind}` : `file:${homePath(found.path, home)}`;
}

/** Every file record of this machine, by line. Files with a key in them are left out whole. Pure. */
export function fileRecordsOf(found: MachineInventory): SetupFileRecord[] {
  const home = found.home;
  const byLine = new Map<string, SetupFileRecord>();
  for (const f of found.files) {
    if (f.texts.some((t) => keyLineIn(t.text) !== null) && f.kind !== 'settings') continue;
    const line = lineIdOf(f, home);
    const record = byLine.get(line) ?? { v: SETUP_FILES_VERSION, kind: 'setup-files' as const, machine: found.machine.id, line, agent: f.agent, files: [], blanks: [], skipped: [] };
    byLine.set(line, record);
    for (const t of f.texts) {
      const path = homePath(t.path, home);
      if (t.text === '') {
        record.skipped.push({ path, why: 'a binary or very large file, which Kestrel cannot check for a key' });
        continue;
      }
      if (f.kind !== 'settings') {
        record.files.push({ path, text: t.text });
        continue;
      }
      const split = settingsFileOf(t.path, t.text);
      // A settings file that still shows a key after the split is not carried.
      if (!split || keyLineIn(split.text) !== null) {
        record.skipped.push({ path, why: split ? 'a value in it still looks like a key' : 'it did not parse' });
        continue;
      }
      record.files.push({ path, text: split.text });
      record.blanks.push(...split.blanks.map((b) => ({ path, ...b })));
    }
  }
  return [...byLine.values()];
}

/** A file record read back, checked for shape; anything else is null. */
export function asSetupFileRecord(value: unknown): SetupFileRecord | null {
  if (!isObj(value) || value.kind !== 'setup-files' || value.v !== SETUP_FILES_VERSION) return null;
  if (typeof value.machine !== 'string' || typeof value.line !== 'string' || typeof value.agent !== 'string') return null;
  const files = Array.isArray(value.files) ? value.files.filter((f): f is CarriedFile => isObj(f) && typeof f.path === 'string' && typeof f.text === 'string') : [];
  const blanks = Array.isArray(value.blanks) ? value.blanks.filter((b): b is FileBlank => isObj(b) && typeof b.path === 'string' && typeof b.name === 'string' && Array.isArray(b.at) && b.at.every((x) => typeof x === 'string')) : [];
  const skipped = Array.isArray(value.skipped) ? value.skipped.filter((s): s is { path: string; why: string } => isObj(s) && typeof s.path === 'string' && typeof s.why === 'string') : [];
  return { v: SETUP_FILES_VERSION, kind: 'setup-files', machine: value.machine, line: value.line, agent: value.agent as Agent, files, blanks, skipped };
}

/** A settings file's text with the values typed here put in at their blanks. Pure. */
export function fillBlanks(path: string, text: string, values: Readonly<Record<string, string>>): string {
  if (Object.keys(values).length === 0) return text;
  const parsed = path.endsWith('.toml') ? (parseToml(text) as Record<string, unknown>) : (JSON.parse(text) as unknown);
  const set = (node: unknown, at: string[], value: string): void => {
    if (!isObj(node) && !Array.isArray(node)) return;
    const [head, ...rest] = at;
    if (head === undefined) return;
    const target = node as Record<string, unknown>;
    if (rest.length === 0) target[head] = value;
    else set(target[head], rest, value);
  };
  for (const [encoded, value] of Object.entries(values)) set(parsed, JSON.parse(encoded) as string[], value);
  return path.endsWith('.toml') ? stringifyToml(parsed as Record<string, unknown>) + '\n' : JSON.stringify(parsed, null, 2) + '\n';
}
