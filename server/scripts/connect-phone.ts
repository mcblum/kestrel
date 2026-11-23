// A stand-in for the iPhone app, on the command line: signs in to Kestrel Connect, registers as a
// phone, pairs with a running desktop by the code its Pair a phone page shows, then reads the
// workspace and answers a card over the end-to-end encrypted channel, through the real relay. It
// proves the path without iOS code (phase 3 of docs/designs/kestrel-connect.md). Not part of the app.
//
//   pnpm --filter @kestrel/server exec tsx scripts/connect-phone.ts sign-in
//   pnpm --filter @kestrel/server exec tsx scripts/connect-phone.ts pair 'kestrel-pair:…'
//   pnpm --filter @kestrel/server exec tsx scripts/connect-phone.ts state
//   pnpm --filter @kestrel/server exec tsx scripts/connect-phone.ts cards
//   pnpm --filter @kestrel/server exec tsx scripts/connect-phone.ts answer <sessionId> <requestId> <optionId>
//   pnpm --filter @kestrel/server exec tsx scripts/connect-phone.ts sign-out
//
// Signs in as the desktop's public client (the phone's own client redirects to the app's URL
// scheme, which a terminal cannot receive). Keeps its sign-in, its keys and the paired desk in a file
// only the user can read: KESTREL_PHONE_FILE, or connect-phone.json in Kestrel's data folder.
// KESTREL_CONNECT_URL names another service, as for the desktop.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { dataDir } from '../src/data-dir.ts';
import { newIdentity, type Identity } from '../src/connect/keys.ts';
import { OidcProvider } from '../src/connect/link/identity.ts';
import { listenForCallback } from '../src/connect/link/loopback.ts';
import { PhoneChannel, type PairedDesk } from '../src/connect/link/phone.ts';
import { HttpConnectService } from '../src/connect/link/service.ts';
import { serviceUrl } from '../src/connect/link/start.ts';
import { plainFileVault, type StoredTokens } from '../src/connect/link/vault.ts';
import { CONNECT_DESKTOP_CLIENT } from '../src/shared/connect.ts';
import type { ChatMessage, SessionView, WorkspaceState } from '../src/model.ts';
import { statusOf } from '../src/shared/status.ts';

interface PhoneFile {
  tokens: StoredTokens | null;
  device: { id: string; identity: Identity; subject: string } | null;
  desk: PairedDesk | null;
}

const file = plainFileVault(process.env.KESTREL_PHONE_FILE || join(dataDir(), 'connect-phone.json'));
const read = async (): Promise<PhoneFile> => {
  const raw = (await file.read()) as unknown as Partial<PhoneFile> & { paired?: unknown };
  const extra = (raw.paired ?? {}) as Partial<PhoneFile>;
  return { tokens: raw.tokens ?? null, device: extra.device ?? null, desk: extra.desk ?? null };
};
const write = (data: PhoneFile) => file.write({ tokens: data.tokens, device: null, paired: { device: data.device, desk: data.desk } });

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
    const registered = await service.registerDevice(tokens.accessToken, NAME, 'phone');
    device = { id: registered.id, identity: newIdentity(), subject: tokens.subject };
  }
  await write({ tokens, device, desk: device === data.device ? data.desk : null });
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

async function pair(code: string): Promise<void> {
  const data = await read();
  const { phone, close } = await connect(data);
  try {
    const desk = await phone.pair(code);
    await write({ ...data, desk });
    console.log(`Paired with ${desk.id}.`);
  } finally {
    close();
  }
}

/** Runs `work` over an open channel to the paired desk. */
async function withDesk(work: (phone: PhoneChannel) => Promise<void>): Promise<void> {
  const data = await read();
  if (!data.desk) fail('Pair first: connect-phone.ts pair <code>');
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
  } else if (command === 'pair') await pair(rest.join(' ') || fail('Give the code the Pair a phone page shows.'));
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
  } else fail('Commands: sign-in, pair <code>, state, cards, answer <sessionId> <requestId> <optionId>, sign-out');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
process.exit(0);
