// The account data key's cryptography (account-key.ts): standard vectors for every primitive it uses,
// so the phone's CryptoKit code can be checked against the same numbers, then the constructions.
import { createCipheriv, createPrivateKey, diffieHellman, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newIdentity, publicIdentity } from './keys.ts';
import { keyringSigned, newAccountKey, openRecord, openSealed, recoveryKey, recoverySecretFromWords, recoveryWords, sealRecord, sealWith, signKeyring, tagOf, unwrapKey, wrapKey, x25519FromRaw } from './account-key.ts';

const hex = (s: string) => Buffer.from(s.replace(/\s/g, ''), 'hex');

describe('the primitives, against their published vectors', () => {
  it('X25519 (RFC 7748, section 6.1)', () => {
    const alice = x25519FromRaw(hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'));
    const bobPublic = hex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
    const shared = diffieHellman({ privateKey: alice.privateKey, publicKey: x25519FromRaw(hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb')).publicKey });
    expect(shared.toString('hex')).toBe('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742');
    expect(alice.publicRaw.toString('hex')).toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
    expect(bobPublic.length).toBe(32);
  });

  it('HKDF-SHA256 (RFC 5869, test case 1)', () => {
    const okm = Buffer.from(hkdfSync('sha256', hex('0b'.repeat(22)), hex('000102030405060708090a0b0c'), hex('f0f1f2f3f4f5f6f7f8f9'), 42));
    expect(okm.toString('hex')).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  });

  it('AES-256-GCM (the GCM specification, McGrew and Viega, test case 16)', () => {
    const key = hex('feffe9928665731c6d6a8f9467308308'.repeat(2));
    const cipher = createCipheriv('aes-256-gcm', key, hex('cafebabefacedbaddecaf888'), { authTagLength: 16 });
    const plain = hex('d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39');
    cipher.setAAD(hex('feedfacedeadbeeffeedfacedeadbeefabaddad2'), { plaintextLength: plain.length });
    const text = Buffer.concat([cipher.update(plain), cipher.final()]);
    expect(text.toString('hex')).toBe('522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662');
    expect(cipher.getAuthTag().toString('hex')).toBe('76fc6ece0f4e1768cddf8853bb2d551b');
  });

  it('BIP-39 English words for 32 zero bytes, and back', () => {
    const words = recoveryWords(Buffer.alloc(32));
    expect(words).toHaveLength(24);
    expect(words.join(' ')).toBe(`${'abandon '.repeat(23)}art`);
    expect(recoverySecretFromWords(words.join(' '))?.equals(Buffer.alloc(32))).toBe(true);
  });

  it('BIP-39 for 0x7f repeated (the BIP-39 reference vectors)', () => {
    expect(recoveryWords(Buffer.alloc(32, 0x7f)).join(' ')).toBe('legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title');
  });
});

describe('the recovery words', () => {
  it('forgive case, spacing and line breaks, and refuse a wrong checksum or word', () => {
    const secret = Buffer.alloc(32, 0x7f);
    const words = recoveryWords(secret);
    expect(recoverySecretFromWords(`  ${words.join('\n').toUpperCase()}  `)?.equals(secret)).toBe(true);
    const swapped = [...words];
    swapped[23] = 'zoo';
    expect(recoverySecretFromWords(swapped.join(' '))).toBeNull();
    expect(recoverySecretFromWords(words.slice(0, 23).join(' '))).toBeNull();
    expect(recoverySecretFromWords([...words.slice(0, 23), 'kestrelx'].join(' '))).toBeNull();
  });

  it('make the same key from the same words, and a different one from others', () => {
    const a = recoveryKey(Buffer.alloc(32, 1));
    expect(recoveryKey(Buffer.alloc(32, 1)).publicRaw.equals(a.publicRaw)).toBe(true);
    expect(recoveryKey(Buffer.alloc(32, 2)).publicRaw.equals(a.publicRaw)).toBe(false);
    // The private key is HKDF of the 32 bytes, as the contract says.
    const derived = Buffer.from(hkdfSync('sha256', Buffer.alloc(32, 1), Buffer.alloc(0), 'kestrel-connect recovery v1', 32));
    expect(x25519FromRaw(derived).publicRaw.equals(a.publicRaw)).toBe(true);
  });
});

describe('a sealed copy of the key for a device', () => {
  const phone = newIdentity();
  const phoneAgreement = publicIdentity(phone).agreement;
  const adk = newAccountKey();

  it('opens only for that device, that generation and that recipient', () => {
    const wrapped = wrapKey(adk, phoneAgreement, 3, 'phone-1');
    expect(Buffer.from(wrapped, 'base64url')).toHaveLength(81);
    const mine = createPrivateKey(phone.agreement.privateKey);
    expect(unwrapKey(wrapped, mine, 3, 'phone-1').equals(adk)).toBe(true);
    expect(() => unwrapKey(wrapped, mine, 4, 'phone-1')).toThrow();
    expect(() => unwrapKey(wrapped, mine, 3, 'phone-2')).toThrow();
    expect(() => unwrapKey(wrapped, createPrivateKey(newIdentity().agreement.privateKey), 3, 'phone-1')).toThrow();
  });

  it('is refused when a byte changes', () => {
    const wrapped = Buffer.from(wrapKey(adk, phoneAgreement, 1, 'phone-1'), 'base64url');
    wrapped[50] = (wrapped[50] ?? 0) ^ 1;
    expect(() => unwrapKey(wrapped.toString('base64url'), createPrivateKey(phone.agreement.privateKey), 1, 'phone-1')).toThrow();
  });

  it('is fresh each time', () => {
    expect(wrapKey(adk, phoneAgreement, 1, 'p')).not.toBe(wrapKey(adk, phoneAgreement, 1, 'p'));
  });

  it('opens for the recovery key', () => {
    const recovery = recoveryKey(Buffer.alloc(32, 9));
    const wrapped = wrapKey(adk, recovery.publicRaw.toString('base64url'), 2, 'recovery');
    expect(unwrapKey(wrapped, recovery.privateKey, 2, 'recovery').equals(adk)).toBe(true);
  });
});

describe('sealing under the key', () => {
  const adk = newAccountKey();

  it('opens with the same kind, id and generation only', () => {
    const sealed = sealRecord(adk, 'record', 'abc', 2, { hello: 'world' });
    expect(openRecord(adk, sealed, 'record', 'abc', 2)).toEqual({ hello: 'world' });
    expect(() => openRecord(adk, sealed, 'record', 'abd', 2)).toThrow();
    expect(() => openRecord(adk, sealed, 'message', 'abc', 2)).toThrow();
    expect(() => openRecord(adk, sealed, 'record', 'abc', 3)).toThrow();
    expect(() => openRecord(newAccountKey(), sealed, 'record', 'abc', 2)).toThrow();
  });

  it('holds no plaintext and is fresh each time', () => {
    const a = sealRecord(adk, 'record', 'x', 1, { secret: 'the launch codes' });
    expect(Buffer.from(a, 'base64url').toString('latin1')).not.toContain('launch');
    expect(a).not.toBe(sealRecord(adk, 'record', 'x', 1, { secret: 'the launch codes' }));
  });

  it('matches the contract exactly (an interop vector for the phone)', () => {
    const key = Buffer.alloc(32, 0x42);
    const salt = Buffer.alloc(16, 0x24);
    const sealed = sealWith(key, 'record', 'id-1', 7, Buffer.from('{"v":1}'), salt);
    const k = Buffer.from(hkdfSync('sha256', key, salt, 'kestrel-connect seal v2', 32));
    const cipher = createCipheriv('aes-256-gcm', k, Buffer.alloc(12), { authTagLength: 16 });
    cipher.setAAD(Buffer.from('record|id-1|7'), { plaintextLength: 7 });
    const body = Buffer.concat([cipher.update('{"v":1}'), cipher.final()]);
    expect(sealed).toBe(Buffer.concat([Buffer.from([2]), salt, body, cipher.getAuthTag()]).toString('base64url'));
    expect(sealed).toBe('AiQkJCQkJCQkJCQkJCQkJCQ7uvU9J9srmotHERRjs9RWvMowzq134w');
    expect(openSealed(key, sealed, 'record', 'id-1', 7).toString()).toBe('{"v":1}');
  });
});

describe('tags and the keyring signature', () => {
  it('a tag is 22 characters, the same for the same label, and says nothing of it', () => {
    const idKey = Buffer.alloc(32, 5);
    const a = tagOf(idKey, 'session|mac-1|s1');
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(tagOf(idKey, 'session|mac-1|s1')).toBe(a);
    expect(tagOf(idKey, 'session|mac-1|s2')).not.toBe(a);
    expect(tagOf(Buffer.alloc(32, 6), 'session|mac-1|s1')).not.toBe(a);
  });

  it('a keyring signature checks only for its signer, generation, version and text', () => {
    const desk = newIdentity();
    const signing = publicIdentity(desk).signing;
    const signature = signKeyring(desk, 2, 3, 'sealed-text');
    expect(keyringSigned(signing, signature, 2, 3, 'sealed-text')).toBe(true);
    expect(keyringSigned(signing, signature, 2, 4, 'sealed-text')).toBe(false);
    expect(keyringSigned(signing, signature, 1, 3, 'sealed-text')).toBe(false);
    expect(keyringSigned(signing, signature, 2, 3, 'sealed-texT')).toBe(false);
    expect(keyringSigned(publicIdentity(newIdentity()).signing, signature, 2, 3, 'sealed-text')).toBe(false);
    expect(keyringSigned(signing, 'nonsense', 2, 3, 'sealed-text')).toBe(false);
  });
});
