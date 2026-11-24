// The account data key (ADK) and everything sealed under it (design doc kestrel-connect.md, section 5;
// "Phase 3 as built, part C, and phase 5 as built" is the exact contract the phone implements too).
// No primitive is written here: X25519, HKDF-SHA256, HMAC-SHA256, Ed25519 and AES-256-GCM are
// Node's crypto (OpenSSL, or BoringSSL under Electron), each with a CryptoKit equivalent. The BIP-39 English word list is
// @scure/bip39's; the checksum is Node's SHA-256.
//
// - `wrapKey`: the ADK sealed for one device's agreement key (anonymous: a fresh X25519 key each time).
// - `sealWith`: anything held, under a key derived per seal from the ADK and a random salt, bound to
//   its kind, id and generation, so the service cannot move a body to another id.
// - `tagOf`: an opaque id the service may see, from the keyring's id key.
// - The recovery key: 32 random bytes shown as 24 words; they make an X25519 key the ADK is wrapped for.
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { wordlist } from '@scure/bip39/wordlists/english';
import { AEAD, type Identity } from './keys.ts';

const WRAP_INFO = 'kestrel-connect wrap v2';
const SEAL_INFO = 'kestrel-connect seal v2';
const RECOVERY_INFO = 'kestrel-connect recovery v1';
/** 2: AES-256-GCM. 1 was ChaCha20-Poly1305 and was never stored by a released desk. */
const FORMAT = 2;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const TAG_BYTES = 16;
const NONCE = Buffer.alloc(12);

/** What is sealed under the ADK; part of every seal's associated data. */
export type SealKind = 'record' | 'message' | 'keyring' | 'previous' | 'push' | 'push-prefs';

export const newAccountKey = (): Buffer => randomBytes(KEY_BYTES);

const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/** An X25519 key pair from its raw 32-byte private key (CryptoKit's `rawRepresentation`). */
export function x25519FromRaw(raw: Buffer): { privateKey: KeyObject; publicKey: KeyObject; publicRaw: Buffer } {
  if (raw.length !== KEY_BYTES) throw new Error('An X25519 key is 32 bytes.');
  const privateKey = createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, publicRaw: rawOf(publicKey) };
}

const rawOf = (key: KeyObject): Buffer => key.export({ type: 'spki', format: 'der' }).subarray(-KEY_BYTES);

function x25519Public(raw: Buffer): KeyObject {
  if (raw.length !== KEY_BYTES) throw new Error('A public key must be 32 bytes.');
  return createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), format: 'der', type: 'spki' });
}

function aead(key: Buffer, aad: string, plain: Buffer): Buffer {
  const cipher = createCipheriv(AEAD, key, NONCE, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'), { plaintextLength: plain.length });
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function unaead(key: Buffer, aad: string, sealed: Buffer): Buffer {
  if (sealed.length < TAG_BYTES) throw new Error('Too short.');
  const text = sealed.subarray(0, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv(AEAD, key, NONCE, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'), { plaintextLength: text.length });
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([decipher.update(text), decipher.final()]);
}

const wrapAad = (generation: number, recipient: string) => `adk|${generation}|${recipient}`;

function wrapSecret(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  if (shared.every((b) => b === 0)) throw new Error('That key cannot be used.');
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), WRAP_INFO, KEY_BYTES));
}

/** The ADK sealed for a device's agreement key (raw, base64url); `recipient` is its id or `recovery`. */
export function wrapKey(adk: Buffer, recipientAgreement: string, generation: number, recipient: string): string {
  const to = Buffer.from(recipientAgreement, 'base64url');
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const ephemeral = rawOf(publicKey);
  const key = wrapSecret(diffieHellman({ privateKey, publicKey: x25519Public(to) }), ephemeral, to);
  return Buffer.concat([Buffer.from([FORMAT]), ephemeral, aead(key, wrapAad(generation, recipient), adk)]).toString('base64url');
}

/** Opens a sealed copy with this device's agreement private key; throws when it is not for it. */
export function unwrapKey(wrapped: string, mine: KeyObject, generation: number, recipient: string): Buffer {
  const bytes = Buffer.from(wrapped, 'base64url');
  if (bytes.length !== 1 + KEY_BYTES + KEY_BYTES + TAG_BYTES || bytes[0] !== FORMAT) throw new Error('Not a sealed key.');
  const ephemeral = bytes.subarray(1, 1 + KEY_BYTES);
  const key = wrapSecret(diffieHellman({ privateKey: mine, publicKey: x25519Public(ephemeral) }), ephemeral, rawOf(createPublicKey(mine)));
  return unaead(key, wrapAad(generation, recipient), bytes.subarray(1 + KEY_BYTES));
}

const sealAad = (kind: SealKind, id: string, generation: number) => `${kind}|${id}|${generation}`;

/** Seals bytes under the ADK. `salt` is for test vectors only. */
export function sealWith(adk: Buffer, kind: SealKind, id: string, generation: number, plain: Buffer, salt: Buffer = randomBytes(SALT_BYTES)): string {
  const key = Buffer.from(hkdfSync('sha256', adk, salt, SEAL_INFO, KEY_BYTES));
  return Buffer.concat([Buffer.from([FORMAT]), salt, aead(key, sealAad(kind, id, generation), plain)]).toString('base64url');
}

/** Opens what `sealWith` made; throws when the key, kind, id or generation differs, or a byte changed. */
export function openSealed(adk: Buffer, sealed: string, kind: SealKind, id: string, generation: number): Buffer {
  const bytes = Buffer.from(sealed, 'base64url');
  if (bytes.length < 1 + SALT_BYTES + TAG_BYTES || bytes[0] !== FORMAT) throw new Error('Not sealed by Kestrel Connect.');
  const key = Buffer.from(hkdfSync('sha256', adk, bytes.subarray(1, 1 + SALT_BYTES), SEAL_INFO, KEY_BYTES));
  return unaead(key, sealAad(kind, id, generation), bytes.subarray(1 + SALT_BYTES));
}

export const sealRecord = (adk: Buffer, kind: SealKind, id: string, generation: number, value: unknown): string => sealWith(adk, kind, id, generation, Buffer.from(JSON.stringify(value), 'utf8'));

export const openRecord = (adk: Buffer, sealed: string, kind: SealKind, id: string, generation: number): unknown => JSON.parse(openSealed(adk, sealed, kind, id, generation).toString('utf8'));

/** An opaque id from the keyring's id key: 16 bytes of HMAC-SHA256, base64url (22 characters). */
export function tagOf(idKey: Buffer, label: string): string {
  return createHmac('sha256', idKey).update(label, 'utf8').digest().subarray(0, 16).toString('base64url');
}

// ---- the recovery key -------------------------------------------------------------------------

/** 32 bytes as 24 BIP-39 English words: the bytes and one checksum byte (SHA-256's first), 11 bits a word. */
export function recoveryWords(secret: Buffer): string[] {
  if (secret.length !== KEY_BYTES) throw new Error('A recovery key is 32 bytes.');
  const bits = [...secret, createHash('sha256').update(secret).digest()[0] as number].map((b) => b.toString(2).padStart(8, '0')).join('');
  const words: string[] = [];
  for (let i = 0; i < 24; i++) words.push(wordlist[parseInt(bits.slice(i * 11, i * 11 + 11), 2)] as string);
  return words;
}

/** The 32 bytes from the words as typed (any case, any spacing), or null when a word or the checksum is wrong. */
export function recoverySecretFromWords(text: string): Buffer | null {
  const words = text.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length !== 24) return null;
  let bits = '';
  for (const word of words) {
    const index = wordlist.indexOf(word);
    if (index < 0) return null;
    bits += index.toString(2).padStart(11, '0');
  }
  const bytes = Buffer.from(Array.from({ length: 33 }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
  const secret = bytes.subarray(0, KEY_BYTES);
  return createHash('sha256').update(secret).digest()[0] === bytes[KEY_BYTES] ? Buffer.from(secret) : null;
}

/** The key pair the words make. */
export function recoveryKey(secret: Buffer): ReturnType<typeof x25519FromRaw> {
  return x25519FromRaw(Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), RECOVERY_INFO, KEY_BYTES)));
}

// ---- the keyring's signature ------------------------------------------------------------------

const keyringMessage = (generation: number, version: number, sealed: string) => Buffer.from(`keyring|${generation}|${version}|${sealed}`, 'utf8');

export function signKeyring(identity: Identity, generation: number, version: number, sealed: string): string {
  return sign(null, keyringMessage(generation, version, sealed), createPrivateKey(identity.signing.privateKey)).toString('base64url');
}

export function keyringSigned(signingKey: string, signature: unknown, generation: number, version: number, sealed: string): boolean {
  if (typeof signature !== 'string') return false;
  try {
    const raw = Buffer.from(signingKey, 'base64url');
    if (raw.length !== KEY_BYTES) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' });
    return verify(null, keyringMessage(generation, version, sealed), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
