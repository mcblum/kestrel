// A stand-in for the iPhone app, on the command line: signs in to Kestrel Connect, registers as a
// phone, asks to be let into the account (a computer of the account types the code it shows, and it
// keeps the account key once you say yes), then reads the workspace and answers a card over the
// end-to-end encrypted channel, through the real relay. It proves the path without iOS code
// (docs/designs/kestrel-connect.md, "Account stage 1 as built"). Not part of the app.
//
//   pnpm --filter @kestrel/server exec tsx scripts/connect-phone.ts sign-in
//   pnpm --filter @kestrel/server exec tsx scripts/connect-phone.ts join [computer name]
//   pnpm --filter @kestrel/server exec tsx scripts/connect-phone.ts state
//   pnpm --filter @kestrel/server exec tsx scripts/connect-phone.ts cards
//   pnpm --filter @kestrel/server exec tsx scripts/connect-phone.ts answer <sessionId> <requestId> <optionId>
//   pnpm --filter @kestrel/server exec tsx scripts/connect-phone.ts sign-out
//
// Signs in as the desktop's public client (the phone's own client redirects to the app's URL
// scheme, which a terminal cannot receive). Keeps its sign-in, its keys, what it trusts and the computer in a file
// only the user can read: KESTREL_PHONE_FILE, or connect-phone.json in Kestrel's data folder.
// KESTREL_CONNECT_URL names another service, as for the desktop.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { dataDir } from '../src/data-dir.ts';
import { newIdentity, publicIdentity, type Identity } from '../src/connect/keys.ts';
import { AccountKeys, type KeysTrust } from '../src/connect/link/account-keys.ts';
import { HeldApi } from '../src/connect/link/held-api.ts';
import { AccountJoin } from '../src/connect/link/join.ts';
import { JoinApi } from '../src/connect/link/join-api.ts';
import { OidcProvider } from '../src/connect/link/identity.ts';
import { listenForCallback } from '../src/connect/link/loopback.ts';
import { PhoneChannel, type KnownDesk } from '../src/connect/link/phone.ts';
import { HttpConnectService, type ServiceMethod } from '../src/connect/link/service.ts';
import { serviceUrl } from '../src/connect/link/start.ts';
import { plainFileVault, type StoredTokens } from '../src/connect/link/vault.ts';
import { CONNECT_DESKTOP_CLIENT } from '../src/shared/connect.ts';
import type { ChatMessage, SessionView, WorkspaceState } from '../src/model.ts';
import { statusOf } from '../src/shared/status.ts';

interface PhoneFile {
  tokens: StoredTokens | null;
  device: { id: string; identity: Identity; subject: string } | null;
  trust: KeysTrust | null;
  desk: KnownDesk | null;
}

const file = plainFileVault(process.env.KESTREL_PHONE_FILE || join(dataDir(), 'connect-phone.json'));
const read = async (): Promise<PhoneFile> => {
  const raw = (await file.read()) as unknown as Partial<PhoneFile> & { paired?: unknown };
  const extra = (raw.paired ?? {}) as Partial<PhoneFile>;
  return { tokens: raw.tokens ?? null, device: extra.device ?? null, trust: extra.trust ?? null, desk: extra.desk ?? null };
};
const write = (data: PhoneFile) => file.write({ tokens: data.tokens, device: null, paired: { device: data.device, trust: data.trust, desk: data.desk } });

const service = new HttpConnectService(serviceUrl());
const identity = new OidcProvider(async () => (await service.config()).issuer, CONNECT_DESKTOP_CLIENT);
const NAME = 'Command-line phone';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function openBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  execFile(command, args, () => undefined);
}

async function signIn(): Promise<void> {
  const data = await read();
  let state: string | null = null;
  const callback = await listenForCallback(() => state);
  const request = await identity.authorize(callback.redirectUri);
  state = request.state;
  console.log(`Opening the sign-in page. If no browser opens, go to:\n${request.url}`);
  openBrowser(request.url);
  const result = await callback.result;
  if ('error' in result) fail(`Sign-in did not finish: ${result.error}`);
  const tokens = await identity.exchange(result.code, request);
  let device = data.device?.subject === tokens.subject ? data.device : null;
  if (!device) {
    const keys = newIdentity();
    const registered = await service.registerDevice(tokens.accessToken, NAME, 'phone', publicIdentity(keys));
    device = { id: registered.id, identity: keys, subject: tokens.subject };
  }
  const same = device === data.device;
  await write({ tokens, device, trust: same ? data.trust : null, desk: same ? data.desk : null });
  console.log(`Signed in as ${tokens.email}; this stand-in is device ${device.id}.`);
}

async function token(data: PhoneFile): Promise<string> {
  if (!data.tokens) fail('Sign in first: connect-phone.ts sign-in');
  if (data.tokens.accessExpiresAt - Date.now() > 60_000) return data.tokens.accessToken;
  const tokens = await identity.refresh(data.tokens);
  await write({ ...data, tokens });
  return tokens.accessToken;
}

/** Opens the relay socket and resolves once the service has welcomed it. */
async function connect(data: PhoneFile): Promise<{ phone: PhoneChannel; close(): void }> {
  if (!data.device) fail('Sign in first: connect-phone.ts sign-in');
  const device = data.device;
  const accessToken = await token(data);
  await service.config();
  let phone: PhoneChannel | null = null;
  return new Promise((resolve, reject) => {
    const socket = service.openRelay(accessToken, device.id, {
      open: () => undefined,
      message: (text) => {
        const parsed = JSON.parse(text) as { service?: string; code?: string; reason?: string };
        if (parsed.service === 'welcome' && !phone) {
          phone = new PhoneChannel({ id: device.id, name: NAME, identity: device.identity, send: (t) => socket.send(t) });
          resolve({ phone, close: () => socket.close(1000) });
        } else if (parsed.service === 'refused') {
          console.error(`The relay refused a frame: ${parsed.reason} (${parsed.code})`);
        } else phone?.receive(text);
      },
      pong: () => undefined,
      refused: (refusal) => reject(new Error(`${refusal.message} (${refusal.code})`)),
      closed: (code, reason) => (phone ? console.error(`The relay closed the connection (${code} ${reason})`) : reject(new Error(`closed ${code} ${reason}`))),
      error: (error) => reject(error),
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Asks to be let into the account, as the iPhone app does, and keeps the computer named (or the first one). */
async function joinAccount(computer: string): Promise<void> {
  let data = await read();
  const device = data.device ?? fail('Sign in first: connect-phone.ts sign-in');
  const accessToken = await token(data);
  const call = (method: ServiceMethod, path: string, body?: unknown) => service.call(accessToken, device.id, method, path, body);
  const me = () => ({ id: device.id, name: NAME, kind: 'phone' as const, identity: device.identity });
  const keys = new AccountKeys({
    api: () => new HeldApi(call),
    me,
    trust: () => data.trust,
    saveTrust: async (trust) => {
      data = { ...data, trust };
      await write(data);
    },
    changed: () => undefined,
  });
  const { phone, close } = await connect(data);
  const joining = new AccountJoin({ api: () => new JoinApi(call), me, keys, hello: (to, body) => phone.sendHello(to, body), changed: () => undefined });
  phone.onJoin((from, body) => joining.receive(from, body));
  try {
    await new JoinApi(call).putKeys(publicIdentity(device.identity));
    await keys.sync();
    // A copy it cannot open, left from a join it was closed part-way through: deleted, and it asks again (step 8b).
    if (keys.stranded()) await keys.discardCopy();
    if (!keys.ready()) {
      await joining.ask();
      console.log('Asked to join your account. On a computer of your account, open Settings → Connections → Kestrel Connect and choose Let in.');
      let shown = '';
      for (;;) {
        const view = joining.joining();
        if (view?.state === 'code' && view.code !== shown) console.log(`Type this code on ${view.by}: ${(shown = view.code)}`);
        if (view?.state === 'ended') fail(view.reason);
        if (view?.state === 'confirm') {
          const ask = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await ask.question(`${view.by} let this device in. Type the second code ${view.by} shows now (empty to cancel): `);
          ask.close();
          if (answer.trim() === '') {
            await joining.cancel();
            fail('Cancelled: the key was not kept.');
          }
          await joining.confirm(answer).catch((error: unknown) => console.error(error instanceof Error ? error.message : String(error)));
          const after = joining.joining();
          if (after?.state === 'ended') fail(after.reason);
          if (after?.state === 'in') break;
          continue;
        }
        await sleep(300);
      }
    }
    const devices = (await new JoinApi(call).devices()).filter((d) => d.kind === 'desktop' && keys.member(d.id) && (!computer || d.name === computer));
    const desk = devices[0] ?? fail(computer ? `No computer called ${computer} is in your account.` : 'No computer is in your account yet.');
    await write({ ...data, desk: { id: desk.id, signing: keys.member(desk.id)! } });
    console.log(`In your account. Talking to ${desk.name} (${desk.id}) from now on.`);
  } finally {
    close();
  }
}

/** Runs `work` over an open channel to the paired desk. */
async function withDesk(work: (phone: PhoneChannel) => Promise<void>): Promise<void> {
  const data = await read();
  if (!data.desk) fail('Join your account first: connect-phone.ts join');
  const { phone, close } = await connect(data);
  try {
    await phone.open(data.desk);
    await work(phone);
  } finally {
    close();
  }
}

async function ok(phone: PhoneChannel, op: string, args: Record<string, unknown> = {}): Promise<any> {
  const answer = await phone.request(op, args);
  if (!answer.ok) fail(`${op} was refused: ${answer.reason}`);
  return answer.result;
}

async function waitingCards(phone: PhoneChannel, state: WorkspaceState) {
  const cards: Array<{ session: SessionView; message: ChatMessage }> = [];
  for (const session of state.sessions.filter((s) => statusOf(s) === 'needs-you')) {
    const page = await ok(phone, 'session.read', { sessionId: session.id, last: 20 });
    for (const message of page.messages as ChatMessage[]) if (message.input && !message.input.resolved) cards.push({ session, message });
  }
  return cards;
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'sign-in') await signIn();
  else if (command === 'sign-out') {
    const data = await read();
    if (data.tokens) await identity.revoke(data.tokens).catch(() => undefined);
    await write({ ...data, tokens: null });
    console.log('Signed out.');
  } else if (command === 'join') await joinAccount(rest.join(' '));
  else if (command === 'state')
    await withDesk(async (phone) => {
      const state = (await ok(phone, 'state.read')) as WorkspaceState;
      console.log(`${state.projects.length} projects, ${state.sessions.length} sessions:`);
      for (const s of state.sessions.slice(0, 30)) console.log(`  ${s.id}  ${statusOf(s).padEnd(9)}  ${s.title}`);
    });
  else if (command === 'cards')
    await withDesk(async (phone) => {
      const cards = await waitingCards(phone, (await ok(phone, 'state.read')) as WorkspaceState);
      if (cards.length === 0) console.log('Nothing is waiting on you.');
      for (const { session, message } of cards) {
        const input = message.input!;
        console.log(`${session.title}\n  session ${session.id}, card ${input.id}: ${input.title ?? input.kind}`);
        for (const option of input.options ?? []) console.log(`    ${option.id}: ${option.label}`);
      }
    });
  else if (command === 'answer') {
    const [sessionId, requestId, optionId] = rest;
    if (!sessionId || !requestId || !optionId) fail('answer <sessionId> <requestId> <optionId>');
    await withDesk(async (phone) => console.log(JSON.stringify(await ok(phone, 'session.answer', { sessionId, requestId, optionId }))));
  } else fail('Commands: sign-in, join [computer name], state, cards, answer <sessionId> <requestId> <optionId>, sign-out');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
process.exit(0);
