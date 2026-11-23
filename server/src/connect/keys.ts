// Kestrel Connect's cryptography between two devices of one account (design doc
// kestrel-connect.md, section 5; "Phase 3 as built" says exactly what is on the wire). No primitive
// is written here: every one is Node's crypto (OpenSSL), the platform's own, and each has a direct
// equivalent in CryptoKit for the phone: Ed25519 (Curve25519.Signing), X25519
// (Curve25519.KeyAgreement), HKDF-SHA256, HMAC-SHA256 and ChaCha20-Poly1305 (ChaChaPoly).
//
// - Pairing: the desk shows a code holding a 128-bit secret. The phone proves it has the code with an
//   HMAC over both devices' ids and its public keys; the desk answers with the same over its own. The
//   relay sees both messages but cannot forge either without the secret, and 128 bits cannot be
//   guessed offline. A short code would need a PAKE, which Node does not have; hence the long one.
// - The live channel: per connection, each side makes an ephemeral X25519 key and signs it with its
//   identity key (Ed25519) over a transcript naming both devices. The shared secret goes through HKDF
//   into one key per direction. A stolen identity key does not open a recorded session.
// - Frames: the body is ChaCha20-Poly1305 under the direction's key, the nonce a counter that only
//   rises (a replayed or reordered frame is refused), and the envelope's header bound as associated
//   data, so a changed `from`, `to`, `kind`, `id` or `replyTo` is refused like a changed byte.
import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import type { Envelope } from '../shared/connect-ops.ts';

const PAIR_INFO = 'kestrel-connect pairing v1';
const SESSION_INFO = 'kestrel-connect session v1';
const SECRET_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const BASE32 = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'.toLowerCase(); // Crockford-like: no i, l, o, u

/** Base32 of the secret, grouped in fours for reading aloud. */
export function encodeSecret(secret: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of secret) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)?.join('-') ?? out;
}

/** The secret from what was typed or scanned; forgiving of case, spaces, dashes and look-alikes. */
export function decodeSecret(text: string): Buffer | null {
  const clean = text.toLowerCase().replace(/[\s-]/g, '').replace(/[il]/g, '1').replace(/o/g, '0').replace(/u/g, 'v');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) return null;
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // Only the canonical spelling: the bits past the last byte are zero.
  return bytes.length === SECRET_BYTES && (value & ((1 << bits) - 1)) === 0 ? Buffer.from(bytes) : null;
}

export const newPairingSecret = (): Buffer => randomBytes(SECRET_BYTES);

/** What the pairing page shows and a phone scans: `kestrel-pair:<desk device id>:<secret>`. */
export function pairingCode(deskId: string, secret: Buffer): string {
  return `kestrel-pair:${deskId}:${encodeSecret(secret)}`;
}

export function parsePairingCode(code: string): { deskId: string; secret: Buffer } | null {
  const match = /^kestrel-pair:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9\s-]+)$/.exec(code.trim());
  const secret = match ? decodeSecret(match[2] ?? '') : null;
  return match && secret ? { deskId: match[1] as string, secret } : null;
}

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

/** The proof that whoever made it holds the pairing secret, bound to who is pairing with whom. */
export function pairingProof(secret: Buffer, role: 'phone' | 'desk', deskId: string, phoneId: string, keys: PublicIdentity, name = ''): string {
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), PAIR_INFO, 32));
  return createHmac('sha256', key).update(transcript(PAIR_INFO, role, deskId, phoneId, keys.signing, keys.agreement, name)).digest('base64url');
}

export function proofMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One side of the live channel's handshake: an ephemeral key, signed by the identity key. */
export interface Ephemeral {
  publicKey: string;
  privateKey: KeyObject;
}

export function newEphemeral(): Ephemeral {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url'), privateKey };
}

/** `at`: when the phone made its hello (ms), signed, so a recorded hello cannot be replayed later. */
const helloTranscript = (role: 'phone' | 'desk', phoneId: string, deskId: string, phoneEphemeral: string, deskEphemeral: string, at: number) => transcript(SESSION_INFO, role, phoneId, deskId, phoneEphemeral, deskEphemeral, String(at));

/** Signs this side's hello. The phone signs before it has the desk's ephemeral key ('' there). */
export function signHello(identity: Identity, role: 'phone' | 'desk', phoneId: string, deskId: string, phoneEphemeral: string, deskEphemeral: string, at: number): string {
  return sign(null, helloTranscript(role, phoneId, deskId, phoneEphemeral, deskEphemeral, at), createPrivateKey(identity.signing.privateKey)).toString('base64url');
}

export function helloSigned(signingKey: string, signature: unknown, role: 'phone' | 'desk', phoneId: string, deskId: string, phoneEphemeral: string, deskEphemeral: string, at: number): boolean {
  if (typeof signature !== 'string') return false;
  try {
    return verify(null, helloTranscript(role, phoneId, deskId, phoneEphemeral, deskEphemeral, at), publicFromRaw(signingKey, 'ed25519'), Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** The two directions' keys from both ephemeral keys. */
export function sessionKeys(mine: Ephemeral, theirs: string, phoneEphemeral: string, deskEphemeral: string): { phoneToDesk: Buffer; deskToPhone: Buffer } {
  const shared = diffieHellman({ privateKey: mine.privateKey, publicKey: publicFromRaw(theirs, 'x25519') });
  if (shared.every((b) => b === 0)) throw new Error('That key cannot be used.');
  const salt = Buffer.concat([Buffer.from(phoneEphemeral, 'base64url'), Buffer.from(deskEphemeral, 'base64url')]);
  const keys = Buffer.from(hkdfSync('sha256', shared, salt, SESSION_INFO, 64));
  return { phoneToDesk: keys.subarray(0, 32), deskToPhone: keys.subarray(32) };
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
    const cipher = createCipheriv('chacha20-poly1305', this.key, nonce, { authTagLength: TAG_BYTES });
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
    const decipher = createDecipheriv('chacha20-poly1305', this.key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(header(frame), { plaintextLength: sealed.length - NONCE_BYTES - TAG_BYTES });
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    const text = Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)), decipher.final()]).toString('utf8');
    this.counter = count;
    return JSON.parse(text);
  }
}
