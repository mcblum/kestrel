// Builds Kestrel Connect for the running server: the public service (KESTREL_CONNECT_URL for a
// self-hosted one), its realm, and the protected store: sealed under the app's keystore key when
// the app handed one over (app/vault-key.mjs), else a file only the user can read.
import { hostname } from 'node:os';
import { ConnectDispatcher } from '../dispatcher.ts';
import { hostPlatform } from '../../host.ts';
import type { SessionRuntime } from '../../runtime.ts';
import type { Envelope } from '../../shared/connect-ops.ts';
import type { Workspace } from '../../workspace.ts';
import { join } from 'node:path';
import { CONNECT_DESKTOP_CLIENT, CONNECT_SERVICE_URL } from '../../shared/connect.ts';
import type { SettingStore } from '../../suggestions/prefs.ts';
import { KestrelConnect } from './connect.ts';
import { OidcProvider } from './identity.ts';
import { HttpConnectService } from './service.ts';
import { keyedFileVault, plainFileVault, readVaultKey } from './vault.ts';
import { PROTECTED_FILES } from '../../shared/protected-files.ts';

export const SAMPLE_DATA_REASON = 'Kestrel Connect is off while Kestrel runs with sample data.';

/** The name other devices see: the host name without its local domain. */
export function computerName(name: string = hostname()): string {
  return name.replace(/\.(local|lan|home)$/i, '').trim() || 'This computer';
}

export function serviceUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.KESTREL_CONNECT_URL?.trim() || CONNECT_SERVICE_URL;
  return url.replace(/\/+$/, '');
}

/** `vaultKey`: the key the app handed over, read once by the caller (it is readable only once); absent, it is read here. */
export async function startConnect(opts: { dataDir: string; settings: SettingStore; fake: boolean; workspace: Workspace; runtime: SessionRuntime; vaultKey?: Buffer | null }): Promise<KestrelConnect> {
  const service = new HttpConnectService(serviceUrl());
  const identity = new OidcProvider(async () => (await service.config()).issuer, CONNECT_DESKTOP_CLIENT);
  const key = opts.vaultKey !== undefined ? opts.vaultKey : readVaultKey();
  const vault = key ? keyedFileVault(join(opts.dataDir, PROTECTED_FILES.connectSealed), key) : plainFileVault(join(opts.dataDir, PROTECTED_FILES.connectPlain));
  // How a refusal names this computer to the phone.
  const here = hostPlatform() === 'mac' ? 'your Mac' : 'your computer';
  // A paired phone's decrypted requests are carried out in process (connect/dispatcher.ts).
  const dispatch = (deviceId: string, send: (frame: Envelope) => void) => new ConnectDispatcher({ workspace: opts.workspace, runtime: opts.runtime, deviceId, here, send });
  const connect = new KestrelConnect({ vault, identity, service, settings: opts.settings, computerName: computerName(), unavailable: opts.fake ? SAMPLE_DATA_REASON : null, dispatch, here });
  await connect.start();
  return connect;
}
