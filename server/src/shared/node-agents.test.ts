// How a node words an agent that cannot run (node-agents.ts): one plain sentence and what to do, never the raw words.
import { describe, expect, test } from 'vitest';
import { isDataVersionFailure, nodeAgentReason, plainCause } from './node-agents.ts';

describe('one plain sentence, never the raw words (2026-11-27)', () => {
  const RAW = "OpenCode could not start: OpenCode could not list its providers: DrizzleError: Failed to run the query 'CREATE TABLE `project` ( `id` text PRIMARY KEY, `worktree` text NOT NULL )'";

  test('a database another OpenCode version made is named, with the command that offers to move it', () => {
    expect(isDataVersionFailure(RAW)).toBe(true);
    expect(isDataVersionFailure('OpenCode could not start: port in use.')).toBe(false);
    expect(nodeAgentReason('opencode', { trouble: 'data-version', database: '~/.local/share/opencode/opencode.db' }, { elsewhere: 'Worker node 1' })).toBe(
      "OpenCode's own database on Worker node 1 was made by a different OpenCode version, and this one cannot open it. Run `kestrel-node agents opencode` there: it offers to move ~/.local/share/opencode/opencode.db aside to opencode.db.old, so OpenCode starts fresh and its past conversations stay in the old file.",
    );
    expect(nodeAgentReason('opencode', { trouble: 'data-version', database: '/data/me/opencode/opencode.db' }, 'here')).toContain('Run `kestrel-node agents opencode`: it offers to move /data/me/opencode/opencode.db aside');
  });

  test('any other failure: what failed in plain words, the raw part left to the log, for every agent', () => {
    expect(plainCause('OpenCode', RAW)).toEqual({ cause: 'it could not list its providers', cut: true });
    expect(nodeAgentReason('opencode', { trouble: 'other', detail: RAW.replace('DrizzleError', 'TypeError') }, { elsewhere: 'Worker node 1' })).toBe("OpenCode cannot run on Worker node 1: it could not list its providers (the node's log has the rest). Run `kestrel-node agents` there.");
    expect(nodeAgentReason('codex', { trouble: 'other', detail: 'Codex stopped while starting (exit code 1).\n\nIts last output:\nthread main panicked' }, 'here')).toBe('Codex cannot run: it stopped while starting (exit code 1) (`kestrel-node logs` shows the rest). Run `kestrel-node agents`.');
    expect(nodeAgentReason('claude', { trouble: 'other', detail: 'SyntaxError: Unexpected token < in JSON at position 0' }, 'here')).toBe('Claude Code cannot run, and `kestrel-node logs` shows the rest. Run `kestrel-node agents`.');
    expect(nodeAgentReason('claude', { trouble: 'other', detail: 'x'.repeat(400) }, 'here')).toBe('Claude Code cannot run, and `kestrel-node logs` shows the rest. Run `kestrel-node agents`.');
    expect(nodeAgentReason('opencode', { trouble: 'out-of-usage', detail: 'Error: Free usage exceeded' }, 'here')).toBe("OpenCode's provider refused the last turn (Free usage exceeded). Run `kestrel-node agents`.");
    for (const agent of ['claude', 'codex', 'opencode'] as const) {
      const said = nodeAgentReason(agent, { trouble: 'other', detail: RAW.replace('OpenCode', agent) }, { elsewhere: 'Worker node 1' });
      expect(said).not.toMatch(/Error|CREATE|…/);
    }
  });
});
