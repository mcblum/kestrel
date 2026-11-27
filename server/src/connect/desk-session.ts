// What another device of the account asks of a session this computer runs, so its window draws the session as one of
// its own (account-sessions.md, "A session on another computer drawn as one here, as built"). All but archiving are
// desk only: the dispatcher refuses those to a phone before it gets here; archiving (`session.archive`) any device may
// ask (Matt, 2026-11-27: "Archive should be allowed from anywhere"). Each operation is one route of the session's page, and is
// carried out by calling the route's own function (session-routes.ts) in process, never through the HTTP listener, so
// the checks are this computer's: the session must be here, a path stays inside its folder, a merge checks the commit.
import type { LivePatch } from '../model.ts';
import { Refused } from '../refused.ts';
import { BadRequest } from '../request-fields.ts';
import type { SessionRuntime } from '../runtime.ts';
import type { Body, RouteAnswer, SessionRoute } from '../session-routes.ts';
import type { ConnectOpArgs, ConnectRequest } from '../shared/connect-ops.ts';
import { carriedFiles, FILE_CARRY_MAX } from '../shared/remote-carry.ts';

/** The operations answered here: every desk-only one that names a session, and archiving one. */
export const DESK_SESSION_OPS = [
  'session.snapshot',
  'session.details',
  'session.context',
  'session.files',
  'session.file',
  'session.document',
  'session.documentPlace',
  'session.raw',
  'session.rename',
  'session.delete',
  'session.archive',
  'session.tag',
  'session.role',
  'session.reviewOf',
  'session.review',
  'session.fork',
  'queue.send',
  'queue.remove',
  'background.stop',
  'command.output',
  'command.retry',
  'command.stop',
  'pr.prepare',
  'pr.create',
  'pr.mergePreview',
  'pr.merge',
] as const;
export type DeskSessionOp = (typeof DESK_SESSION_OPS)[number];
export type DeskSessionRequest = Extract<ConnectRequest, { op: DeskSessionOp }>;
export const isDeskSessionRequest = (request: ConnectRequest): request is DeskSessionRequest => (DESK_SESSION_OPS as readonly string[]).includes(request.op);

/** One route as the operation names it: method, the path after the session's id, its query, and its body. */
interface Call {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: readonly string[];
  query?: Record<string, string>;
  body?: Body;
}

const seg = encodeURIComponent;
const given = (body: Record<string, unknown>): Body => Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));

/** The route an operation is: one per operation, and nothing else can be asked. */
function callOf(request: Exclude<DeskSessionRequest, { op: 'session.snapshot' }>): Call {
  const a = request.args;
  switch (request.op) {
    case 'session.details':
      return { method: 'GET', path: [request.args.section], ...(request.args.refresh ? { query: { refresh: '1' } } : {}) };
    case 'session.context':
      return { method: 'GET', path: ['context'] };
    case 'session.files':
    case 'session.file':
      return { method: 'GET', path: [request.op === 'session.files' ? 'files' : 'file'], query: { path: request.args.path, ...(request.args.folder ? { folder: request.args.folder } : {}) } };
    case 'session.document':
      return { method: 'GET', path: ['document'], query: { path: request.args.path } };
    case 'session.documentPlace':
      return { method: 'GET', path: ['document-place'], query: { path: request.args.path } };
    case 'session.raw':
      return { method: 'GET', path: ['raw'], query: { path: request.args.path } };
    case 'session.rename':
      return { method: 'PATCH', path: [], body: { title: request.args.title } };
    case 'session.delete':
      return { method: 'DELETE', path: [] };
    case 'session.archive':
      return { method: 'POST', path: ['archive'], body: given({ archived: request.args.archived, skipScript: request.args.skipScript }) };
    case 'session.tag':
      return request.args.on ? { method: 'POST', path: ['tags'], body: { tag: request.args.tag } } : { method: 'DELETE', path: ['tags', seg(request.args.tag)] };
    case 'session.role':
      return { method: 'POST', path: ['role'], body: given({ role: request.args.role, brief: request.args.brief }) };
    case 'session.reviewOf':
      return { method: 'GET', path: ['review'] };
    case 'session.review':
      return { method: 'POST', path: ['review'], body: { comment: request.args.comment === true } };
    case 'session.fork':
      return { method: 'POST', path: ['fork'], body: given({ turn: request.args.turn }) };
    case 'queue.send':
      return { method: 'POST', path: ['queue', 'send'] };
    case 'queue.remove':
      return { method: 'DELETE', path: ['queue', seg(request.args.messageId)] };
    case 'background.stop':
      return { method: 'POST', path: ['background-tasks', seg(request.args.taskId), 'stop'] };
    case 'command.output':
      return { method: 'GET', path: ['commands', seg(request.args.commandId), 'output'] };
    case 'command.retry':
      return { method: 'POST', path: ['commands', seg(request.args.commandId), 'retry'] };
    case 'command.stop':
      return { method: 'POST', path: ['commands', seg(request.args.commandId), 'stop'] };
    case 'pr.prepare':
      return { method: 'POST', path: ['pr-prepare'], body: { generated: request.args.generated } };
    case 'pr.create': {
      const { sessionId: _id, ...form } = a as ConnectOpArgs['pr.create'];
      return { method: 'POST', path: ['pr-create'], body: given(form) };
    }
    case 'pr.mergePreview':
      return { method: 'POST', path: ['pr-merge-preview'], body: { number: request.args.number } };
    case 'pr.merge': {
      const { sessionId: _id, ...confirm } = a as ConnectOpArgs['pr.merge'];
      return { method: 'POST', path: ['pr-merge'], body: confirm };
    }
  }
}

/** A file's bytes as carried: in base64 when they fit, else only how large it is, for the other computer to say so. */
export type CarriedBytes = { type: string; data: string } | { type: string; tooLarge: number };

/** The route's answer as the operation's result: its body, a file's bytes, or nothing; a refusal throws its words. */
function resultOf(answer: RouteAnswer): unknown {
  if ('bytes' in answer) return answer.bytes.length > FILE_CARRY_MAX ? { type: answer.type, tooLarge: answer.bytes.length } : { type: answer.type, data: answer.bytes.toString('base64') };
  // Its project's archive script failed: not a refusal but an answer, with the output, so the asker can offer to archive without it.
  const script = answer.status === 409 ? archiveScriptOf(answer.body) : null;
  if (script) return { archiveScript: script };
  if (answer.status >= 400) throw new Refused(errorOf(answer.body) ?? 'That could not be done there.');
  return answer.status === 204 || answer.body === undefined ? {} : answer.body;
}

function archiveScriptOf(body: unknown): { reason: string; output: string } | null {
  const b = typeof body === 'object' && body !== null ? (body as { error?: unknown; archiveScript?: { output?: unknown } }) : null;
  return b && typeof b.error === 'string' && b.archiveScript ? { reason: b.error, output: typeof b.archiveScript.output === 'string' ? b.archiveScript.output : '' } : null;
}

const errorOf = (body: unknown): string | undefined => (typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : undefined);

/**
 * What a window watching the session starts from (runtime.snapshot), less what the other desktop reads from the
 * account's copy (the conversation) and what is never carried (the agent's raw output); its diffs as carried.
 */
export async function deskSnapshot(runtime: Pick<SessionRuntime, 'snapshot'>, sessionId: string): Promise<LivePatch> {
  const snapshot = await runtime.snapshot(sessionId);
  if (!snapshot) return {};
  const { messages: _messages, agentOutput: _output, removedMessages: _removed, ...rest } = snapshot;
  return { ...rest, ...(rest.files ? { files: carriedFiles(rest.files) } : {}) };
}

/** Carries out one desk-only session operation by its route; throws `Refused` with the route's own reason. */
export async function deskSessionOp(request: DeskSessionRequest, route: SessionRoute | null, runtime: Pick<SessionRuntime, 'snapshot'>, here: string): Promise<unknown> {
  if (request.op === 'session.snapshot') return deskSnapshot(runtime, request.args.sessionId);
  if (!route) throw new Refused(`${here} cannot show this session's page to another computer.`);
  const call = callOf(request);
  const url = new URL(`http://kestrel/api/sessions/${seg(request.args.sessionId)}${call.path.map((p) => `/${p}`).join('')}`);
  for (const [k, v] of Object.entries(call.query ?? {})) url.searchParams.set(k, v);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    const answer = await route(parts, call.method, url, async () => call.body ?? {});
    if (!answer) throw new Refused(`${here} has no such page for this session.`);
    return resultOf(answer);
  } catch (error) {
    // A malformed field is a refusal with the route's own words, as the window gets them in a 400.
    if (error instanceof BadRequest) throw new Refused(error.message);
    throw error;
  }
}
