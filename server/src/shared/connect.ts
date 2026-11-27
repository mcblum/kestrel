// What Settings → Connections → Kestrel Connect shows, as the server pushes it (connect/connect.ts).
// One copy, the server's; the window holds it in the store's `connect` slice.
import type { KestrelKind } from './host-kind.ts';

/** The public service. Overridden by KESTREL_CONNECT_URL for a self-hosted one. */
export const CONNECT_SERVICE_URL = 'https://connect.kestrelapp.ai';
/** The desktop's client in the service's identity realm. */
export const CONNECT_DESKTOP_CLIENT = 'kestrel-desktop';
/** A worker node's client: the device authorization grant only, typed on another device (worker-nodes.md, W8). */
export const CONNECT_NODE_CLIENT = 'kestrel-node';

/**
 * How a Kestrel server signs in to Kestrel Connect, decided by its kind and nowhere else: the app through the
 * browser to a loopback redirect, as `kestrel-desktop`; a worker node, which has no browser, by a device
 * authorization grant typed on another device, as `kestrel-node` (worker-nodes.md, section 5).
 */
export const CONNECT_SIGN_IN: Readonly<Record<KestrelKind, { client: string; grant: 'loopback' | 'device' }>> = {
  app: { client: CONNECT_DESKTOP_CLIENT, grant: 'loopback' },
  node: { client: CONNECT_NODE_CLIENT, grant: 'device' },
};

/** What a device of the account is (W2): a computer with a window, a phone, or a computer with none. */
export type DeviceKind = 'desktop' | 'phone' | 'node';

/** What a server of this kind registers itself as. */
export const deviceKindFor = (kind: KestrelKind): 'desktop' | 'node' => (kind === 'node' ? 'node' : 'desktop');

/** A device kind from the service's words; an unknown word is read as a desktop, as before there were nodes. */
export const deviceKindOf = (value: unknown): DeviceKind => (value === 'phone' ? 'phone' : value === 'node' ? 'node' : 'desktop');

/**
 * A computer of the account: a desktop or a worker node, never a phone. The one check for "a machine": who may
 * ask a `who: 'desk'` operation, whose sessions, projects, offers, seen marks and set-up records are read, and
 * which computers a session may be started on.
 */
export const isComputerKind = (kind: DeviceKind | null | undefined): kind is 'desktop' | 'node' => kind === 'desktop' || kind === 'node';

/** What a device's kind is called in a list. */
export const DEVICE_KIND_NAME: Readonly<Record<DeviceKind, string>> = { desktop: 'Computer', phone: 'Phone', node: 'Worker node' };

/**
 * Why the recovery words may not be shown or typed here, or null where they may (W5): a worker node never shows
 * or takes them, and joins by the two codes only.
 */
export const recoveryWordsRefusal = (kind: KestrelKind): string | null =>
  kind === 'node' ? 'A worker node never shows or takes the recovery words. See them on a computer with a screen; join this node from another of your devices with "kestrel node join".' : null;

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
  kind: DeviceKind;
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
  kind: DeviceKind;
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

/** A request's first line, on its card (Settings → Connections and over any page) and in the banner: one wording. */
export const joinRequestTitle = (request: Pick<ConnectJoinRequest, 'name' | 'kind'>): string => `${request.name}${request.kind === 'node' ? `, a ${DEVICE_KIND_NAME.node.toLowerCase()},` : ''} wants to join your account`;

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
  /** This computer's name, as other devices on the account see it: the one the user gave, or the host name. */
  computerName: string;
  /** The host name, used when no name is given (the field's placeholder). */
  hostName: string;
  /** The name the user gave this computer, or null for the host name. */
  givenName: string | null;
  /** Why the service has not taken this computer's name yet (it is sent again when the link is next up), or null. */
  nameProblem: string | null;
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

/** The longest name a device may have: the service's own limit. */
export const DEVICE_NAME_MAX = 64;

/**
 * A device's name as typed, made into the name it is given (kestrel-connect.md, "A device's name is the
 * user's to give"): trimmed, runs of white space made one space; null when nothing is left. A name is a
 * label only, never identity. Throws an `Error` with the reason for one that cannot be a name.
 */
export function deviceNameOf(text: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) throw new Error('A device name cannot hold control characters.');
  const name = text.replace(/\s+/g, ' ').trim();
  if (!name) return null;
  if ([...name].length > DEVICE_NAME_MAX) throw new Error(`A device name is at most ${DEVICE_NAME_MAX} characters.`);
  return name;
}
