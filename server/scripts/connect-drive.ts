// Drives Kestrel Connect's dispatcher end to end with no service, no account and no phone: a pretend
// phone sends request frames, the real runtime carries them out on the scripted agent (one per
// provider), and every frame back is printed. Phase 1 of docs/designs/kestrel-connect.md.
//   pnpm --filter @kestrel/server exec tsx scripts/connect-drive.ts
// Uses an in-memory workspace and a throwaway data folder. Not part of the app.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptedAdapter } from '../src/agents/scripted.ts';
import { ConnectDispatcher } from '../src/connect/dispatcher.ts';
import { SELECTABLE_AGENTS } from '../src/model.ts';
import { memoryPersistence } from '../src/persistence/memory.ts';
import { createProject } from '../src/project-store.ts';
import { SessionRuntime } from '../src/runtime.ts';
import { CONNECT_PROTOCOL_VERSION } from '../src/shared/connect-ops.ts';
import { Workspace } from '../src/workspace.ts';

const MAC = 'this-computer';
const PHONE = 'pretend-phone';
const short = (value: unknown) => {
  const text = JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 300)}… (${text.length} characters)` : text;
};

const workspace = new Workspace(memoryPersistence());
const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-connect-drive-')));
const runtime = new SessionRuntime(workspace, Object.fromEntries(SELECTABLE_AGENTS.map((agent) => [agent, { ...scriptedAdapter(), agent }])), data);
const project = await createProject(workspace, { name: 'Demo' });
const dispatcher = new ConnectDispatcher({
  workspace,
  runtime,
  deviceId: MAC,
  here: 'this computer',
  send: (frame) => frame.kind === 'push' && console.log(`  ← push   ${short(frame.body)}`),
});

let n = 0;
async function ask(op: string, args: Record<string, unknown> = {}): Promise<any> {
  console.log(`→ ${op} ${short(args)}`);
  const answer = await dispatcher.receive({ v: CONNECT_PROTOCOL_VERSION, from: PHONE, to: MAC, kind: 'request', id: `q${++n}`, body: { op, args } });
  console.log(`  ← ${answer?.body.ok ? 'ok    ' : 'refused'} ${short(answer?.body.ok ? answer.body.result : answer?.body.reason)}`);
  return answer?.body.ok ? answer.body.result : null;
}
const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
  }
  dispatcher.flush();
};

for (const agent of SELECTABLE_AGENTS) {
  console.log(`\n=== a ${agent} session ===`);
  // Started at the desk: a phone does not start sessions (Matt, 2026-11-22).
  const { id } = await runtime.start({ agent, projectId: project.id, prompt: 'hello from the desk' });
  console.log(`(started at the desk: ${id})`);
  await ask('session.watch', { sessionId: id });
  await settle();
  const end = await ask('session.read', { sessionId: id, last: 2 });
  if (end?.before) await ask('session.read', { sessionId: id, before: end.before, limit: 2 });
  await ask('session.reply', { sessionId: id, text: 'and once more' });
  await settle();
  await workspace.seen.markUnread(id);
  await ask('session.seen', { sessionId: id });
  console.log(`  seen everywhere: ${(await workspace.seen.view())[id]! > 0}`);
  await ask('session.stop', { sessionId: id });
}

console.log('\n=== what a phone never does ===');
await ask('terminal.open', {});
await ask('sandbox-allow.add', { command: 'rm' });
await ask('session.start', { projectId: project.id, prompt: 'go' });
await ask('session.rename', { sessionId: 'any', title: 'x' });
console.log('\n=== frames it cannot take ===');
console.log(short((await dispatcher.receive({ v: CONNECT_PROTOCOL_VERSION + 1, from: PHONE, to: MAC, kind: 'request', id: 'x1', body: { op: 'state.read' } }))?.body));
console.log(short((await dispatcher.receive({ v: CONNECT_PROTOCOL_VERSION, from: PHONE, to: 'another-computer', kind: 'request', id: 'x2', body: { op: 'state.read' } }))?.body));
const state = await workspace.state();
console.log(`\n${state.sessions.length} sessions in the workspace.`);
dispatcher.close();
process.exit(0);
