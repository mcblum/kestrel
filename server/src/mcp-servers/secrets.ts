// The secret values of Kestrel's MCP servers (docs/designs/mcp-servers.md, section 6), kept where the
// tracker keys are (tickets/credentials.ts): sealed under the key the app keeps in the OS keystore, or,
// where there is none, a file only the user can read, which Settings says. Never the database, never a
// log or a crash report, never another computer. Read only to show whether a value is set, and when a
// session starts that gets the server, to put each value into that server's own entry.
import { existsSync, readFileSync } from 'node:fs';
import type { ConnectStorage } from '../shared/connect.ts';
import type { McpSecrets } from '../shared/mcp-servers.ts';
import { openJson, sealJson, writeAtomically } from '../connect/link/vault.ts';

export interface McpSecretStore {
  readonly storage: ConnectStorage;
  read(): Promise<McpSecrets>;
  write(data: McpSecrets): Promise<void>;
}

/** Stored values, checked: anything malformed is dropped. Pure. */
export function asSecrets(raw: unknown): McpSecrets {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).flatMap(([name, values]) => {
      if (typeof values !== 'object' || values === null || Array.isArray(values)) return [];
      const kept = Object.entries(values as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '');
      return kept.length ? [[name, Object.fromEntries(kept)]] : [];
    }),
  );
}

export function sealedSecrets(path: string, key: Buffer): McpSecretStore {
  return {
    storage: 'keystore',
    async read() {
      if (!existsSync(path)) return {};
      try {
        return asSecrets(openJson(key, readFileSync(path)));
      } catch {
        // Never the contents: only that it could not be opened.
        console.error('[kestrel] the MCP servers’ secret values could not be opened; they read as not set');
        return {};
      }
    },
    async write(data) {
      writeAtomically(path, sealJson(key, data));
    },
  };
}

export function plainSecrets(path: string): McpSecretStore {
  return {
    storage: 'file',
    async read() {
      if (!existsSync(path)) return {};
      try {
        return asSecrets(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        return {};
      }
    },
    async write(data) {
      writeAtomically(path, Buffer.from(JSON.stringify(data), 'utf8'));
    },
  };
}

export function memorySecrets(initial: McpSecrets = {}, storage: ConnectStorage = 'keystore'): McpSecretStore {
  let data = initial;
  return {
    storage,
    read: async () => data,
    write: async (next) => {
      data = next;
    },
  };
}
