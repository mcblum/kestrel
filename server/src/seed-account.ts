// KESTREL_ACCOUNT_PREVIEW=1, in a checkout only: puts a second computer of the account into this store's
// replica, so the projects of another computer can be looked at with no account and no second Mac
// (account-sessions.md, section 10; DEVELOPMENT.md). Never active in the installed app. It writes what the
// sync would have read, through the same replica, and nothing else:
//
// - a project this computer also has (the same repository key as its first project with an `origin`),
// - one it does not have, with two sessions,
// - one it does not have, with no session,
// - and a plain folder, only on that computer.
//
// Run again, it writes the same rows: nothing piles up.
import type { HeadRecord, Machine } from './shared/machines.ts';
import type { AccountProject } from './shared/account-projects.ts';
import type { Workspace } from './workspace.ts';
import { randomUUID } from 'node:crypto';
import type { StartComputers } from './remote-start.ts';

export const PREVIEW_MACHINE: Machine = { id: 'preview-studio', name: 'Studio Mac' };
const BILLING = 'example.test/acme/billing';
const HANDBOOK = 'example.test/acme/handbook';

const project = (id: string, name: string, repos: string[], folders: AccountProject['folders']): AccountProject => ({ id, machine: PREVIEW_MACHINE, name, repos, folders });

function head(id: string, title: string, at: number, over: Partial<HeadRecord['head']> = {}): HeadRecord {
  return {
    machine: PREVIEW_MACHINE,
    head: { id, runsOn: PREVIEW_MACHINE.id, title, agent: 'claude', state: 'done', note: '', project: { id: 'preview-billing', name: 'Billing' }, repos: [BILLING], filing: 'started', branch: null, request: null, createdAt: at, updatedAt: at, lastActivityAt: at, messages: 0, chunks: 0, ...over },
  };
}

/** Writes the preview computer's projects and sessions into the replica. Answers what it could not show. */
export async function seedAccountPreview(workspace: Workspace, now: number = Date.now()): Promise<string[]> {
  const notes: string[] = [];
  const state = await workspace.state();
  let shared: { name: string; key: string } | null = null;
  for (const p of state.projects) {
    const key = (await workspace.repos.ofProject(p))[0];
    if (key) {
      shared = { name: p.name, key };
      break;
    }
  }
  if (!shared) notes.push('no project here has a git folder with an origin, so the case "a project both computers have" is not shown; add one and start again');
  const projects: AccountProject[] = [
    ...(shared ? [project('preview-shared', `${shared.name} (Studio's name)`, [shared.key], [{ name: 'shared', isGit: true, path: '~/Code/shared' }])] : []),
    project('preview-billing', 'Billing', [BILLING], [{ name: 'billing', isGit: true, path: '~/Code/billing' }]),
    project('preview-handbook', 'Handbook', [HANDBOOK], [{ name: 'handbook', isGit: true, path: '~/Code/handbook' }]),
    project('preview-notes', 'Notes', [], [{ name: 'notes', isGit: false, path: '~/Documents/notes' }]),
  ];
  await workspace.accountProjects.apply({ projects: projects.map((p) => ({ record: `preview|${p.id}`, project: p })), gone: [], members: [PREVIEW_MACHINE.id], whole: true, mark: null });
  await workspace.account.apply({
    heads: [
      head('preview-session-1', 'Fix the invoice rounding', now - 60 * 60_000),
      head('preview-session-2', 'Add a CSV export', now - 5 * 60_000, { state: 'running' }),
      head('preview-session-3', 'Tidy the meeting notes', now - 3 * 60 * 60_000, { project: { id: 'preview-notes', name: 'Notes' }, repos: [] }),
    ],
    gone: [],
    members: [PREVIEW_MACHINE.id],
    whole: true,
    mark: null,
  });
  return notes;
}

/** A second preview computer that is never reached, to show a computer the New session box cannot start on. */
export const PREVIEW_AWAY: Machine = { id: 'preview-laptop', name: 'Old Laptop' };

/**
 * The computers New session may run on in the preview (issue 52): Studio Mac answers as a computer of the account
 * would (its agents and models; a start answers a new session's id, which is then listed here from the answer),
 * Old Laptop never answers. Nothing runs anywhere: the session started on Studio Mac has no conversation.
 */
export function previewStartComputers(): StartComputers {
  return {
    list: () => [PREVIEW_MACHINE, PREVIEW_AWAY],
    ask: async (machine, op, args) => {
      if (machine !== PREVIEW_MACHINE.id) return { ok: false, reached: false, reason: 'The relay says it is not connected.' };
      if (op === 'session.startChoices') {
        return {
          ok: true,
          result: {
            here: PREVIEW_MACHINE.name,
            allowed: true,
            agents: ['claude', 'codex', 'opencode'],
            presets: [],
            start: { agent: 'claude', model: '', effort: '', fast: false, permission: 'ask' },
            providers: [
              { agent: 'claude', name: 'Claude', models: [{ id: '', name: 'Default (Opus 5.5)' }, { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }, { id: 'claude-haiku-5-5', name: 'Haiku 5.5', more: true }], default: '' },
              { agent: 'codex', name: 'Codex', models: [{ id: '', name: 'Default' }], default: '' },
            ],
            missing: [{ agent: 'opencode', name: 'OpenCode', reason: `OpenCode is not installed on ${PREVIEW_MACHINE.name}.` }],
          },
        };
      }
      if (op === 'session.attach') return { ok: true, result: { id: randomUUID() } };
      if (op === 'session.start') return { ok: true, result: { sessionId: randomUUID(), title: String(args.text ?? '').split('\n')[0]?.slice(0, 60) || 'New session', agent: args.agent ?? 'claude' } };
      return { ok: false, reached: true, reason: `${PREVIEW_MACHINE.name} is a preview: it does not do that.` };
    },
  };
}
