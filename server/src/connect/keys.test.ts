import { createPrivateKey, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONNECT_PROTOCOL_VERSION, type Envelope } from '../shared/connect-ops.ts';
import { codesMatch, FrameCipher, helloSigned, joinCode, joinConfirmCode, joinDeclinedSigned, joinJoinedSigned, signJoinDeclined, signJoinJoined, joinCommitment, joinCommitted, joinWelcomeSigned, newEphemeral, newIdentity, publicIdentity, sessionKeys, shownCode, signHello, signJoinWelcome, typedCode, type Identity } from './keys.ts';

const head = (id: string): Omit<Envelope, 'body'> => ({ v: CONNECT_PROTOCOL_VERSION, from: 'caller-1', to: 'callee-1', kind: 'request', id });

const ED = Buffer.from('302e020100300506032b657004220420', 'hex');
const X = Buffer.from('302e020100300506032b656e04220420', 'hex');
/** An identity from two 32-byte seeds, as CryptoKit makes one from `rawRepresentation`. */
function fromSeeds(signing: number, agreement: number): Identity {
  const sp = createPrivateKey({ key: Buffer.concat([ED, Buffer.alloc(32, signing)]), format: 'der', type: 'pkcs8' });
  const ap = createPrivateKey({ key: Buffer.concat([X, Buffer.alloc(32, agreement)]), format: 'der', type: 'pkcs8' });
  const pem = (k: KeyObject, type: 'pkcs8' | 'spki') => k.export({ type, format: 'pem' }) as string;
  return { signing: { privateKey: pem(sp, 'pkcs8'), publicKey: pem(createPublicKey(sp), 'spki') }, agreement: { privateKey: pem(ap, 'pkcs8'), publicKey: pem(createPublicKey(ap), 'spki') } };
}

describe('joining', () => {
  // The vectors in kestrel-connect.md, "Account stage 1 as built", for the phone to check its code against.
  const N = fromSeeds(0x01, 0x02);
  const A = fromSeeds(0x03, 0x04);
  const nN = Buffer.alloc(32, 0x11);
  const nA = Buffer.alloc(32, 0x22);

  it("matches the contract's vectors", () => {
    expect(publicIdentity(N)).toEqual({ signing: 'iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w', agreement: 'zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk' });
    expect(publicIdentity(A)).toEqual({ signing: '7UkoxijRwsbq6QM4kFmVYSlZJzpcY_k2NsFGFKyHN9E', agreement: 'rAGyIJ6GNU-4UyN7XeD0-rE8f8v0M6YcAZNpYX_s8Qs' });
    expect(joinCommitment(nN, publicIdentity(N))).toBe('HcWC3KRUpvqsUGptTXWv409N1_9j6AAQO8qoRLnvVtM');
    expect(joinCode(nN, nA, publicIdentity(N), publicIdentity(A))).toBe('763019');
    expect(signJoinWelcome(A, 'join-1', 'new-1', 'approver-1', publicIdentity(N), 3, 7)).toBe('esZM2sJ47bT-o3LZBupipOOismDlALNfBsAH6BmY52f7HN5p4CZ1J6xFRblssLm8OkLsV8_MqJRfPrZfsze1Ag');
    const signature = signJoinWelcome(A, 'join-1', 'new-1', 'approver-1', publicIdentity(N), 3, 7);
    expect(joinConfirmCode(nN, nA, { joinId: 'join-1', newId: 'new-1', approverId: 'approver-1', newKeys: publicIdentity(N), approverKeys: publicIdentity(A), generation: 3, keyringVersion: 7, signature })).toBe('608238');
    expect(signJoinJoined(N, 'join-1', 'new-1', 'approver-1', 3, 7)).toBe('jJnGboIWOX_oujkhY2nH-KxAIrG9Lf3GJ1T17vy6PmahqkR5XUqx3UdJg9tlzuiPaaOFuNCno0DwvnwgrBm5Bg');
    expect(signJoinDeclined(N, 'join-1', 'new-1', 'approver-1', 'wrong-code')).toBe('C6-Vlxx4RC3Mkxc5QyAFdJmZJkqoUkRWNXRvnIqNiTu2w38wtziMrTPe-o1GVphxhzoWNDAjkimzOWnPbdA9Bg');
    expect(signHello(N, 'caller', 'new-1', 'approver-1', publicIdentity(A).agreement, '', 1_700_000_000_000)).toBe('zHhr4yWChLZnkpANFun9DytLPwkDSFY2oAHmWwRmp01x9HDkKcQfKwdNAY9hftIJs6OiyunDdx76XjAPUZa4Dg');
  });

  it('checks the reveal against the commitment, keys and nonce alike', () => {
    const keys = publicIdentity(N);
    const commitment = joinCommitment(nN, keys);
    expect(joinCommitted(commitment, nN, keys)).toBe(true);
    expect(joinCommitted(commitment, nA, keys)).toBe(false);
    expect(joinCommitted(commitment, nN, publicIdentity(A))).toBe(false);
    expect(joinCommitted(commitment, nN, { ...keys, agreement: 'short' })).toBe(false);
  });

  it('gives a different code when any key or nonce is swapped', () => {
    const n = publicIdentity(N);
    const a = publicIdentity(A);
    const other = publicIdentity(newIdentity());
    const code = joinCode(nN, nA, n, a);
    expect(joinCode(nN, randomBytes(32), n, a)).not.toBe(code);
    expect(joinCode(nN, nA, other, a)).not.toBe(code);
    expect(joinCode(nN, nA, n, other)).not.toBe(code);
    expect(joinCode(nN, nA, n, a)).toMatch(/^[0-9]{6}$/);
  });

  it('reads a typed code forgivingly and compares it', () => {
    expect(typedCode(' 763 019 ')).toBe('763019');
    expect(typedCode('763-019')).toBe('763019');
    expect(typedCode('76301')).toBeNull();
    expect(typedCode('76301a')).toBeNull();
    expect(shownCode('763019')).toBe('763 019');
    expect(codesMatch('763019', '763019')).toBe(true);
    expect(codesMatch('763019', '763018')).toBe(false);
  });

  it('gives a different second code for any other welcome or approver, and never the first code', () => {
    const n = publicIdentity(N);
    const a = publicIdentity(A);
    const signature = signJoinWelcome(A, 'join-1', 'new-1', 'approver-1', n, 3, 7);
    const facts = { joinId: 'join-1', newId: 'new-1', approverId: 'approver-1', newKeys: n, approverKeys: a, generation: 3, keyringVersion: 7, signature };
    const code = joinConfirmCode(nN, nA, facts);
    expect(code).not.toBe(joinCode(nN, nA, n, a));
    const other = newIdentity();
    for (const change of [{ approverKeys: publicIdentity(other) }, { approverId: 'approver-2' }, { joinId: 'join-2' }, { generation: 4 }, { keyringVersion: 8 }, { signature: signJoinWelcome(other, 'join-1', 'new-1', 'approver-1', n, 3, 7) }, { newKeys: publicIdentity(other) }]) {
      expect(joinConfirmCode(nN, nA, { ...facts, ...change })).not.toBe(code);
    }
    expect(joinConfirmCode(nN, randomBytes(32), facts)).not.toBe(code);
  });

  it('checks joined and declined against the new device and every field they sign', () => {
    const n = publicIdentity(N).signing;
    const joined = signJoinJoined(N, 'join-1', 'new-1', 'approver-1', 3, 7);
    expect(joinJoinedSigned(n, joined, 'join-1', 'new-1', 'approver-1', 3, 7)).toBe(true);
    expect(joinJoinedSigned(publicIdentity(A).signing, joined, 'join-1', 'new-1', 'approver-1', 3, 7)).toBe(false);
    expect(joinJoinedSigned(n, joined, 'join-1', 'new-1', 'approver-1', 3, 8)).toBe(false);
    expect(joinJoinedSigned(n, joined, 'join-1', 'new-1', 'approver-2', 3, 7)).toBe(false);
    const declined = signJoinDeclined(N, 'join-1', 'new-1', 'approver-1', 'cancelled');
    expect(joinDeclinedSigned(n, declined, 'join-1', 'new-1', 'approver-1', 'cancelled')).toBe(true);
    expect(joinDeclinedSigned(n, declined, 'join-1', 'new-1', 'approver-1', 'expired')).toBe(false);
    expect(joinDeclinedSigned(n, joined, 'join-1', 'new-1', 'approver-1', 'cancelled')).toBe(false);
  });

  it("signs the welcome over the new device's keys and the keyring version", () => {
    const n = publicIdentity(N);
    const sig = signJoinWelcome(A, 'join-1', 'new-1', 'approver-1', n, 3, 7);
    expect(joinWelcomeSigned(publicIdentity(A).signing, sig, 'join-1', 'new-1', 'approver-1', n, 3, 7)).toBe(true);
    expect(joinWelcomeSigned(publicIdentity(N).signing, sig, 'join-1', 'new-1', 'approver-1', n, 3, 7)).toBe(false);
    expect(joinWelcomeSigned(publicIdentity(A).signing, sig, 'join-1', 'new-1', 'approver-1', n, 3, 8)).toBe(false);
    expect(joinWelcomeSigned(publicIdentity(A).signing, sig, 'join-2', 'new-1', 'approver-1', n, 3, 7)).toBe(false);
    expect(joinWelcomeSigned(publicIdentity(A).signing, sig, 'join-1', 'new-1', 'approver-1', publicIdentity(newIdentity()), 3, 7)).toBe(false);
  });
});

describe('the handshake', () => {
  it('agrees the same keys on both sides, signed by each identity', () => {
    const phone = newIdentity();
    const desk = newIdentity();
    const pe = newEphemeral();
    const de = newEphemeral();
    const at = 1_000;
    const phoneSig = signHello(phone, 'caller', 'caller-1', 'callee-1', pe.publicKey, '', at);
    expect(helloSigned(publicIdentity(phone).signing, phoneSig, 'caller', 'caller-1', 'callee-1', pe.publicKey, '', at)).toBe(true);
    expect(helloSigned(publicIdentity(desk).signing, phoneSig, 'caller', 'caller-1', 'callee-1', pe.publicKey, '', at)).toBe(false);
    expect(helloSigned(publicIdentity(phone).signing, phoneSig, 'caller', 'caller-1', 'callee-1', newEphemeral().publicKey, '', at)).toBe(false);
    expect(helloSigned(publicIdentity(phone).signing, phoneSig, 'caller', 'caller-1', 'callee-1', pe.publicKey, '', at + 1)).toBe(false);
    expect(helloSigned(publicIdentity(phone).signing, phoneSig, 'callee', 'caller-1', 'callee-1', pe.publicKey, '', at)).toBe(false);
    const deskSig = signHello(desk, 'callee', 'caller-1', 'callee-1', pe.publicKey, de.publicKey, at);
    expect(helloSigned(publicIdentity(desk).signing, deskSig, 'callee', 'caller-1', 'callee-1', pe.publicKey, de.publicKey, at)).toBe(true);
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
