// Kestrel's own credential store, kept from a confined session (shared/protected-files.ts).
import { describe, expect, it } from 'vitest';
import { commandNamesProtected, PROTECTED_FILE_NAMES, PROTECTED_REFUSAL, protectedRefusal } from './protected-files.ts';

const DATA = '/home/me/.kestrel';
const FILES = PROTECTED_FILE_NAMES.map((n) => `${DATA}/${n}`);
const resolve = (p: string) => (p.startsWith('/') ? p : `/w/child/${p}`);
const refused = (tool: string, input: Record<string, unknown>) => protectedRefusal({ tool, input }, FILES, resolve);

describe("a confined session and Kestrel's credential store", () => {
  it('names the sealed files and their plain fallbacks', () => {
    expect([...PROTECTED_FILE_NAMES].sort()).toEqual(['connect.json', 'connect.sealed', 'trackers.json', 'trackers.sealed']);
  });

  it('refuses a file tool aimed at one, reading or writing', () => {
    for (const name of PROTECTED_FILE_NAMES) expect(refused('Read', { file_path: `${DATA}/${name}` })).toBe(PROTECTED_REFUSAL);
    expect(refused('Write', { file_path: `${DATA}/trackers.json`, content: '{}' })).toBe(PROTECTED_REFUSAL);
    expect(refused('Edit', { file_path: `${DATA}/connect.json` })).toBe(PROTECTED_REFUSAL);
    expect(refused('Read', { file_path: '../../../home/me/.kestrel/trackers.json' })).toBeNull(); // resolved by the caller: this stand-in does not walk ..
    expect(refused('Read', { file_path: `${DATA}/kestrel.sqlite` })).toBeNull();
    expect(refused('Read', { file_path: 'package.json' })).toBeNull();
  });

  it('refuses a search over a folder that holds one, and lets a narrower one through', () => {
    expect(refused('Grep', { pattern: 'token', path: DATA })).toMatch(/Search a narrower folder/);
    expect(refused('Grep', { pattern: 'token', path: '/home/me' })).toMatch(/Search a narrower folder/);
    expect(refused('Glob', { pattern: '**/*.json', path: '/home/me' })).toMatch(/Search a narrower folder/);
    expect(refused('Glob', { pattern: '/home/me/.kestrel/*.sealed' })).toMatch(/Search a narrower folder/);
    expect(refused('Glob', { pattern: '**/trackers.json' })).toBe(PROTECTED_REFUSAL);
    expect(refused('Grep', { pattern: 'token', path: '/w/child' })).toBeNull();
    expect(refused('Glob', { pattern: 'src/**/*.ts' })).toBeNull();
  });

  it('refuses a command that names one, for every provider’s way of carrying it', () => {
    expect(refused('Bash', { command: `cat ${DATA}/trackers.json` })).toBe(PROTECTED_REFUSAL);
    expect(refused('Bash', { command: 'cd ~/.kestrel && base64 connect.sealed' })).toBe(PROTECTED_REFUSAL);
    expect(refused('Command', { detail: "/bin/zsh -lc 'cp ~/.kestrel/trackers.sealed /tmp'" })).toBe(PROTECTED_REFUSAL);
    expect(refused('Bash', { command: 'cat package.json && ls trackers.json.d' })).toBeNull();
    expect(commandNamesProtected('my-trackers.json', FILES)).toBe(false);
    expect(commandNamesProtected('"trackers.json"', FILES)).toBe(true);
  });

  it('refuses nothing when there is nothing to protect (a session nobody else started)', () => {
    expect(protectedRefusal({ tool: 'Read', input: { file_path: `${DATA}/trackers.json` } }, [], resolve)).toBeNull();
  });
});
