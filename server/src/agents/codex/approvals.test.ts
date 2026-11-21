// What Kestrel does with each request Codex sends, per permission level.
import { describe, expect, it } from 'vitest';
import type { PermissionLevel } from '../../shared/permissions.ts';
import { handleRequest, inside, type ApprovalContext, type Handling } from './approvals.ts';
import type { FileChange } from './map.ts';
import { codexPolicy } from './policy.ts';

const DIR = '/scratch/work';
const ctx = (level: PermissionLevel, changes: FileChange[] = []): ApprovalContext => ({ policy: codexPolicy(level), directory: DIR, changes: () => changes });
const COMMAND = { itemId: 'e1', command: "/bin/zsh -lc 'touch x'", commandActions: [{ type: 'unknown', command: 'touch x' }] };
const IN_FOLDER: FileChange[] = [{ path: `${DIR}/a.txt`, kind: 'add', diff: 'x\n' }];
const OUTSIDE: FileChange[] = [{ path: '/scratch/outside/b.txt', kind: 'add', diff: 'y\n' }];
const kestrelCall = (tool: string) => ({ serverName: 'kestrel', mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: tool, tool_params: {} }, message: 'Allow?' });

const card = (h: Handling) => {
  if (h.kind !== 'card') throw new Error(`expected a card, got ${JSON.stringify(h)}`);
  return h;
};

describe('command approvals', () => {
  it('Manual asks; Allow accepts, Deny declines and passes the note on', () => {
    const h = card(handleRequest('item/commandExecution/requestApproval', COMMAND, 'c1', ctx('ask')));
    expect(h.request).toMatchObject({ id: 'c1', kind: 'approval', tool: 'Bash', detail: 'touch x' });
    expect(h.reply({ optionId: 'allow' })).toEqual({ result: { decision: 'accept' } });
    expect(h.reply({ optionId: 'deny', text: ' use pnpm ' })).toEqual({ result: { decision: 'decline' }, steer: 'The user declined that action: use pnpm' });
    expect(h.reply({ optionId: 'deny' })).toEqual({ result: { decision: 'decline' } });
    expect(h.cancel).toEqual({ decision: 'decline' });
  });

  it('Bypass never shows a card; Auto asks for a command Codex asks about (one leaving the sandbox); Plan and Read only refuse', () => {
    expect(handleRequest('item/commandExecution/requestApproval', COMMAND, 'c', ctx('bypass'))).toEqual({ kind: 'answer', result: { decision: 'accept' } });
    expect(card(handleRequest('item/commandExecution/requestApproval', COMMAND, 'c', ctx('auto'))).request).toMatchObject({ tool: 'Bash', detail: 'touch x' });
    for (const level of ['plan', 'readonly'] as const) expect(handleRequest('item/commandExecution/requestApproval', COMMAND, 'c', ctx(level))).toEqual({ kind: 'answer', result: { decision: 'decline' } });
  });
});

describe('file change approvals', () => {
  const ask = (level: PermissionLevel, changes: FileChange[]) => handleRequest('item/fileChange/requestApproval', { itemId: 'f1' }, 'c', ctx(level, changes));

  it('Manual asks for a change inside the folder and outside it, showing the diff', () => {
    expect(card(ask('ask', IN_FOLDER)).request).toMatchObject({ tool: 'Write', title: 'Write a.txt', detail: 'x\n' });
    expect(card(ask('ask', OUTSIDE)).request.title).toBe('Write /scratch/outside/b.txt');
  });

  it('Accept edits takes a change inside the folder without asking, and still asks for one outside it', () => {
    expect(ask('edits', IN_FOLDER)).toEqual({ kind: 'answer', result: { decision: 'accept' } });
    expect(ask('edits', OUTSIDE).kind).toBe('card');
    expect(ask('edits', [...IN_FOLDER, ...OUTSIDE]).kind).toBe('card');
  });

  it('Auto and Bypass let a change through anywhere (the edit rule ran first, in handle.ts); Read only refuses', () => {
    expect(ask('auto', OUTSIDE)).toEqual({ kind: 'answer', result: { decision: 'accept' } });
    expect(ask('bypass', OUTSIDE)).toEqual({ kind: 'answer', result: { decision: 'accept' } });
    expect(ask('bypass', IN_FOLDER)).toEqual({ kind: 'answer', result: { decision: 'accept' } });
    expect(ask('readonly', IN_FOLDER)).toEqual({ kind: 'answer', result: { decision: 'decline' } });
  });

  it('a change Codex did not describe still asks, and says it does not know the files', () => {
    expect(card(ask('ask', [])).request).toMatchObject({ title: 'Change files', detail: 'Codex did not say which files.' });
  });
});

describe("Kestrel's own tools", () => {
  const accept = { action: 'accept', content: {}, _meta: null };
  const decline = { action: 'decline', content: null, _meta: null };

  it('run without asking at every level', () => {
    for (const level of ['ask', 'edits', 'auto', 'bypass', 'plan', 'readonly'] as const) expect(handleRequest('mcpServer/elicitation/request', kestrelCall('list_projects'), 'c', ctx(level))).toEqual({ kind: 'answer', result: accept });
  });

  it('ones that act (browser clicks) ask in Manual, run in Auto, are refused in Read only', () => {
    expect(card(handleRequest('mcpServer/elicitation/request', kestrelCall('browser_click'), 'c', ctx('ask'))).request.tool).toBe('mcp__kestrel__browser_click');
    expect(handleRequest('mcpServer/elicitation/request', kestrelCall('browser_click'), 'c', ctx('auto'))).toEqual({ kind: 'answer', result: accept });
    expect(handleRequest('mcpServer/elicitation/request', kestrelCall('browser_click'), 'c', ctx('readonly'))).toEqual({ kind: 'answer', result: decline });
  });

  it("another server's tool follows the level", () => {
    const other = { ...kestrelCall('search'), serverName: 'docs' };
    expect(card(handleRequest('mcpServer/elicitation/request', other, 'c', ctx('ask'))).request.tool).toBe('mcp__docs__search');
    expect(handleRequest('mcpServer/elicitation/request', other, 'c', ctx('bypass'))).toEqual({ kind: 'answer', result: accept });
    expect(handleRequest('mcpServer/elicitation/request', other, 'c', ctx('auto'))).toEqual({ kind: 'answer', result: accept });
    expect(handleRequest('mcpServer/elicitation/request', other, 'c', ctx('readonly'))).toEqual({ kind: 'answer', result: decline });
  });

  it('a form with fields is declined (not supported yet); a plain yes/no is a card', () => {
    const form = { serverName: 'docs', mode: 'form', message: 'Name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } };
    expect(handleRequest('mcpServer/elicitation/request', form, 'c', ctx('ask'))).toEqual({ kind: 'answer', result: decline });
    const yesNo = { serverName: 'docs', mode: 'form', message: 'Go on?', requestedSchema: { type: 'object', properties: {} } };
    const h = card(handleRequest('mcpServer/elicitation/request', yesNo, 'c', ctx('ask')));
    expect(h.reply({ optionId: 'allow' })).toEqual({ result: accept });
  });
});

describe('other requests', () => {
  it('a question from Codex becomes a question card and the pick goes back by question id', () => {
    const params = { questions: [{ id: 'q1', header: 'Pick', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] };
    const h = card(handleRequest('item/tool/requestUserInput', params, 'c', ctx('ask')));
    expect(h.request).toMatchObject({ kind: 'question', options: [{ id: '0', label: 'A' }, { id: '1', label: 'B' }] });
    expect(h.reply({ optionId: '1' })).toEqual({ result: { answers: { q1: { answers: ['B'] } } } });
  });

  it('extra access asks in Manual and is granted for the turn only', () => {
    const params = { permissions: { fileSystem: { write: ['/elsewhere'] } }, reason: 'needs it' };
    const h = card(handleRequest('item/permissions/requestApproval', params, 'c', ctx('ask')));
    expect(h.request.detail).toContain('- /elsewhere');
    expect(h.reply({ optionId: 'allow' })).toEqual({ result: { permissions: { fileSystem: { write: ['/elsewhere'] } }, scope: 'turn' } });
  });

  it('extra access asks in Auto too (it leaves the sandbox), is granted in Bypass and refused in Read only', () => {
    const params = { permissions: { fileSystem: { write: ['/elsewhere'] } } };
    expect(handleRequest('item/permissions/requestApproval', params, 'c', ctx('auto')).kind).toBe('card');
    expect(handleRequest('item/permissions/requestApproval', params, 'c', ctx('bypass'))).toEqual({ kind: 'answer', result: { permissions: { fileSystem: { write: ['/elsewhere'] } }, scope: 'turn' } });
    expect(handleRequest('item/permissions/requestApproval', params, 'c', ctx('readonly'))).toEqual({ kind: 'answer', result: { permissions: {}, scope: 'turn' } });
  });

  it('anything Kestrel does not offer is refused as an unknown method', () => {
    expect(handleRequest('account/chatgptAuthTokens/refresh', {}, 'c', ctx('ask'))).toEqual({ kind: 'refuse', error: { code: -32601, message: 'Kestrel does not handle account/chatgptAuthTokens/refresh.' } });
  });

  it('inside() keeps to the folder', () => {
    expect(inside(`${DIR}/a/b`, DIR)).toBe(true);
    expect(inside('a/b', DIR)).toBe(true);
    expect(inside(DIR, DIR)).toBe(true);
    expect(inside('/scratch/workshop/x', DIR)).toBe(false);
    expect(inside(`${DIR}/../x`, DIR)).toBe(false);
  });
});
