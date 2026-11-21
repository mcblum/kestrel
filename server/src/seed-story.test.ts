// The story scene (`pnpm demo --story`, seed-story.ts): one task, three sessions, one question,
// and nothing else asking for the eye.
import { describe, expect, it } from 'vitest';
import { memoryPersistence } from './persistence/memory.ts';
import { storyReviewRequests } from './review-requests/fake.ts';
import { seedStory, STORY_QUESTION } from './seed-story.ts';
import { sanitize } from './shared/tabs.ts';
import { Workspace } from './workspace.ts';

async function seeded(): Promise<Workspace> {
  const ws = new Workspace(memoryPersistence());
  await seedStory(ws);
  return ws;
}

describe('the story scene', () => {
  it('is one workstream of three sessions: the one the task was asked in (App) and one each in API and Docs', async () => {
    const state = await (await seeded()).state();
    expect(state.projects.map((p) => p.name)).toEqual(['App', 'API', 'Docs']);
    expect(state.workstreams).toHaveLength(1);
    const children = state.links.filter((l) => l.kind === 'delegate' && l.parentId === 'checkout').map((l) => state.sessions.find((s) => s.id === l.childId)!);
    expect(['checkout', ...children.map((s) => s.id)].map((id) => state.sessions.find((s) => s.id === id)!.startedIn).sort()).toEqual(['api', 'app', 'docs']);
    expect(state.sessions.filter((s) => !s.groupId)).toHaveLength(3);
  });

  it('has exactly one session waiting on the user, and the window opens on its question', async () => {
    const ws = await seeded();
    const state = await ws.state();
    const waiting = state.sessions.filter((s) => s.state === 'attention');
    expect(waiting).toHaveLength(1);
    const detail = await ws.detail(waiting[0]!.id);
    expect(detail?.messages.at(-1)?.question).toEqual(STORY_QUESTION);
    const ui = JSON.parse((await ws.getUiState())!) as { tabs: unknown; sidebar: { collapsed: string[] } };
    const tabs = sanitize(ui.tabs);
    expect(tabs.tabs.find((t) => t.id === tabs.activeId)).toMatchObject({ kind: 'session', sessionId: waiting[0]!.id });
  });

  it('folds every folder that is not the task, and those hold only finished sessions', async () => {
    const ws = await seeded();
    const state = await ws.state();
    const ui = JSON.parse((await ws.getUiState())!) as { sidebar: { collapsed: string[] } };
    expect([...ui.sidebar.collapsed].sort()).toEqual(state.groups.map((g) => g.id).sort());
    const filed = state.sessions.filter((s) => s.groupId);
    expect(filed.length).toBeGreaterThan(0);
    expect(filed.every((s) => s.state === 'done')).toBe(true);
  });

  it('with reviews, has two requests, each in one of its projects and neither with a review started', async () => {
    const state = await (await seeded()).state();
    const requests = storyReviewRequests(1_000_000_000);
    expect(requests.map((r) => r.projectId)).toEqual(['app', 'api']);
    expect(new Set(requests.map((r) => r.key)).size).toBe(2);
    expect(requests.every((r) => state.projects.some((p) => p.id === r.projectId) && r.requestedBy)).toBe(true);
    expect(state.sessions.some((s) => s.review)).toBe(false);
  });
});
