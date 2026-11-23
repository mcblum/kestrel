// What a tracker needs to be asked, kept where Kestrel Connect keeps its sign-in (docs/designs/
// tickets.md, section 3): sealed under the key the app keeps in the OS keystore, or, where there is
// none, a file only the user can read, which Settings says. Never the workspace database, never an
// agent's environment, never a log. Today: Jira Cloud's site, account email and API token, and a
// Linear personal API key.
import { existsSync, readFileSync } from 'node:fs';
import type { ConnectStorage } from '../shared/connect.ts';
import { openJson, sealJson, writeAtomically } from '../connect/link/vault.ts';
import { siteHost } from './sources/jira.ts';

export interface JiraCredentials {
  /** The site's host: `acme.atlassian.net`. */
  site: string;
  email: string;
  token: string;
  /** Who the token belongs to, as Jira named them when it was connected: shown, never secret. */
  name?: string;
}

export interface LinearCredentials {
  /** A personal API key, pasted. */
  key: string;
  /** Who the key belongs to, as Linear named them when it was connected: shown, never secret. */
  name?: string;
}

export interface TrackerCredentials {
  jira: JiraCredentials | null;
  linear: LinearCredentials | null;
}

export const NO_CREDENTIALS: TrackerCredentials = { jira: null, linear: null };

export interface CredentialStore {
  readonly storage: ConnectStorage;
  read(): Promise<TrackerCredentials>;
  write(data: TrackerCredentials): Promise<void>;
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const fieldsOf = (raw: unknown, name: string): Record<string, unknown> | null => {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[name] : null;
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
};

/** Stored credentials, checked: anything malformed reads as that tracker not connected. Pure. */
export function asCredentials(raw: unknown): TrackerCredentials {
  const j = fieldsOf(raw, 'jira');
  const l = fieldsOf(raw, 'linear');
  return {
    // A stored site is held to the same rule as a typed one, so a file edited by hand sends the token nowhere else.
    jira: j && str(j.site) && siteHost(j.site) === j.site && str(j.email) && str(j.token) ? { site: j.site, email: j.email, token: j.token, ...(str(j.name) ? { name: j.name } : {}) } : null,
    linear: l && str(l.key) ? { key: l.key, ...(str(l.name) ? { name: l.name } : {}) } : null,
  };
}

export function sealedCredentials(path: string, key: Buffer): CredentialStore {
  return {
    storage: 'keystore',
    async read() {
      if (!existsSync(path)) return NO_CREDENTIALS;
      try {
        return asCredentials(openJson(key, readFileSync(path)));
      } catch {
        console.error('[kestrel] the tracker credentials could not be opened; trackers read as not connected');
        return NO_CREDENTIALS;
      }
    },
    async write(data) {
      writeAtomically(path, sealJson(key, data));
    },
  };
}

export function plainCredentials(path: string): CredentialStore {
  return {
    storage: 'file',
    async read() {
      if (!existsSync(path)) return NO_CREDENTIALS;
      try {
        return asCredentials(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        return NO_CREDENTIALS;
      }
    },
    async write(data) {
      writeAtomically(path, Buffer.from(JSON.stringify(data), 'utf8'));
    },
  };
}

export function memoryCredentials(initial: TrackerCredentials = NO_CREDENTIALS, storage: ConnectStorage = 'keystore'): CredentialStore {
  let data = initial;
  return {
    storage,
    read: async () => data,
    write: async (next) => {
      data = next;
    },
  };
}
