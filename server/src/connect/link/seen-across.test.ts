// What was seen, between two real desks of one account (seen-sync.ts through the Connect module, the fake
// service and its relay): a session read on the Mac mini is read in the laptop's window, and arrives so, before
// its head is listed; one the laptop's window marks read is read on the Mac mini without asking it; and marking
// unread travels too.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../../project-store.ts';
import { sessionDot } from '../../shared/unread.ts';
import { until } from '../../test-agent.ts';
import { account, closeDesks, laptopWindow } from './two-desks.ts';

afterEach(closeDesks);

describe('what was seen, on two desks of one account', () => {
  it('a session read on the Mac mini arrives on the laptop already read, its mark applied before its head', async () => {
    const a = await account();
    const { laptop, mini } = a;
    mini.fake.script = (turn) => turn.emit({ type: 'message', id: `a${turn.n}`, text: 'done', delta: 'done', done: true });
    const project = await createProject(mini.workspace, { name: 'Shop' });
    const session = await mini.runtime.start({ agent: 'claude', projectId: project.id, prompt: 'go' });
    await mini.settle();
    await mini.workspace.seen.mark([session.id]);
    await mini.desk.held!.run();
    await mini.desk.seen!.run();

    const seenFirst = vi.spyOn(laptop.workspace.seen, 'takeAccount');
    const headsAfter = vi.spyOn(laptop.workspace.account, 'apply');
    await laptop.desk.replica!.run();

    const view = await laptop.workspace.view();
    const remote = view.sessions.find((s) => s.id === session.id)!;
    expect(remote.runsOn).toBe(mini.id());
    expect(sessionDot(remote, await laptop.workspace.seen.view())).toBe('none');
    expect(seenFirst.mock.invocationCallOrder[0]!).toBeLessThan(headsAfter.mock.invocationCallOrder[0]!);
  });

  it('the laptop’s window marks a Mac mini session read or unread, and the Mac mini follows, without being asked', async () => {
    const a = await account();
    const { laptop, mini } = a;
    mini.fake.script = (turn) => turn.emit({ type: 'message', id: `a${turn.n}`, text: 'done', delta: 'done', done: true });
    const project = await createProject(mini.workspace, { name: 'Shop' });
    const session = await mini.runtime.start({ agent: 'claude', projectId: project.id, prompt: 'go' });
    await mini.settle();
    await mini.desk.held!.run();
    await laptop.desk.replica!.run();
    await until(async () => (await laptop.workspace.view()).sessions.some((s) => s.id === session.id), 'the laptop lists it');
    const there = async () => sessionDot((await mini.workspace.state()).sessions.find((s) => s.id === session.id)!, await mini.workspace.seen.view());
    expect(await there()).toBe('unread');

    const w = await laptopWindow(laptop);
    const asked = vi.spyOn(laptop.desk.remote, 'ask');
    expect((await w.post('/api/seen', { sessionIds: [session.id] })).status).toBe(200);
    await laptop.desk.seen!.run();
    await mini.desk.seen!.run();
    expect(await there()).toBe('none');
    expect(asked).not.toHaveBeenCalled();

    await w.post('/api/seen', { sessionIds: [session.id], unread: true });
    await laptop.desk.seen!.run();
    await mini.desk.seen!.run();
    expect(await there()).toBe('unread');
  });
});
