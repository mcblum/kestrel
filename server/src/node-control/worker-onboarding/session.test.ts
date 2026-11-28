import { describe, expect, it, vi } from 'vitest';
import { answerText, confirm, promptLabel, workerPromptOf, type AskHint } from './ask.ts';
import { configureOutcomes, configureSteps } from './configure-frame.ts';
import type { WorkerAnswer, WorkerFrame, WorkerPrompt } from './model.ts';
import { WorkerSession } from './session.ts';
import type { WorkerTerminal } from './terminal.tsx';
import { statusFor } from '../../shared/node-status-fixture.ts';

/** A terminal that records what it was shown and answers each question from a list. */
function fakeTerminal(answers: WorkerAnswer[] = []) {
  const shown: WorkerFrame[] = [];
  const asked: WorkerPrompt[] = [];
  const handoffs: string[] = [];
  let finished: WorkerFrame | null = null;
  let closed = false;
  const term: WorkerTerminal = {
    show: (frame) => void shown.push(frame),
    ask: async (prompt) => (asked.push(prompt), answers.shift() ?? null),
    handoff: async (notice, run) => (handoffs.push(notice), run()),
    finish: async (frame) => void (finished = frame),
    close: async () => void (closed = true),
  };
  return { term, shown, asked, handoffs, last: () => shown.at(-1)!, finished: () => finished, closed: () => closed };
}

describe('the typed question beside a typed prompt', () => {
  it('drops the transcript-only parts of a prompt', () => {
    expect(promptLabel('Sign in and join now? [Y/n] ')).toBe('Sign in and join now?');
    expect(promptLabel('Commit name [Dana]: ')).toBe('Commit name');
    expect(promptLabel('Code from MacBook Pro: ')).toBe('Code from MacBook Pro');
  });

  it('draws a yes or no as a choice, with the default focused', () => {
    const prompt = workerPromptOf('q1', 'Run them now? [Y/n] ', confirm(true, { yes: 'Run them with sudo', no: 'Skip' }));
    expect(prompt).toMatchObject({ kind: 'select', label: 'Run them now?', initial: 'y' });
    expect(prompt.kind === 'select' && prompt.choices.map((c) => c.label)).toEqual(['Run them with sudo', 'Skip']);
    expect(answerText('y', confirm(true))).toBe('y');
  });

  it('turns a selection back into the text the flow reads, an empty one too', () => {
    const hint: AskHint = { kind: 'pick', choices: [{ answer: '1', label: 'github.com' }, { answer: '2', label: 'gitlab.com' }], answer: (c) => (c.length ? c.join(' ') : 's') };
    expect(workerPromptOf('q2', 'Choose [a]: ', hint).kind).toBe('multi');
    expect(answerText(['1', '2'], hint)).toBe('1 2');
    expect(answerText([], hint)).toBe('s');
    expect(answerText(null, hint)).toBeNull();
  });

  it('asks for text when the flow gave no hint', () => {
    expect(workerPromptOf('q3', 'Code from MacBook Pro: ')).toEqual({ id: 'q3', kind: 'input', label: 'Code from MacBook Pro' });
  });
});

describe('a flow drawn on the screen', () => {
  it('makes each heading an operation of its own and keeps the command title out', () => {
    const t = fakeTerminal();
    const session = new WorkerSession({ name: 'Set up Git', node: 'Worker node 1', sections: ['Key', 'Hosts'] });
    session.attach(t.term);
    const io = session.io();
    io.say({ event: 'say', step: 0, kind: 'heading', text: 'Kestrel worker node: git on Worker node 1' });
    io.say({ event: 'say', step: 1, kind: 'heading', text: "This node's key" });
    io.say({ event: 'say', step: 1, kind: 'done', text: 'Key: SHA256:abc' });
    io.say({ event: 'say', step: 1, kind: 'code', code: 'ssh-ed25519 AAAA kestrel-node' });
    expect(t.last()).toMatchObject({ title: "This node's key", steps: [{ label: 'Key', state: 'active' }, { label: 'Hosts', state: 'pending' }] });
    expect(t.last().details).toEqual([{ kind: 'outcome', label: 'Key: SHA256:abc', state: 'ready' }, { kind: 'literal', value: 'ssh-ed25519 AAAA kestrel-node' }]);
    io.say({ event: 'say', step: 2, kind: 'heading', text: 'Where your repositories are' });
    expect(t.last()).toMatchObject({ title: 'Where your repositories are', details: [], steps: [{ state: 'ready' }, { state: 'active' }] });
  });

  it('shows a wait as the status until the next line, and a problem marks its section left', () => {
    const t = fakeTerminal();
    const session = new WorkerSession({ name: 'Set up agents', node: 'n', sections: 'seen' });
    session.attach(t.term);
    const io = session.io();
    io.say({ event: 'say', step: 1, kind: 'heading', text: 'Codex' });
    io.say({ event: 'say', step: 1, kind: 'wait', text: 'Installing Codex…' });
    expect(t.last().status).toBe('Installing Codex');
    io.say({ event: 'say', step: 1, kind: 'problem', text: 'npm could not install Codex.' });
    expect(t.last().status).toBeUndefined();
    io.say({ event: 'say', step: 2, kind: 'heading', text: 'OpenCode' });
    expect(t.last().steps).toEqual([{ label: 'Codex', state: 'left' }, { label: 'OpenCode', state: 'active' }]);
  });

  it('draws a command inside a configure section under it, its end as a line there', () => {
    const t = fakeTerminal();
    const session = new WorkerSession({ name: 'Worker setup', node: 'n', steps: () => undefined });
    session.attach(t.term);
    const nested = session.io(3);
    nested.say({ event: 'say', step: 0, kind: 'heading', text: 'Kestrel worker node: agents on n' });
    nested.say({ event: 'say', step: 1, kind: 'heading', text: 'Claude Code' });
    nested.say({ event: 'end', ok: true, text: 'Agents on n: 1 of 3 can run.', next: 'kestrel node status' });
    expect(t.last()).toMatchObject({ title: 'Claude Code', details: [{ kind: 'outcome', label: 'Agents on n: 1 of 3 can run.', state: 'ready' }] });
    expect(session.ended).toBeNull();
  });

  it('puts an approval first, with what it does, where and the exact commands', async () => {
    const t = fakeTerminal(['y']);
    const session = new WorkerSession({ name: 'Worker setup', node: 'n' });
    session.attach(t.term);
    const io = session.io();
    io.say({ event: 'say', step: 1, kind: 'line', text: 'Kestrel can run these now:' });
    const trust = { label: 'Administrator changes', action: 'Install bubblewrap and socat.', destination: 'This computer, as root through sudo.', reason: 'Commands run unconfined without them.', commands: ['sudo apt-get install -y bubblewrap socat'] };
    const answer = await io.ask(1, 'Run them now? [Y/n] ', confirm(true, { trust }));
    expect(answer).toBe('y');
    expect(t.shown.at(-2)!.details![0]).toEqual({ kind: 'trust', ...trust });
    expect(t.asked[0]).toMatchObject({ kind: 'select', initial: 'y' });
    // Once answered, the approval is gone from the frame.
    expect(t.last().details).toEqual([{ kind: 'text', text: 'Kestrel can run these now:' }]);
  });

  it('gives each question a new id, so a retry starts fresh', async () => {
    const t = fakeTerminal(['1', '2']);
    const session = new WorkerSession({ name: 'n', node: 'n' });
    session.attach(t.term);
    await session.ask('Code: ');
    await session.ask('Code: ');
    expect(t.asked.map((p) => p.id)).toEqual(['q1', 'q2']);
  });

  it('hands the terminal to a program and closes with the outcome and the next command', async () => {
    const t = fakeTerminal();
    const session = new WorkerSession({ name: 'Pair this worker', node: 'n' });
    session.attach(t.term);
    expect(await session.handoff('sudo has this terminal now.', async () => 7)).toBe(7);
    expect(t.handoffs).toEqual(['sudo has this terminal now.']);
    session.io().say({ event: 'end', ok: true, text: 'n is in your account.', next: 'kestrel node status' });
    await session.finish();
    expect(t.finished()).toMatchObject({ title: 'n is in your account.', details: [{ kind: 'field', label: 'Next', value: 'kestrel node status' }] });
  });

  it('on Ctrl+C withdraws a join when one is under way, and otherwise stops the command', () => {
    const interrupt = vi.fn();
    const session = new WorkerSession({ name: 'n', node: 'n' }, interrupt);
    session.attach(fakeTerminal().term);
    const withdraw = vi.fn();
    const off = session.onStop(withdraw);
    session.cancel();
    expect(withdraw).toHaveBeenCalledOnce();
    expect(interrupt).not.toHaveBeenCalled();
    off();
    session.cancel();
    // No question waited: a program may be running, so the process group gets the signal too.
    expect(interrupt).toHaveBeenCalledWith(true);
  });
});

describe("configure's progress and closing outcomes", () => {
  const sandbox = { missing: [], install: null };

  it('are the node status, section by section', () => {
    const status = statusFor({ inAccount: true, canRun: [], lingering: 'on', sandbox: true });
    expect(configureSteps(status, sandbox, 3, false).map((s) => `${s.label} ${s.state}`)).toEqual(['System ready', 'Account ready', 'Agents active', 'Git ready']);
    expect(configureSteps(status, sandbox, null, true).map((s) => s.state)).toEqual(['ready', 'ready', 'left', 'ready']);
  });

  it('name one command for each step that is left', () => {
    const status = statusFor({ inAccount: false, canRun: ['claude'], lingering: 'on', sandbox: true });
    const left = configureOutcomes(status, sandbox, 'sudo').filter((d) => d.kind === 'outcome' && d.state === 'left');
    expect(left).toContainEqual(expect.objectContaining({ label: expect.any(String), command: 'kestrel node join' }));
    expect(left.every((d) => d.kind === 'outcome' && Boolean(d.command))).toBe(true);
  });
});
