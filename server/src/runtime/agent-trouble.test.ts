import { describe, expect, test } from 'vitest';
import { NOT_INSTALLED as CODEX_NOT_INSTALLED, NOT_SIGNED_IN as CODEX_NOT_SIGNED_IN } from '../agents/codex/process.ts';
import { CLAUDE_NOT_FOUND } from '../agents/claude/failure.ts';
import { NOT_INSTALLED as OPENCODE_NOT_INSTALLED, NOT_SIGNED_IN as OPENCODE_NOT_SIGNED_IN } from '../agents/opencode/process.ts';
import type { AvailabilityAnswer } from '../agents/types.ts';
import type { Agent } from '../model.ts';
import { agentStatesOf } from '../shared/node-status.ts';
import { whyHere } from '../shared/node-commands.ts';
import { remoteStartChoices } from '../remote-starts/session-start.ts';
import { AgentTroubles, availabilityHere, failedHere, lastingTrouble } from './agent-trouble.ts';

const NODE = { kind: 'node' as const, name: 'Worker node 1' };
const APP = { kind: 'app' as const, name: 'Mac mini' };

/** What each adapter answers today when its program is missing or it is signed out (agents/*). */
const DESK_ANSWERS: Record<Agent, { missing: AvailabilityAnswer; auth: AvailabilityAnswer }> = {
  claude: { missing: { available: false, reason: `${CLAUDE_NOT_FOUND} (/gone/claude)`, problem: 'missing' }, auth: { available: false, reason: 'Claude is not signed in: choose Sign in, or run `claude` in a terminal and sign in with /login.', signIn: true, problem: 'auth' } },
  codex: { missing: { available: false, reason: CODEX_NOT_INSTALLED, problem: 'missing' }, auth: { available: false, reason: CODEX_NOT_SIGNED_IN, signIn: true, problem: 'auth' } },
  opencode: { missing: { available: false, reason: OPENCODE_NOT_INSTALLED, problem: 'missing' }, auth: { available: false, reason: OPENCODE_NOT_SIGNED_IN, problem: 'auth' } },
};

const LABEL: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

describe('what a node says about an agent that cannot run', () => {
  test.each(['claude', 'codex', 'opencode'] as const)('%s: not installed and not signed in, in the node’s words, naming it and the command', (agent) => {
    expect(availabilityHere(agent, DESK_ANSWERS[agent].missing, null, NODE)).toEqual({ available: false, reason: `${LABEL[agent]} is not installed on Worker node 1. Run \`kestrel node agents\` there.`, problem: 'missing', nodeProblem: { trouble: 'missing' } });
    expect(availabilityHere(agent, DESK_ANSWERS[agent].auth, null, NODE)).toEqual({ available: false, reason: `${LABEL[agent]} is not signed in on Worker node 1. Run \`kestrel node agents\` there.`, problem: 'auth', nodeProblem: { trouble: 'signed-out' } });
  });

  test.each(['claude', 'codex', 'opencode'] as const)('%s: the desktop app’s own words are unchanged', (agent) => {
    expect(availabilityHere(agent, DESK_ANSWERS[agent].missing, null, APP)).toBe(DESK_ANSWERS[agent].missing);
    expect(availabilityHere(agent, DESK_ANSWERS[agent].auth, { trouble: 'out-of-usage', detail: 'x' }, APP)).toBe(DESK_ANSWERS[agent].auth);
    expect(availabilityHere(agent, { available: true }, { trouble: 'signed-out', detail: 'x' }, APP)).toEqual({ available: true });
  });

  test('no desktop advice reaches a node: no Sign in button, no Homebrew, no global npm', () => {
    for (const agent of ['claude', 'codex', 'opencode'] as const) {
      for (const answer of Object.values(DESK_ANSWERS[agent])) {
        const said = availabilityHere(agent, answer, null, NODE);
        expect(said.reason).not.toMatch(/choose Sign in|brew|npm install -g|\/login/);
        expect(said.signIn).toBeUndefined();
      }
    }
  });

  test('any other reason keeps the agent’s words and says where and what to run', () => {
    expect(availabilityHere('opencode', { available: false, reason: 'OpenCode could not start: port in use.' }, null, NODE)).toEqual({ available: false, reason: 'OpenCode cannot run on Worker node 1: it could not start: port in use. Run `kestrel node agents` there.', nodeProblem: { trouble: 'other', detail: 'OpenCode could not start: port in use.' } });
  });

  test('a lasting refusal from the last turn counts against an agent that says it can start, until it is forgotten', () => {
    const troubles = new AgentTroubles();
    expect(troubles.failed('opencode', { kind: 'other', reason: 'Free usage exceeded' })).toBe(true);
    expect(availabilityHere('opencode', { available: true }, troubles.of('opencode'), NODE)).toEqual({ available: false, reason: "OpenCode's provider refused the last turn on Worker node 1 (Free usage exceeded). Run `kestrel node agents` there.", nodeProblem: { trouble: 'out-of-usage', detail: 'Free usage exceeded' } });
    expect(troubles.failed('opencode', { kind: 'other', reason: 'Free usage exceeded' })).toBe(false);
    expect(troubles.forget('opencode')).toBe(true);
    expect(availabilityHere('opencode', { available: true }, troubles.of('opencode'), NODE)).toEqual({ available: true });
  });

  test('a failure that passes is not remembered', () => {
    const troubles = new AgentTroubles();
    for (const reason of ['Rate limit reached, try again in 20s', 'fetch failed: ECONNRESET', 'The user stopped it']) expect(troubles.failed('codex', { kind: 'other', reason })).toBe(false);
    expect(troubles.of('codex')).toBeNull();
  });
});

describe('lastingTrouble', () => {
  test('a sign-in failure, a missing program and a spent usage last; anything else passes', () => {
    expect(lastingTrouble({ kind: 'auth', reason: 'OAuth token has expired' })).toBe('signed-out');
    expect(lastingTrouble({ kind: 'other', reason: `The agent could not be started: ${CODEX_NOT_INSTALLED}` })).toBe('missing');
    expect(lastingTrouble({ kind: 'other', reason: `${CLAUDE_NOT_FOUND} (spawn ENOENT)` })).toBe('missing');
    for (const reason of ['Free usage exceeded', 'You exceeded your current quota (insufficient_quota)', 'Your credit balance is too low', "You've hit your usage limit"]) expect(lastingTrouble({ kind: 'other', reason })).toBe('out-of-usage');
    expect(lastingTrouble({ kind: 'other', reason: '429 rate limited' })).toBeNull();
  });
});

describe('a turn that ends on a lasting reason, as the session shows it', () => {
  test.each(['claude', 'codex', 'opencode'] as const)('%s: on a node the session says it in the node’s words; in the app as before', (agent) => {
    const event = { type: 'failed' as const, kind: 'auth' as const, reason: 'Not logged in. Claude is not signed in: choose Sign in.' };
    expect(failedHere(agent, event, NODE)).toEqual({ ...event, reason: `${LABEL[agent]} is not signed in on Worker node 1. Run \`kestrel node agents\` there.` });
    expect(failedHere(agent, event, APP)).toBe(event);
    const passing = { type: 'failed' as const, kind: 'other' as const, reason: 'socket hang up' };
    expect(failedHere(agent, passing, NODE)).toBe(passing);
  });
});

describe('what other devices read about a node’s agents', () => {
  test('the offers record’s missing reasons and the status name the node and the command to run there', () => {
    const codex = availabilityHere('codex', DESK_ANSWERS.codex.missing, null, NODE);
    const opencode = availabilityHere('opencode', DESK_ANSWERS.opencode.auth, null, NODE);
    const availability = { available: ['claude'] as Agent[], notes: { codex: codex.reason!, opencode: opencode.reason! }, problems: { codex: codex.nodeProblem!, opencode: opencode.nodeProblem! } };
    const agents = (['claude', 'codex', 'opencode'] as const).map((agent) => ({ agent, available: availability.available.includes(agent), models: [], ...(availability.notes[agent as 'codex'] ? { reason: availability.notes[agent as 'codex'] } : {}) }));
    const offers = remoteStartChoices('Worker node 1', true, '', [], null, agents);
    expect(offers.missing).toEqual([
      { agent: 'codex', name: 'Codex', reason: 'Codex is not installed on Worker node 1. Run `kestrel node agents` there.' },
      { agent: 'opencode', name: 'OpenCode', reason: 'OpenCode is not signed in on Worker node 1. Run `kestrel node agents` there.' },
    ]);
    expect(agentStatesOf(['claude', 'codex', 'opencode'], availability)).toEqual([
      { agent: 'claude', canRun: true, why: null, problem: null },
      { agent: 'codex', canRun: false, why: 'Codex is not installed on Worker node 1. Run `kestrel node agents` there.', problem: { trouble: 'missing' } },
      { agent: 'opencode', canRun: false, why: 'OpenCode is not signed in on Worker node 1. Run `kestrel node agents` there.', problem: { trouble: 'signed-out' } },
    ]);
    // The node's own terminal reads the same values without where it is.
    expect(agentStatesOf(['claude', 'codex', 'opencode'], availability).map((s) => (s.canRun ? 'can run' : whyHere(s)))).toEqual(['can run', 'Codex is not installed. Run `kestrel node agents`.', 'OpenCode is not signed in. Run `kestrel node agents`.']);
  });
});
