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

/** A device of the account, as this computer knows it. */
export interface ConnectDevice {
  id: string;
  name: string;
  kind: 'desktop' | 'phone';
  /** It is in the account's keyring: it was let in, and holds the account key. */
  inAccount: boolean;
  /** It has a channel open to this computer right now. */
  connected: boolean;
  /** This computer. */
  here: boolean;
}

/**
 * This computer asking to be let into the account (account-sessions.md, 4.4): waiting for another device
 * to open the request; showing the code to type there; asking the person to confirm the device that let it
 * in by typing the second code it shows (step 8a); in; or ended, with why.
 */
export type ConnectJoining =
  | { state: 'asking'; expiresAt: number }
  | { state: 'code'; code: string; by: string; expiresAt: number }
  /** Step 8a: type the second code `by` shows; `wrong` codes so far (three discard the key). */
  | { state: 'confirm'; by: string; wrong: number; problem: string | null }
  | { state: 'in'; by: string }
  | { state: 'ended'; reason: string };

/** Another device asking to be let in, as this computer shows it. */
export interface ConnectJoinRequest {
  id: string;
  name: string;
  kind: 'desktop' | 'phone';
  expiresAt: number;
  /** waiting: nobody opened it here; opening: asked the device for its nonce; typing: the code can be typed; letting-in: the right code, the key is being given; showing: let in, the second code is shown until the device answers or `expiresAt`; done: what happened, in `outcome`, until Done (steps 8b, 8c). */
  state: 'waiting' | 'opening' | 'typing' | 'letting-in' | 'showing' | 'done';
  /** Wrong codes typed so far (three end the request). */
  wrong: number;
  /** Why the last step did not work, or null. */
  problem: string | null;
  /** The second code to type on the device, while `showing` (step 8a). */
  code: string | null;
  /** What happened, once `done` (step 8c). */
  outcome: string | null;
}

/** The account data key on this computer (connect/link/account-keys.ts). */
export type ConnectKeys =
  /** Not read yet: Connect is off, or the service has not been reached. */
  | { state: 'unknown' }
  /** The account has a key this computer does not hold yet. */
  | { state: 'locked'; reason: string }
  | { state: 'failed'; reason: string }
  /** `wordsToShow`: new recovery words wait to be written down; `changedBecause`: the devices whose removal changed them. */
  | { state: 'ready'; generation: number; wordsToShow: boolean; changedBecause: string[] | null };

/** Held conversations on this computer (connect/link/held.ts). */
export interface ConnectHeld {
  /** Project ids kept off Kestrel Connect; `none` for sessions with no project. */
  keptOff: string[];
  /** Attachments and tools' pictures are held too (off by default). */
  attachments: boolean;
  /** Why the last upload did not finish, or null. */
  problem: string | null;
  usage: { bytes: number; limit: number } | null;
  lastUploadAt: number | null;
}

/** Push notifications from this computer (connect/link/push.ts). */
export interface ConnectPush {
  /** The phones on the account that take notifications, by name. */
  phones: string[];
  /** Why the last notification was not sent, or null. */
  problem: string | null;
  lastSentAt: number | null;
}

export const NO_PUSH: ConnectPush = { phones: [], problem: null, lastSentAt: null };

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
  /** The account's devices (empty while not connected). */
  devices: ConnectDevice[];
  /** This computer asking to be let in, or null. */
  joining: ConnectJoining | null;
  /** Other devices asking to be let in. */
  requests: ConnectJoinRequest[];
  keys: ConnectKeys;
  held: ConnectHeld;
  push: ConnectPush;
}

export const CONNECT_OFF: ConnectLink = { state: 'off' };

/** The words the Settings part shows for the link. */
export function linkText(link: ConnectLink): string {
  if (link.state === 'off') return 'Not connected';
  if (link.state === 'connecting') return 'Connecting…';
  if (link.state === 'connected') return 'Connected';
  return `Offline: ${link.reason}`;
}

/**
 * The kept-off list with one project switched (Kestrel Connect, D4). The one way the list is changed,
 * from Settings → Connections and from a project's own Settings tab alike: never a copy per project.
 */
export function keptOffWith(keptOff: readonly string[], projectId: string, off: boolean): string[] {
  const rest = keptOff.filter((p) => p !== projectId);
  return off ? [...rest, projectId] : rest;
}
