import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONNECT_PROTOCOL_VERSION, type Envelope } from '../shared/connect-ops.ts';
import { decodeSecret, encodeSecret, FrameCipher, helloSigned, newEphemeral, newIdentity, pairingCode, pairingProof, parsePairingCode, proofMatches, publicIdentity, sessionKeys, signHello } from './keys.ts';

const head = (id: string): Omit<Envelope, 'body'> => ({ v: CONNECT_PROTOCOL_VERSION, from: 'phone-1', to: 'desk-1', kind: 'request', id });

describe('the pairing code', () => {
  it('carries 128 bits, forgives how it was typed, and refuses anything else', () => {
    const secret = randomBytes(16);
    const text = encodeSecret(secret);
    expect(text).toMatch(/^([0-9a-z]{4}-){6}[0-9a-z]{2}$/);
    expect(decodeSecret(text)).toEqual(secret);
    expect(decodeSecret(text.toUpperCase().replace(/-/g, ' '))).toEqual(secret);
    expect(decodeSecret(text.slice(0, -2))).toBeNull();
    expect(decodeSecret('!!!')).toBeNull();
    // Only one spelling decodes: the padding bits after the last byte must be zero.
    const last = text.at(-1)!;
    const other = '0123456789abcdefghjkmnpqrstvwxyz'.split('').find((c) => c !== last && decodeSecret(text.slice(0, -1) + c)?.equals(secret));
    expect(other).toBeUndefined();
    const code = pairingCode('desk-1', secret);
    expect(parsePairingCode(code)).toEqual({ deskId: 'desk-1', secret });
    expect(parsePairingCode('kestrel-pair:desk-1:short')).toBeNull();
    expect(parsePairingCode('something else')).toBeNull();
  });

  it('proves the code was held, bound to both devices and the keys, one way each', () => {
    const secret = randomBytes(16);
    const keys = publicIdentity(newIdentity());
    const proof = pairingProof(secret, 'phone', 'desk-1', 'phone-1', keys);
    expect(proofMatches(pairingProof(secret, 'phone', 'desk-1', 'phone-1', keys), proof)).toBe(true);
    expect(proofMatches(pairingProof(randomBytes(16), 'phone', 'desk-1', 'phone-1', keys), proof)).toBe(false);
    expect(proofMatches(pairingProof(secret, 'desk', 'desk-1', 'phone-1', keys), proof)).toBe(false);
    expect(proofMatches(pairingProof(secret, 'phone', 'desk-1', 'phone-2', keys), proof)).toBe(false);
    expect(proofMatches(pairingProof(secret, 'phone', 'desk-1', 'phone-1', publicIdentity(newIdentity())), proof)).toBe(false);
    expect(proofMatches(pairingProof(secret, 'phone', 'desk-1', 'phone-1', keys, 'Matt’s iPhone'), pairingProof(secret, 'phone', 'desk-1', 'phone-1', keys, 'Other'))).toBe(false);
    expect(proofMatches('x', undefined)).toBe(false);
  });
});

describe('the handshake', () => {
  it('agrees the same keys on both sides, signed by each identity', () => {
    const phone = newIdentity();
    const desk = newIdentity();
    const pe = newEphemeral();
    const de = newEphemeral();
    const at = 1_000;
    const phoneSig = signHello(phone, 'phone', 'phone-1', 'desk-1', pe.publicKey, '', at);
    expect(helloSigned(publicIdentity(phone).signing, phoneSig, 'phone', 'phone-1', 'desk-1', pe.publicKey, '', at)).toBe(true);
    expect(helloSigned(publicIdentity(desk).signing, phoneSig, 'phone', 'phone-1', 'desk-1', pe.publicKey, '', at)).toBe(false);
    expect(helloSigned(publicIdentity(phone).signing, phoneSig, 'phone', 'phone-1', 'desk-1', newEphemeral().publicKey, '', at)).toBe(false);
    expect(helloSigned(publicIdentity(phone).signing, phoneSig, 'phone', 'phone-1', 'desk-1', pe.publicKey, '', at + 1)).toBe(false);
    expect(helloSigned(publicIdentity(phone).signing, phoneSig, 'desk', 'phone-1', 'desk-1', pe.publicKey, '', at)).toBe(false);
    const deskSig = signHello(desk, 'desk', 'phone-1', 'desk-1', pe.publicKey, de.publicKey, at);
    expect(helloSigned(publicIdentity(desk).signing, deskSig, 'desk', 'phone-1', 'desk-1', pe.publicKey, de.publicKey, at)).toBe(true);
    expect(sessionKeys(pe, de.publicKey, pe.publicKey, de.publicKey)).toEqual(sessionKeys(de, pe.publicKey, pe.publicKey, de.publicKey));
    // A fresh connection gets fresh keys.
    expect(sessionKeys(newEphemeral(), de.publicKey, pe.publicKey, de.publicKey)).not.toEqual(sessionKeys(pe, de.publicKey, pe.publicKey, de.publicKey));
  });
});

describe('frames', () => {
  const pair = () => {
    const key = randomBytes(32);
    return { out: new FrameCipher(key), in: new FrameCipher(key) };
  };

  it('opens what was sealed, and the ciphertext holds none of the text', () => {
    const c = pair();
    const frame = { ...head('q1'), body: c.out.seal(head('q1'), { op: 'session.reply', args: { text: 'the secret plan' } }) };
    expect(frame.body).not.toContain('secret');
    expect(Buffer.from(frame.body, 'base64url').toString('latin1')).not.toContain('secret');
    expect(c.in.open(frame)).toEqual({ op: 'session.reply', args: { text: 'the secret plan' } });
  });

  it('refuses a changed byte, a changed header, a replay, and another key', () => {
    const c = pair();
    const sealed = c.out.seal(head('q1'), { op: 'state.read', args: {} });
    const bytes = Buffer.from(sealed, 'base64url');
    bytes.writeUInt8(bytes.readUInt8(20) ^ 1, 20);
    expect(() => c.in.open({ ...head('q1'), body: bytes.toString('base64url') })).toThrow();
    expect(() => c.in.open({ ...head('q1'), id: 'q2', body: sealed })).toThrow();
    expect(() => c.in.open({ ...head('q1'), kind: 'push', body: sealed })).toThrow();
    expect(() => new FrameCipher(randomBytes(32)).open({ ...head('q1'), body: sealed })).toThrow();
    expect(c.in.open({ ...head('q1'), body: sealed })).toEqual({ op: 'state.read', args: {} });
    expect(() => c.in.open({ ...head('q1'), body: sealed })).toThrow('sent before');
  });
});
