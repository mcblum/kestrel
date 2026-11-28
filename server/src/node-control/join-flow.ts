// `kestrel node join` (worker-nodes.md, section 5; account-sessions.md 4.4): sign in by a device authorization
// grant typed on another device, then ask to join the account and be let in by the two codes, never by recovery
// words. It drives the node's own Kestrel Connect module through the same methods a window's buttons call, and
// watches the view it pushes; nothing here decides what to trust (join.ts does). The terminal going away withdraws
// what is under way. Only the sign-in's short code and the two six-digit codes are ever said.
import type { ConnectView } from '../shared/connect.ts';
import type { DeviceSignInPrompt } from '../connect/link/device-sign-in.ts';
import { JOIN_AGAIN, JOIN_NEXT } from '../shared/node-commands.ts';
import { TerminalGone, type JoinEnd, type JoinIo } from './join-socket.ts';

/** What of the Connect module (connect/link/connect.ts) the join uses. */
export interface JoinTarget {
  view(): ConnectView;
  onChange(listener: (view: ConnectView) => void): () => void;
  setEnabled(enabled: boolean): Promise<unknown>;
  signInWithCode(): Promise<DeviceSignInPrompt>;
  cancelSignIn(): void;
  askToJoin(): Promise<unknown>;
  confirmJoin(code: string): Promise<unknown>;
  cancelJoin(): Promise<unknown>;
  inAccount(): boolean;
  wasRemoved(): boolean;
  rejoin(): void;
}

/** How often the view is looked at again with no change pushed: a request's time running out pushes nothing. */
const RECHECK_MS = 1_000;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Resolves at the next change of the view or the next recheck; rejects when the terminal has gone. */
function nextChange(target: JoinTarget, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new TerminalGone());
    const done = (error?: Error) => {
      off();
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve();
    };
    const aborted = () => done(new TerminalGone());
    const off = target.onChange(() => done());
    const timer = setTimeout(() => done(), RECHECK_MS);
    timer.unref?.();
    signal.addEventListener('abort', aborted, { once: true });
  });
}

const minutesLeft = (expiresAt: number): number => Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));

/**
 * Where a request to join is let in, as step 2 says it (issue 72): a desktop of the account that is open draws the
 * request's card over whatever page it shows, and Settings → Connections keeps it when the card was put aside. Let in
 * there makes the code the node then shows. One place.
 */
export const LET_IN_WHERE = (name: string): string => `Kestrel on your other devices is showing a request. Choose Let in on ${name}'s request there, or find it in Settings → Connections.`;

/** The steps' headings, and the title above them. */
export const JOIN_TITLE = (name: string): string => `Kestrel worker node: join ${name} to your account`;
const SIGN_IN = 'Sign in';
const LET_IN = 'Let this node in';
const CONFIRM = 'Confirm';

/** The end of a join that did not finish: its reason, and to run join again unless the reason says so already. */
const notIn = (text: string): JoinEnd => (text.includes(JOIN_AGAIN) ? { ok: false, text } : { ok: false, text, next: JOIN_AGAIN });

/** Step 1: the address and the short code, then a wait until it ends. Null when signed in; the reason when not. */
async function signIn(target: JoinTarget, io: JoinIo, signal: AbortSignal): Promise<string | null> {
  io.say({ step: 1, kind: 'heading', text: SIGN_IN });
  if (target.view().account.state !== 'signed-in') {
    const prompt = await target.signInWithCode();
    io.say({ step: 1, kind: 'field', label: 'Open', value: prompt.verificationUri });
    io.say({ step: 1, kind: 'field', label: 'Code', value: prompt.userCode, note: `works for ${minutesLeft(prompt.expiresAt)} minutes` });
    io.say({ step: 1, kind: 'wait', text: 'Waiting for you to sign in…' });
  }
  for (;;) {
    const { account } = target.view();
    if (account.state === 'signed-in') {
      io.say({ step: 1, kind: 'done', text: `Signed in as ${account.email}` });
      return null;
    }
    if (account.state === 'signed-out') return account.reason ?? 'The sign-in did not finish.';
    await nextChange(target, signal);
  }
}

/**
 * Steps 2 and 3, after signing in: connected, asked to join, the first code shown once a device chose Let in, the
 * second code typed here; until the node is in (ok) or the request ends (not, with why).
 */
async function letIn(target: JoinTarget, io: JoinIo, signal: AbortSignal): Promise<JoinEnd> {
  const said = new Set<string>();
  const once = (key: string, say: () => void) => {
    if (said.has(key)) return;
    said.add(key);
    say();
  };
  let asked = false;
  io.say({ step: 2, kind: 'heading', text: LET_IN });
  for (;;) {
    const view = target.view();
    const { link, keys, joining: j } = view;
    const name = view.computerName;
    if (view.account.state === 'signed-out') return notIn(view.account.reason ?? 'Signed out of Kestrel Connect.');
    if (link.state === 'offline' && link.retryAt === null) return notIn(link.reason);
    if (link.state === 'offline') once(`offline:${link.reason}`, () => io.say({ step: 2, kind: 'line', text: `Not connected to Kestrel Connect yet: ${link.reason} Trying again.` }));
    if (keys.state === 'failed') return notIn(keys.reason);
    if (link.state === 'connected' && keys.state === 'ready' && target.inAccount()) return { ok: true, text: `${name} is in your account and connected to Kestrel Connect.`, next: JOIN_NEXT };
    // A request seen under way is this run's: when it ends, the join ends (a stale one from before is asked again).
    if (j && j.state !== 'ended') asked = true;
    if (link.state === 'connected' && keys.state === 'locked') {
      if (j === null || (j.state === 'ended' && !asked)) {
        asked = true;
        await target.askToJoin();
        continue;
      }
      if (j.state === 'ended') return notIn(j.reason);
      // Where to go is said once, whether or not the request was seen waiting before a device opened it.
      once('where', () => io.say({ step: 2, kind: 'line', text: LET_IN_WHERE(name) }));
      if (j.state === 'asking') once('asking', () => io.say({ step: 2, kind: 'wait', text: 'Waiting for you to choose Let in there…' }));
      if (j.state === 'code') {
        once(`code:${j.code}`, () => {
          io.say({ step: 2, kind: 'line', text: `${j.by} opened it. Type this code on ${j.by}:` });
          io.say({ step: 2, kind: 'code', code: j.code });
        });
      }
      if (j.state === 'confirm') {
        once('confirm', () => {
          io.say({ step: 2, kind: 'done', text: `${j.by} let it in` });
          io.say({ step: 3, kind: 'heading', text: CONFIRM });
          io.say({ step: 3, kind: 'line', text: `${j.by} now shows a code of its own. Type it here, so this node knows it was let in by your device.` });
        });
        const typed = await io.ask(3, `Code from ${j.by}: `);
        // A wrong code with tries left is said; the last one ends the request, which says why on its own.
        await target.confirmJoin(typed).catch((error: unknown) => target.view().joining?.state === 'confirm' && io.say({ step: 3, kind: 'problem', text: message(error) }));
        continue;
      }
    }
    await nextChange(target, signal);
  }
}

/** Withdraws what is under way: a sign-in is cancelled, a request to join is ended and any key offered is not kept. */
async function withdraw(target: JoinTarget): Promise<void> {
  const { account, joining } = target.view();
  if (account.state === 'signing-in') target.cancelSignIn();
  if (joining && joining.state !== 'in' && joining.state !== 'ended') await target.cancelJoin().catch(() => undefined);
}

/** Runs `kestrel node join` against this node's Connect module. Never throws: how it ended is the answer. */
export async function joinFlow(target: JoinTarget, io: JoinIo, signal: AbortSignal): Promise<JoinEnd> {
  try {
    const start = target.view();
    if (start.unavailable) return { ok: false, text: start.unavailable };
    if (target.inAccount()) return { ok: false, text: `${start.computerName} is in your account already. To join it again, remove it from another of your devices first.` };
    io.say({ step: 0, kind: 'heading', text: JOIN_TITLE(start.computerName) });
    if (!start.enabled) await target.setEnabled(true);
    if (target.wasRemoved()) {
      io.say({ step: 0, kind: 'line', text: 'It was removed from your account before, so it asks to join again as a new device.' });
      target.rejoin();
    }
    const notSignedIn = await signIn(target, io, signal);
    if (notSignedIn) return notIn(notSignedIn);
    return await letIn(target, io, signal);
  } catch (error) {
    return notIn(message(error));
  } finally {
    if (signal.aborted) await withdraw(target);
  }
}
