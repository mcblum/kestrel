// What Settings → Connections → Kestrel Connect shows, as the server pushes it (connect/connect.ts).
// One copy, the server's; the window holds it in the store's `connect` slice.

/** The public service. Overridden by KESTREL_CONNECT_URL for a self-hosted one. */
export const CONNECT_SERVICE_URL = 'https://connect.kestrelapp.ai';
/** The desktop's client in the service's identity realm. */
export const CONNECT_DESKTOP_CLIENT = 'kestrel-desktop';

export type ConnectAccount =
  | { state: 'signed-out'; reason: string | null }
  | { state: 'signing-in'; url: string }
  | { state: 'signed-in'; email: string };

export type ConnectLink =
  /** Connect is off, or nobody is signed in: nothing is dialled. */
  | { state: 'off' }
  | { state: 'connecting' }
  | { state: 'connected'; since: number }
  /** Not connected, why, and when it tries again (null: it waits for the user). */
  | { state: 'offline'; reason: string; retryAt: number | null };

/** Where the sign-in and device keys are kept: the OS keystore, or a file only the user can read. */
export type ConnectStorage = 'keystore' | 'file';

/** A phone paired with this computer. */
export interface ConnectDevice {
  id: string;
  name: string;
  pairedAt: number;
  /** It has a channel open to this computer right now. */
  connected: boolean;
}

/** The pairing page's code, while it is open (single use). */
export interface PairingOffer {
  code: string;
  expiresAt: number;
}

export interface ConnectView {
  /** The one switch; off by default. */
  enabled: boolean;
  account: ConnectAccount;
  link: ConnectLink;
  storage: ConnectStorage;
  /** This computer's name, as other devices on the account see it. */
  computerName: string;
  /** Why Connect cannot be used in this copy at all (sample data), or null. */
  unavailable: string | null;
  paired: ConnectDevice[];
  pairing: PairingOffer | null;
}

export const CONNECT_OFF: ConnectLink = { state: 'off' };

/** The words the Settings part shows for the link. */
export function linkText(link: ConnectLink): string {
  if (link.state === 'off') return 'Not connected';
  if (link.state === 'connecting') return 'Connecting…';
  if (link.state === 'connected') return 'Connected';
  return `Offline: ${link.reason}`;
}
