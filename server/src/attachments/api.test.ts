// The attachment routes over real HTTP: upload checks at the boundary, serving back with the token
// in a header, and a new session started with a draft's files.
import { mkdtempSync, realpathSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createKestrelServer, type KestrelServer } from '../http.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import { SessionRuntime } from '../runtime.ts';
import { ATTACHMENT_MAX_FILE_BYTES } from '../shared/attachments.ts';
import { FakeAgents } from '../test-agent.ts';
import { Workspace } from '../workspace.ts';

const TOKEN = 'test-token';
const ORIGIN = 'http://localhost:5173';
const auth = { Authorization: `Bearer ${TOKEN}` };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
let app: KestrelServer;
let base: string;
let runtime: SessionRuntime;
let agents: FakeAgents;

beforeEach(async () => {
  const workspace = new Workspace(memoryPersistence());
  agents = new FakeAgents();
  runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-att-api-'))));
  const policy = { token: TOKEN, allowedOrigins: [ORIGIN], port: 0 };
  app = createKestrelServer(workspace, policy, runtime);
  await app.listen();
  policy.port = (app.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${policy.port}`;
});
afterEach(() => app.close());

const upload = (draftId: string, name: string | null, body: Buffer, type = 'application/octet-stream') =>
  fetch(`${base}/api/attachments/drafts/${draftId}${name === null ? '' : `?name=${encodeURIComponent(name)}`}`, { method: 'POST', headers: { ...auth, 'Content-Type': type }, body: new Uint8Array(body) });

describe('uploading', () => {
  test('stores a file in the draft and says what it is', async () => {
    const res = await upload('draft-1', 'shot.png', PNG, 'image/png');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: 'shot.png', mediaType: 'image/png', size: PNG.length, kind: 'image' });
  });
  test('refuses an empty file, a missing name, a bad draft id, and a file over the limit with a clear message', async () => {
    expect((await upload('draft-1', 'a.txt', Buffer.alloc(0))).status).toBe(409);
    expect((await upload('draft-1', null, Buffer.from('a'))).status).toBe(400);
    expect((await upload('..%2F..', 'a.txt', Buffer.from('a'))).status).toBe(400);
    const big = await upload('draft-1', 'big.bin', Buffer.alloc(ATTACHMENT_MAX_FILE_BYTES + 1));
    expect(big.status).toBe(413);
    expect((await big.json()).error).toMatch(/larger than 20 MB/);
  });
  test('needs the launch token', async () => {
    expect((await fetch(`${base}/api/attachments/drafts/d1?name=a.txt`, { method: 'POST', body: 'x' })).status).toBe(401);
  });
  test('keeps the original path given with the upload', async () => {
    const res = await fetch(`${base}/api/attachments/drafts/d1?name=a.txt&path=${encodeURIComponent('/Users/me/a.txt')}`, { method: 'POST', headers: { ...auth, Origin: ORIGIN }, body: 'a' });
    expect((await res.json()).path).toBe('/Users/me/a.txt');
  });
});

describe('sending and serving', () => {
  test('starts a session with a draft’s files and serves them back; a non-picture as plain bytes', async () => {
    const png = await (await upload('draft-2', 'shot.png', PNG, 'image/png')).json();
    const txt = await (await upload('draft-2', 'page.html', Buffer.from('<script>x</script>'), 'text/html')).json();
    const res = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'claude', projectId: null, prompt: '', draftId: 'draft-2', attachments: [png.id, txt.id] }) });
    expect(res.status).toBe(201);
    const session = await res.json();
    await agents.settled();
    const image = await fetch(`${base}/api/sessions/${session.id}/attachments/${png.id}`, { headers: auth });
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
    const page = await fetch(`${base}/api/sessions/${session.id}/attachments/${txt.id}`, { headers: auth });
    expect(page.headers.get('content-type')).toBe('application/octet-stream');
    expect((await fetch(`${base}/api/sessions/${session.id}/attachments/${png.id}`)).status).toBe(401);
  });
  test('refuses a reply with an attachment list that is not ids', async () => {
    const res = await fetch(`${base}/api/sessions/x/reply`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi', draftId: 'd', attachments: ['../etc'] }) });
    expect(res.status).toBe(409);
  });
});
