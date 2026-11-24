// Kestrel Connect's cryptography between two devices of one account (design doc
// kestrel-connect.md, section 5; "Phase 3 as built" says exactly what is on the wire). No primitive
// is written here: every one is Node's crypto (OpenSSL), the platform's own, and each has a direct
// equivalent in CryptoKit for the phone: Ed25519 (Curve25519.Signing), X25519
// (Curve25519.KeyAgreement), HKDF-SHA256, HMAC-SHA256 and AES-256-GCM (AES.GCM). Not ChaCha20-Poly1305: Electron's Node, which the app's
// server runs on, is built on BoringSSL and has no such cipher ("Unknown cipher"; 2026-11-23).
//
// - Joining (account-sessions.md, section 4.4): a new device commits to a nonce and its keys, a device
//   already in the account answers with a nonce of its own, the new device reveals, and both make a
//   six-digit code from the two nonces and all four keys. The new device shows it; the person types it
//   on the other. Neither side can choose its input after seeing the other's, so a relay that swaps a
//   key has one chance in a million per attempt. Built from SHA-256 and HMAC-SHA256; nothing new.
// - The live channel: per connection, each side makes an ephemeral X25519 key and signs it with its
//   identity key (Ed25519) over a transcript naming both devices. The shared secret goes through HKDF
//   into one key per direction. A stolen identity key does not open a recorded session.
// - Frames: the body is AES-256-GCM under the direction's key, the nonce a counter that only
//   rises (a replayed or reordered frame is refused), and the envelope's header bound as associated
//   data, so a changed `from`, `to`, `kind`, `id` or `replyTo` is refused like a changed byte.
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import type { Envelope } from '../shared/connect-ops.ts';

const SESSION_INFO = 'kestrel-connect session v1';
const NONCE_BYTES = 12;
/** The one AEAD of Kestrel Connect, for frames and for everything held (account-key.ts). */
export const AEAD = 'aes-256-gcm';
const TAG_BYTES = 16;

/** The public half of a device's identity, as it travels: raw keys, base64url. */
export interface PublicIdentity {
  signing: string;
  agreement: string;
}

export interface Identity {
  signing: { publicKey: string; privateKey: string };
  agreement: { publicKey: string; privateKey: string };
}

const RAW = { ed25519: Buffer.from('302a300506032b6570032100', 'hex'), x25519: Buffer.from('302a300506032b656e032100', 'hex') };

/** A raw 32-byte public key (what CryptoKit's `rawRepresentation` is) from a PEM. */
export function rawPublic(pem: string): string {
  return createPublicKey(pem).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
}

function publicFromRaw(raw: string, kind: 'ed25519' | 'x25519'): KeyObject {
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.length !== 32) throw new Error('A public key must be 32 bytes.');
  return createPublicKey({ key: Buffer.concat([RAW[kind], bytes]), format: 'der', type: 'spki' });
}

export function publicIdentity(identity: Identity): PublicIdentity {
  return { signing: rawPublic(identity.signing.publicKey), agreement: rawPublic(identity.agreement.publicKey) };
}

export function newIdentity(): Identity {
  const signing = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const agreement = generateKeyPairSync('x25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { signing, agreement };
}

const transcript = (...parts: string[]): Buffer => Buffer.from(parts.map((p) => `${p.length}:${p}`).join('|'), 'utf8');

/** One side of the live channel's handshake: an ephemeral key, signed by the identity key. */
export interface Ephemeral {
  publicKey: string;
  privateKey: KeyObject;
}

export function newEphemeral(): Ephemeral {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url'), privateKey };
}

/** Which end of a channel signed: the device that said hello first, or the one that answered. */
export type HelloRole = 'caller' | 'callee';

/** `at`: when the caller made its hello (ms), signed, so a recorded hello cannot be replayed later. */
const helloTranscript = (role: HelloRole, callerId: string, calleeId: string, callerEphemeral: string, calleeEphemeral: string, at: number) => transcript(SESSION_INFO, role, callerId, calleeId, callerEphemeral, calleeEphemeral, String(at));

/** Signs this side's hello. The caller signs before it has the callee's ephemeral key ('' there). */
export function signHello(identity: Identity, role: HelloRole, callerId: string, calleeId: string, callerEphemeral: string, calleeEphemeral: string, at: number): string {
  return sign(null, helloTranscript(role, callerId, calleeId, callerEphemeral, calleeEphemeral, at), createPrivateKey(identity.signing.privateKey)).toString('base64url');
}

export function helloSigned(signingKey: string, signature: unknown, role: HelloRole, callerId: string, calleeId: string, callerEphemeral: string, calleeEphemeral: string, at: number): boolean {
  if (typeof signature !== 'string') return false;
  try {
    return verify(null, helloTranscript(role, callerId, calleeId, callerEphemeral, calleeEphemeral, at), publicFromRaw(signingKey, 'ed25519'), Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** The two directions' keys from both ephemeral keys. */
export function sessionKeys(mine: Ephemeral, theirs: string, callerEphemeral: string, calleeEphemeral: string): { callerToCallee: Buffer; calleeToCaller: Buffer } {
  const shared = diffieHellman({ privateKey: mine.privateKey, publicKey: publicFromRaw(theirs, 'x25519') });
  if (shared.every((b) => b === 0)) throw new Error('That key cannot be used.');
  const salt = Buffer.concat([Buffer.from(callerEphemeral, 'base64url'), Buffer.from(calleeEphemeral, 'base64url')]);
  const keys = Buffer.from(hkdfSync('sha256', shared, salt, SESSION_INFO, 64));
  return { callerToCallee: keys.subarray(0, 32), calleeToCaller: keys.subarray(32) };
}

// Joining (account-sessions.md, section 4.4; kestrel-connect.md, "Account stage 1 as built").
const JOIN_COMMIT = 'kestrel join v1';
const JOIN_CODE = 'kestrel join code v1';
const JOIN_WELCOME = 'kestrel join welcome v1';
const JOIN_CONFIRM = 'kestrel join confirm v1';
const JOIN_JOINED = 'kestrel join joined v1';
const JOIN_DECLINED = 'kestrel join declined v1';

/** Why a joining device did not keep the key it was offered (step 8a). */
export type JoinDeclined = 'wrong-code' | 'cancelled' | 'expired';
export const JOIN_DECLINED_REASONS: readonly JoinDeclined[] = ['wrong-code', 'cancelled', 'expired'];
export const JOIN_NONCE_BYTES = 32;

const raw32 = (key: string): Buffer => {
  const bytes = Buffer.from(key, 'base64url');
  if (bytes.length !== 32) throw new Error('A public key must be 32 bytes.');
  return bytes;
};

export const newJoinNonce = (): Buffer => randomBytes(JOIN_NONCE_BYTES);

/** What the new device posts before anyone answers it: SHA-256 over its nonce and both its public keys. */
export function joinCommitment(nonce: Buffer, keys: PublicIdentity): string {
  return createHash('sha256').update(Buffer.from(JOIN_COMMIT, 'utf8')).update(nonce).update(raw32(keys.signing)).update(raw32(keys.agreement)).digest('base64url');
}

/** Whether a revealed nonce and keys are the ones committed to. */
export function joinCommitted(commitment: string, nonce: Buffer, keys: PublicIdentity): boolean {
  try {
    return nonce.length === JOIN_NONCE_BYTES && sameText(joinCommitment(nonce, keys), commitment);
  } catch {
    return false;
  }
}

/** The six digits both devices make: HMAC-SHA256 keyed by both nonces over all four keys, the first four bytes mod 1,000,000. */
export function joinCode(newNonce: Buffer, approverNonce: Buffer, newKeys: PublicIdentity, approverKeys: PublicIdentity): string {
  const mac = createHmac('sha256', Buffer.concat([newNonce, approverNonce]))
    .update(Buffer.from(JOIN_CODE, 'utf8'))
    .update(raw32(newKeys.signing))
    .update(raw32(newKeys.agreement))
    .update(raw32(approverKeys.signing))
    .update(raw32(approverKeys.agreement))
    .digest();
  return String(mac.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** What was typed, as six digits, or null: spaces, dashes and the like are forgiven. */
export function typedCode(text: string): string | null {
  const digits = text.replace(/[\s\-.·]/g, '');
  return /^[0-9]{6}$/.test(digits) ? digits : null;
}

/** The code as the new device shows it: two groups of three. */
export const shownCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;

function sameText(a: string, b: unknown): boolean {
  if (typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const codesMatch = (expected: string, typed: string): boolean => sameText(expected, typed);

const welcomeTranscript = (joinId: string, newId: string, approverId: string, newKeys: PublicIdentity, generation: number, keyringVersion: number) =>
  transcript(JOIN_WELCOME, joinId, newId, approverId, newKeys.signing, newKeys.agreement, String(generation), String(keyringVersion));

/** The approver's word that it gave the new device the key, under this keyring version. */
export function signJoinWelcome(identity: Identity, joinId: string, newId: string, approverId: string, newKeys: PublicIdentity, generation: number, keyringVersion: number): string {
  return sign(null, welcomeTranscript(joinId, newId, approverId, newKeys, generation, keyringVersion), createPrivateKey(identity.signing.privateKey)).toString('base64url');
}

export function joinWelcomeSigned(approverSigning: string, signature: unknown, joinId: string, newId: string, approverId: string, newKeys: PublicIdentity, generation: number, keyringVersion: number): boolean {
  if (typeof signature !== 'string') return false;
  try {
    return verify(null, welcomeTranscript(joinId, newId, approverId, newKeys, generation, keyringVersion), publicFromRaw(approverSigning, 'ed25519'), Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** What both sides know of one welcome: the request, both devices with their keys, the key's generation and keyring version, and the signature. */
export interface WelcomeFacts {
  joinId: string;
  newId: string;
  approverId: string;
  newKeys: PublicIdentity;
  approverKeys: PublicIdentity;
  generation: number;
  keyringVersion: number;
  signature: string;
}

/**
 * The second code (step 8a): shown on the approving device once the first code was right, typed on the new
 * device, which keeps the key only when it matches. HMAC-SHA256 keyed by both nonces over the welcome as the
 * new device believes it (the approver's keys among it), under its own label and length-prefixed, so it is
 * never the first code and a welcome from anyone else gives another code. First four bytes mod 1,000,000.
 */
export function joinConfirmCode(newNonce: Buffer, approverNonce: Buffer, w: WelcomeFacts): string {
  raw32(w.newKeys.signing), raw32(w.newKeys.agreement), raw32(w.approverKeys.signing), raw32(w.approverKeys.agreement);
  const mac = createHmac('sha256', Buffer.concat([newNonce, approverNonce]))
    .update(transcript(JOIN_CONFIRM, w.joinId, w.newId, w.approverId, w.newKeys.signing, w.newKeys.agreement, w.approverKeys.signing, w.approverKeys.agreement, String(w.generation), String(w.keyringVersion), w.signature))
    .digest();
  return String(mac.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

const joinedTranscript = (joinId: string, newId: string, approverId: string, generation: number, keyringVersion: number) => transcript(JOIN_JOINED, joinId, newId, approverId, String(generation), String(keyringVersion));
const declinedTranscript = (joinId: string, newId: string, approverId: string, reason: JoinDeclined) => transcript(JOIN_DECLINED, joinId, newId, approverId, reason);

/** The new device's word that the second code matched and it kept the key (step 8a). */
export function signJoinJoined(identity: Identity, joinId: string, newId: string, approverId: string, generation: number, keyringVersion: number): string {
  return sign(null, joinedTranscript(joinId, newId, approverId, generation, keyringVersion), createPrivateKey(identity.signing.privateKey)).toString('base64url');
}

export function joinJoinedSigned(newSigning: string, signature: unknown, joinId: string, newId: string, approverId: string, generation: number, keyringVersion: number): boolean {
  return verified(newSigning, signature, joinedTranscript(joinId, newId, approverId, generation, keyringVersion));
}

/** The new device's word that it discarded the key it was offered, and why (step 8a). */
export function signJoinDeclined(identity: Identity, joinId: string, newId: string, approverId: string, reason: JoinDeclined): string {
  return sign(null, declinedTranscript(joinId, newId, approverId, reason), createPrivateKey(identity.signing.privateKey)).toString('base64url');
}

export function joinDeclinedSigned(newSigning: string, signature: unknown, joinId: string, newId: string, approverId: string, reason: JoinDeclined): boolean {
  return verified(newSigning, signature, declinedTranscript(joinId, newId, approverId, reason));
}

function verified(signing: string, signature: unknown, data: Buffer): boolean {
  if (typeof signature !== 'string') return false;
  try {
    return verify(null, data, publicFromRaw(signing, 'ed25519'), Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** The envelope without its body: what a frame's ciphertext is bound to. */
const header = (frame: Omit<Envelope, 'body'>): Buffer => Buffer.from(JSON.stringify([frame.v, frame.from, frame.to, frame.kind, frame.id, frame.replyTo ?? null]), 'utf8');

/** Frames one way: seals with a rising counter, or opens and refuses anything not newer than the last. */
export class FrameCipher {
  private counter = 0n;

  constructor(private readonly key: Buffer) {}

  private nonce(count: bigint): Buffer {
    const nonce = Buffer.alloc(NONCE_BYTES);
    nonce.writeBigUInt64BE(count, 4);
    return nonce;
  }

  seal(frame: Omit<Envelope, 'body'>, body: unknown): string {
    this.counter += 1n;
    const nonce = this.nonce(this.counter);
    const cipher = createCipheriv(AEAD, this.key, nonce, { authTagLength: TAG_BYTES });
    const plain = Buffer.from(JSON.stringify(body), 'utf8');
    cipher.setAAD(header(frame), { plaintextLength: plain.length });
    const text = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([nonce, text, cipher.getAuthTag()]).toString('base64url');
  }

  /** The body, or throws: changed, replayed, or not sealed with this key. */
  open(frame: Envelope): unknown {
    if (typeof frame.body !== 'string') throw new Error('The frame is not sealed.');
    const sealed = Buffer.from(frame.body, 'base64url');
    if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new Error('The frame is too short.');
    const nonce = sealed.subarray(0, NONCE_BYTES);
    const count = nonce.readBigUInt64BE(4);
    if (nonce.readUInt32BE(0) !== 0 || count <= this.counter) throw new Error('The frame was sent before, or out of order.');
    const decipher = createDecipheriv(AEAD, this.key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(header(frame), { plaintextLength: sealed.length - NONCE_BYTES - TAG_BYTES });
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    const text = Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)), decipher.final()]).toString('utf8');
    this.counter = count;
    return JSON.parse(text);
  }
}
