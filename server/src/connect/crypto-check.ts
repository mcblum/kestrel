// Whether this runtime can do Kestrel Connect's cryptography at all, tried once for real: a frame sealed
// and opened, a record sealed and opened under an account key, and that key wrapped for a device and
// unwrapped. The app's server runs on Electron's Node (BoringSSL), not the Node the tests run on, and a
// cipher one has and the other lacks once made every seal fail with "Unknown cipher" (2026-11-23).
// Connect stays off with the reason rather than failing quietly.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { newAccountKey, openSealed, sealWith, unwrapKey, wrapKey } from './account-key.ts';
import { FrameCipher, helloSigned, joinCode, joinConfirmCode, joinJoinedSigned, signJoinJoined, joinCommitment, joinCommitted, joinWelcomeSigned, newEphemeral, newIdentity, newJoinNonce, publicIdentity, sessionKeys, signHello, signJoinWelcome } from './keys.ts';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A join and a channel between two devices, end to end: commitment, code, welcome, second code, hello and keys. */
function joiningWorks(): void {
  const fresh = newIdentity();
  const approver = newIdentity();
  const [n, a] = [publicIdentity(fresh), publicIdentity(approver)];
  const [nN, nA] = [newJoinNonce(), newJoinNonce()];
  if (!joinCommitted(joinCommitment(nN, n), nN, n) || joinCode(nN, nA, n, a) !== joinCode(nN, nA, n, a)) throw new Error('a join code could not be made');
  const signature = signJoinWelcome(approver, 'j', 'n', 'a', n, 1, 2);
  if (!joinWelcomeSigned(a.signing, signature, 'j', 'n', 'a', n, 1, 2)) throw new Error('a welcome did not verify');
  const facts = { joinId: 'j', newId: 'n', approverId: 'a', newKeys: n, approverKeys: a, generation: 1, keyringVersion: 2, signature };
  if (!/^[0-9]{6}$/.test(joinConfirmCode(nN, nA, facts))) throw new Error('a confirming code could not be made');
  if (!joinJoinedSigned(n.signing, signJoinJoined(fresh, 'j', 'n', 'a', 1, 2), 'j', 'n', 'a', 1, 2)) throw new Error('a joined did not verify');
  const [ce, ee] = [newEphemeral(), newEphemeral()];
  if (!helloSigned(n.signing, signHello(fresh, 'caller', 'n', 'a', ce.publicKey, '', 1), 'caller', 'n', 'a', ce.publicKey, '', 1)) throw new Error('a hello did not verify');
  if (!sessionKeys(ce, ee.publicKey, ce.publicKey, ee.publicKey).callerToCallee.equals(sessionKeys(ee, ce.publicKey, ce.publicKey, ee.publicKey).callerToCallee)) throw new Error('two devices did not agree a key');
}

/** Null when everything works; otherwise a sentence saying what does not. */
export function connectCryptoProblem(): string | null {
  try {
    const key = randomBytes(32);
    const head = { v: 1, from: 'a', to: 'b', kind: 'request' as const, id: 'x' };
    const body = new FrameCipher(key).seal(head, { ok: true });
    if ((new FrameCipher(key).open({ ...head, body }) as { ok?: unknown }).ok !== true) throw new Error('a frame did not open to what was sealed');
    const adk = newAccountKey();
    if (openSealed(adk, sealWith(adk, 'record', 'r', 1, Buffer.from('x')), 'record', 'r', 1).toString() !== 'x') throw new Error('a record did not open to what was sealed');
    const device = generateKeyPairSync('x25519');
    const raw = device.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
    if (!unwrapKey(wrapKey(adk, raw, 1, 'd'), device.privateKey, 1, 'd').equals(adk)) throw new Error('a wrapped key did not unwrap');
    joiningWorks();
    return null;
  } catch (error) {
    return `Kestrel Connect cannot run here: this build's cryptography failed (${message(error)}). Update Kestrel.`;
  }
}
