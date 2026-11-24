// Kestrel Connect's cryptography under the runtime the app really uses. The server runs on Electron's
// Node (BoringSSL), and every other test runs on plain Node (OpenSSL): a cipher only one of them has
// once made every seal in the app fail while the whole suite passed (2026-11-23).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { connectCryptoProblem } from './crypto-check.ts';

/**
 * The Electron binary the app runs on, when it is here and can start. Null when it was not
 * downloaded, or when this machine cannot run it at all: CI's test job is a Linux container without
 * the libraries Electron loads (libnspr4 and friends), and there it never reaches our code. Only
 * "can it start" is asked here, with a script that does nothing, so a cipher Electron lacks still
 * fails the tests below wherever Electron runs (every Mac, which is where the app is built).
 */
function electronBinary(): string | null {
  try {
    const path = createRequire(fileURLToPath(new URL('../../../app/package.json', import.meta.url)))('electron') as unknown;
    if (typeof path !== 'string' || !existsSync(path)) return null;
    execFileSync(path, ['-e', '0'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', timeout: 60_000 });
    return path;
  } catch {
    return null;
  }
}

const electron = electronBinary();

describe('the cryptography Kestrel Connect needs', () => {
  it('works on this Node', () => {
    expect(connectCryptoProblem()).toBeNull();
  });

  it.skipIf(!electron)('works on the Electron the app runs on', () => {
    const check = fileURLToPath(new URL('./crypto-check.ts', import.meta.url));
    const out = execFileSync(electron!, ['--experimental-transform-types', '--no-warnings', '--input-type=module', '-e', `const m = await import(${JSON.stringify(check)}); console.log(JSON.stringify(m.connectCryptoProblem()))`], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(JSON.parse(out.trim())).toBeNull();
  });

  // The joining vectors (keys.test.ts, and the contract) made by Electron's own crypto, not only checked for agreeing with itself.
  it.skipIf(!electron)("gives the contract's join vectors on the Electron the app runs on", () => {
    const keys = fileURLToPath(new URL('./keys.ts', import.meta.url));
    const script = `
      import { createPrivateKey, createPublicKey } from 'node:crypto';
      const k = await import(${JSON.stringify(keys)});
      const pem = (key, type) => key.export({ type, format: 'pem' });
      const id = (s, a) => {
        const sp = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, s)]), format: 'der', type: 'pkcs8' });
        const ap = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.alloc(32, a)]), format: 'der', type: 'pkcs8' });
        return { signing: { privateKey: pem(sp, 'pkcs8'), publicKey: pem(createPublicKey(sp), 'spki') }, agreement: { privateKey: pem(ap, 'pkcs8'), publicKey: pem(createPublicKey(ap), 'spki') } };
      };
      const N = id(1, 2), A = id(3, 4), nN = Buffer.alloc(32, 0x11), nA = Buffer.alloc(32, 0x22);
      console.log(JSON.stringify([k.joinCommitment(nN, k.publicIdentity(N)), k.joinCode(nN, nA, k.publicIdentity(N), k.publicIdentity(A)), k.signJoinWelcome(A, 'join-1', 'new-1', 'approver-1', k.publicIdentity(N), 3, 7), k.joinConfirmCode(nN, nA, { joinId: 'join-1', newId: 'new-1', approverId: 'approver-1', newKeys: k.publicIdentity(N), approverKeys: k.publicIdentity(A), generation: 3, keyringVersion: 7, signature: k.signJoinWelcome(A, 'join-1', 'new-1', 'approver-1', k.publicIdentity(N), 3, 7) }), k.signJoinJoined(N, 'join-1', 'new-1', 'approver-1', 3, 7), k.signJoinDeclined(N, 'join-1', 'new-1', 'approver-1', 'wrong-code')]));`;
    const out = execFileSync(electron!, ['--experimental-transform-types', '--no-warnings', '--input-type=module', '-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000 });
    expect(JSON.parse(out.trim())).toEqual(['HcWC3KRUpvqsUGptTXWv409N1_9j6AAQO8qoRLnvVtM', '763019', 'esZM2sJ47bT-o3LZBupipOOismDlALNfBsAH6BmY52f7HN5p4CZ1J6xFRblssLm8OkLsV8_MqJRfPrZfsze1Ag', '608238', 'jJnGboIWOX_oujkhY2nH-KxAIrG9Lf3GJ1T17vy6PmahqkR5XUqx3UdJg9tlzuiPaaOFuNCno0DwvnwgrBm5Bg', 'C6-Vlxx4RC3Mkxc5QyAFdJmZJkqoUkRWNXRvnIqNiTu2w38wtziMrTPe-o1GVphxhzoWNDAjkimzOWnPbdA9Bg']);
  });
});
