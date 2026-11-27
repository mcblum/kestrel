// Workstreams and session trees between two real desks of one account (issue 83): a workstream the Mac mini made by
// delegating is drawn in the laptop's window as it is there (its lead, the sessions under it, its name and objective,
// the computer that holds it), a rename there arrives here, and a project kept off Kestrel Connect is never named.
import { afterEach, describe, expect, it } from 'vitest';
import { createProject } from '../../project-store.ts';
import { workstreamRows } from '../../shared/workstreams.ts';
import { remoteWorkstreamRefusal } from '../../shared/account-workstreams.ts';
import { account, closeDesks } from './two-desks.ts';

afterEach(closeDesks);

/** The Mac mini delegates from a lead in Shop to Billing and Secret: a workstream across three projects. */
async function delegated() {
  const a = await account();
  const { mini } = a;
  mini.fake.script = (turn) => turn.emit({ type: 'message', id: `a${turn.n}`, text: 'done', delta: 'done', done: true });
  const shop = await createProject(mini.workspace, { name: 'Shop' });
  const billing = await createProject(mini.workspace, { name: 'Billing' });
  const secret = await createProject(mini.workspace, { name: 'Secret' });
  const lead = await mini.runtime.start({ agent: 'claude', projectId: shop.id, prompt: 'split the work' });
  await mini.settle();
  const made = await mini.workspace.delegate(lead.id, [{ projectId: billing.id, brief: 'Add the endpoint', title: 'Billing endpoint' }, { projectId: secret.id, brief: 'Touch the secret', title: 'Secret part' }], { name: 'Invoice export', objective: 'Export invoices' });
  return { ...a, lead, workstream: made.workstream!, children: made.children, secret };
}

describe('a workstream on another computer of the account', () => {
  it('is drawn on the laptop as the Mac mini holds it: its lead, the sessions under it, its name and where it is', async () => {
    const { laptop, mini, lead, workstream, children } = await delegated();
    await mini.desk.held!.run();
    await laptop.desk.replica!.run();

    const view = await laptop.workspace.view();
    const shown = view.workstreams.find((w) => w.id === workstream.id)!;
    expect(shown).toMatchObject({ name: 'Invoice export', objective: 'Export invoices', heldOn: { id: mini.id(), name: 'Mac mini' } });
    expect(shown.sessionIds[0]).toBe(lead.id);
    expect(new Set(shown.sessionIds)).toEqual(new Set([lead.id, ...children.map((c) => c.id)]));
    // The tree under the lead, from the links the heads carry.
    const rows = workstreamRows(shown, view.links, view.sessions);
    expect(rows[0]).toMatchObject({ session: { id: lead.id }, depth: 0 });
    expect(rows.slice(1).map((r) => r.depth)).toEqual([1, 1]);
    // Changed only on the Mac mini, and the laptop says so.
    expect(remoteWorkstreamRefusal(shown)).toBe('“Invoice export” is on Mac mini, so it can only be changed there.');
    // The laptop's own state (what runs, files and counts) holds none of it.
    expect((await laptop.workspace.state()).workstreams).toEqual([]);
  });

  it('a rename on the Mac mini arrives on the laptop', async () => {
    const { laptop, mini, workstream } = await delegated();
    await mini.desk.held!.run();
    await laptop.desk.replica!.run();
    await mini.workspace.renameWorkstream(workstream.id, 'Exports');
    await mini.desk.held!.run();
    await laptop.desk.replica!.run();
    expect((await laptop.workspace.view()).workstreams.find((w) => w.id === workstream.id)?.name).toBe('Exports');
  });

  it('a session of a project kept off Kestrel Connect is not referenced: not in the workstream, not as a parent', async () => {
    const { laptop, mini, workstream, children, secret } = await delegated();
    await mini.desk.setHeld({ keptOff: [secret.id] });
    await mini.desk.held!.run();
    await laptop.desk.replica!.run();
    const view = await laptop.workspace.view();
    const hidden = children.find((c) => c.title === 'Secret part')!;
    expect(view.workstreams.find((w) => w.id === workstream.id)!.sessionIds).not.toContain(hidden.id);
    expect(view.links.some((l) => l.childId === hidden.id || l.parentId === hidden.id)).toBe(false);
    expect(view.sessions.some((s) => s.id === hidden.id)).toBe(false);
  });
});
