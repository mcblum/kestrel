// The key that locks the server's protected store (server/src/connect/vault.ts): Kestrel Connect's
// sign-in and this computer's device keys. Made once, kept in userData encrypted by Electron's
// safeStorage, which holds its own key in the OS keystore (the Keychain on macOS, DPAPI on
// Windows, libsecret or KWallet on Linux). The server runs as a plain Node child and cannot reach
// safeStorage itself, so the app opens the key here and hands it over on a private pipe (fd 3),
// never in the environment, where every agent the server starts would inherit it.
//
// Where there is no keystore (Linux with none; safeStorage then falls back to a fixed key), no key
// is handed over: the server keeps the store in a file only the user can read, and Settings says so.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';

const KEY_FILE = 'connect-vault-key';
const KEY_BYTES = 32;

/** Whether safeStorage is backed by a real keystore here. */
function keystoreAvailable() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== 'linux') return true;
  // On Linux, 'basic_text' is a hard-coded key: no protection at all.
  const backend = safeStorage.getSelectedStorageBackend?.();
  return Boolean(backend) && backend !== 'basic_text' && backend !== 'unknown';
}

/** The vault key, made on first use; null where no keystore protects it. Call after `ready`. */
export function vaultKey() {
  try {
    if (!keystoreAvailable()) return null;
    const file = join(app.getPath('userData'), KEY_FILE);
    if (existsSync(file)) {
      const key = Buffer.from(safeStorage.decryptString(readFileSync(file)), 'base64');
      if (key.length === KEY_BYTES) return key;
    }
    const key = randomBytes(KEY_BYTES);
    writeFileSync(file, safeStorage.encryptString(key.toString('base64')), { mode: 0o600 });
    return key;
  } catch (error) {
    // Refused at the Keychain prompt, or the file is unreadable: the server falls back and says so.
    console.error(`[kestrel] the keystore could not be used: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
