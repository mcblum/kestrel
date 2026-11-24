// Kestrel Connect's protected store: the sign-in's tokens and this computer's device identity.
// Never the workspace database, never a log. Two kinds:
//
// - `keyedFileVault`: a file sealed with AES-256-GCM under a key the app keeps in the OS keystore
//   (app/vault-key.mjs hands it over on a private pipe). The spec's "kept in the OS keystore".
// - `plainFileVault`: where there is no keystore (a server run on its own from a checkout, Linux
//   with none), a file readable by the user only. Settings says so ("what cannot work says so").
//
// Both write to a temporary file and rename, so a crash never leaves half a store.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ConnectStorage } from '../../shared/connect.ts';

/** The sign-in, as the identity provider gave it. */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch. */
  accessExpiresAt: number;
  idToken: string | null;
  /** The account (the token's `sub`) and its address. */
  subject: string;
  email: string;
}

/** This computer as a device of one account: the service's id and its own identity keys (PEM). */
export interface StoredDevice {
  /** The account it was registered to (`sub`): a different account registers again. */
  subject: string;
  id: string;
  name: string;
  signing: { publicKey: string; privateKey: string };
  agreement: { publicKey: string; privateKey: string };
}

export interface VaultData {
  tokens: StoredTokens | null;
  device: StoredDevice | null;
  /** Part B's phones paired with this computer: read only to be deleted (protocol 3 has no pairing). */
  paired?: unknown;
  /** The device id whose public keys the service was given (`PUT /devices/keys`), so they are put once. */
  keysPut?: string;
  /** What this computer trusts about the account data key (account-keys.ts). Public keys only, never a key. */
  keys?: unknown;
}

export const EMPTY_VAULT: VaultData = { tokens: null, device: null };

export interface Vault {
  readonly storage: ConnectStorage;
  read(): Promise<VaultData>;
  write(data: VaultData): Promise<void>;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT = 1;

function asVaultData(raw: unknown): VaultData {
  if (typeof raw !== 'object' || raw === null) return EMPTY_VAULT;
  const data = raw as Partial<VaultData>;
  return { tokens: data.tokens ?? null, device: data.device ?? null, ...(data.paired !== undefined ? { paired: data.paired } : {}), ...(data.keys !== undefined ? { keys: data.keys } : {}), ...(typeof data.keysPut === 'string' ? { keysPut: data.keysPut } : {}) };
}

export function writeAtomically(path: string, bytes: Buffer): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/** Seals any JSON value under `key` (32 bytes): format byte, IV, tag, ciphertext. Also the tracker credentials' store (tickets/credentials.ts). */
export function sealJson(key: Buffer, value: unknown): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT]), iv, cipher.getAuthTag(), body]);
}

/** Opens what `sealJson` made; throws when the key is wrong or a byte was changed. */
export function openJson(key: Buffer, sealed: Buffer): unknown {
  if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== FORMAT) throw new Error('not a Kestrel sealed store');
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(sealed.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8'));
}

/** Seals `data` under `key` (32 bytes). */
export const seal = (key: Buffer, data: VaultData): Buffer => sealJson(key, data);

/** Opens what `seal` made; throws when the key is wrong or a byte was changed. */
export const open = (key: Buffer, sealed: Buffer): VaultData => asVaultData(openJson(key, sealed));

export function keyedFileVault(path: string, key: Buffer): Vault {
  if (key.length !== 32) throw new Error('The store key must be 32 bytes.');
  return {
    storage: 'keystore',
    async read() {
      if (!existsSync(path)) return EMPTY_VAULT;
      try {
        return open(key, readFileSync(path));
      } catch {
        // A new key (the keystore entry was reset) or a damaged file: start signed out.
        console.error('[kestrel] the Kestrel Connect store could not be opened; starting signed out');
        return EMPTY_VAULT;
      }
    },
    async write(data) {
      writeAtomically(path, seal(key, data));
    },
  };
}

export function plainFileVault(path: string): Vault {
  return {
    storage: 'file',
    async read() {
      if (!existsSync(path)) return EMPTY_VAULT;
      try {
        return asVaultData(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        return EMPTY_VAULT;
      }
    },
    async write(data) {
      writeAtomically(path, Buffer.from(JSON.stringify(data), 'utf8'));
    },
  };
}

/** For tests: held in memory, with what was written last. */
export function memoryVault(initial: VaultData = EMPTY_VAULT, storage: ConnectStorage = 'keystore'): Vault & { current(): VaultData } {
  let data = initial;
  return {
    storage,
    read: async () => data,
    write: async (next) => {
      data = next;
    },
    current: () => data,
  };
}

/**
 * The key the app handed over on the fd named by KESTREL_VAULT_KEY_FD, or null. Read once at start;
 * the variable is removed so nothing the server starts sees even where the key came from.
 */
export function readVaultKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const fd = Number(env.KESTREL_VAULT_KEY_FD);
  delete env.KESTREL_VAULT_KEY_FD;
  if (!Number.isInteger(fd) || fd < 3) return null;
  try {
    const key = Buffer.from(readFileSync(fd, 'utf8').trim(), 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}
