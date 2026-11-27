// The knowledge base line (onboarding.md 18.15): the list, its need on the clone, and each case of Run.
import { describe, expect, it } from 'vitest';
import { setupListOf, type SetupList } from '../shared/setup-list.ts';
import { SETUP_RECORD_VERSION, type SetupRecord } from '../shared/setup-record.ts';
import { Refused } from '../refused.ts';
import { sectionPlan } from './steps.ts';
import { knowledgeStep } from './knowledge-step.ts';
import type { ExecuteDeps, KnowledgeTarget } from './execute.ts';

const REPO = 'gitlab.example.com/team/notes';
const rec = (id: string, name: string, extra: Partial<SetupRecord> = {}): SetupRecord => ({ v: SETUP_RECORD_VERSION, kind: 'setup', machine: { id, name, platform: 'mac' }, readAt: 1, agents: [], hosts: [], git: { name: null, email: null, signs: false, format: null, signingKey: null }, ssh: { hosts: [], keyFiles: [] }, mcp: [], files: [], tools: [], projects: [], problems: [], ...extra });
const laptop = rec('a', 'MacBook Pro', {
  knowledge: { repo: REPO, name: 'Team notes' },
  projects: [{ name: 'Notes', folders: [{ name: 'notes', path: '~/Code/notes', origin: `git@gitlab.example.com:team/notes.git` }] }],
});
const mini = rec('b', 'Mac mini');
const line = (list: SetupList) => list.lines.find((l) => l.id === `knowledge:${REPO}`);

describe('the knowledge base line', () => {
  it('is last, in its own section, and needs the clone of its repository', () => {
    const list = setupListOf(mini, [laptop], { tool: () => false });
    expect(list.lines.at(-1)?.id).toBe(`knowledge:${REPO}`);
    expect(line(list)).toMatchObject({ group: 'knowledge', title: 'Use Team notes as the knowledge base', done: false, page: '#/settings/workflow', askAgent: false });
    expect(line(list)!.needs).toEqual(['project:git@gitlab.example.com:team/notes.git']);
  });

  it('is done when this computer already uses it, says which one it would replace, and is absent when the other uses none', () => {
    expect(line(setupListOf(mini, [laptop], { tool: () => false, knowledge: { repo: REPO, name: 'Notes' } }))!.done).toBe(true);
    expect(line(setupListOf(mini, [laptop], { tool: () => false, knowledge: { repo: 'github.com/me/other', name: 'Other' } }))!.does).toContain('This computer uses Other now; Run asks before replacing it.');
    expect(line(setupListOf(mini, [rec('a', 'MacBook Pro')], { tool: () => false }))).toBeUndefined();
  });

  it("is never run by a section's button", () => {
    const list = setupListOf(mini, [{ ...laptop, projects: [] }], { tool: () => false });
    expect(sectionPlan('knowledge', list).order.map((l) => l.id)).toEqual([`knowledge:${REPO}`]);
    // needsPerson stops it: covered by carryOut; here the plan pulls nothing else in.
    expect(sectionPlan('knowledge', list).also).toEqual([]);
  });
});

describe('Run on the knowledge base line', () => {
  const list = setupListOf(mini, [{ ...laptop, projects: [] }], { tool: () => false });
  const action = { kind: 'knowledge' as const, repo: REPO, name: 'Team notes' };
  const ctx = (input: Record<string, string> = {}) => ({ line: line(list)!, list, input, output: () => undefined, say: () => undefined, files: async () => null });
  function target(current: { projectId: string; name: string } | null, opts: { here?: boolean; manifest?: boolean } = {}): KnowledgeTarget & { used: (string | null)[] } {
    const used: (string | null)[] = [];
    return {
      used,
      current: async () => current,
      projectOf: async () => (opts.here === false ? null : { projectId: 'p-notes', name: 'Notes' }),
      use: async (id) => {
        if (id && opts.manifest === false) throw new Refused('Notes has no kestrel-knowledge.json on origin/main, so it is not a knowledge base.');
        used.push(id);
      },
    };
  }
  const deps = (knowledge: KnowledgeTarget) => ({ knowledge }) as unknown as ExecuteDeps;

  it('sets it through the Settings function, and Undo puts back what was there', async () => {
    const t = target(null);
    const result = await knowledgeStep(deps(t), ctx(), action);
    expect(result).toMatchObject({ state: 'done', said: 'Notes is the knowledge base here now.' });
    if (result.state === 'done') await result.undo?.();
    expect(t.used).toEqual(['p-notes', null]);
  });

  it('asks before replacing a different one; Keep changes nothing; Replace sets it', async () => {
    const t = target({ projectId: 'p-other', name: 'Other' });
    expect(await knowledgeStep(deps(t), ctx(), action)).toMatchObject({ state: 'waiting', ask: 'replace-or-keep' });
    expect(await knowledgeStep(deps(t), ctx({ differ: 'keep' }), action)).toMatchObject({ state: 'done', said: 'Kept Other as the knowledge base here.' });
    expect(t.used).toEqual([]);
    await knowledgeStep(deps(t), ctx({ differ: 'replace' }), action);
    expect(t.used).toEqual(['p-notes']);
  });

  it('fails with the reason when the repository holds no kestrel-knowledge.json, and sets nothing', async () => {
    const t = target(null, { manifest: false });
    expect(await knowledgeStep(deps(t), ctx(), action)).toMatchObject({ state: 'failed', reason: expect.stringContaining('kestrel-knowledge.json') });
    expect(t.used).toEqual([]);
  });

  it('fails plainly when the repository is not a project here yet', async () => {
    expect(await knowledgeStep(deps(target(null, { here: false })), ctx(), action)).toMatchObject({ state: 'failed', reason: expect.stringContaining('Clone it first') });
  });
});
