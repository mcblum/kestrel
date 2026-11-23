// The models an agent offers (runtime/agent-info.ts): an answer that lists nothing is not kept.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModelOption } from '../agents/types.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import { SessionRuntime } from '../runtime.ts';
import { MODELS_TTL_MS } from './agent-info.ts';
import { FakeAgents } from '../test-agent.ts';
import { Workspace } from '../workspace.ts';

const DEFAULT_ONLY: ModelOption[] = [{ id: '', label: 'Default' }];
const LISTED: ModelOption[] = [...DEFAULT_ONLY, { id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol' }];

function world(answers: ModelOption[][]) {
  let asked = 0;
  const codex = { ...new FakeAgents().adapter(), models: async () => ({ models: answers[Math.min(asked++, answers.length - 1)]!, fromSdk: true }) };
  const clock = { at: 1_000_000 };
  const runtime = new SessionRuntime(new Workspace(memoryPersistence()), { codex }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-agent-info-'))), { now: () => clock.at });
  return { runtime, asked: () => asked, clock };
}

describe('the models an agent offers', () => {
  it('asks again after an answer with only the Default entry, and says the agent has not listed its models', async () => {
    const { runtime, asked } = world([DEFAULT_ONLY, LISTED]);
    // The listing failed or came back empty: one option, and not an answer to hold on to.
    expect(await runtime.models('codex')).toEqual({ models: DEFAULT_ONLY, fromSdk: false });
    expect(await runtime.models('codex')).toEqual({ models: LISTED, fromSdk: true });
    expect(asked()).toBe(2);
  });

  it('keeps a real list for a while without asking the agent again, then asks: a changed sign-in shows without a restart', async () => {
    const CHANGED: ModelOption[] = [...DEFAULT_ONLY, { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' }];
    const { runtime, asked, clock } = world([LISTED, CHANGED]);
    expect((await runtime.models('codex')).models).toEqual(LISTED);
    expect((await runtime.models('codex')).models).toEqual(LISTED);
    expect(asked()).toBe(1);
    clock.at += MODELS_TTL_MS;
    expect((await runtime.models('codex')).models).toEqual(CHANGED);
    expect(asked()).toBe(2);
  });

  it('keeps the last real list when the agent later cannot list its models', async () => {
    const { runtime, clock } = world([LISTED, DEFAULT_ONLY]);
    await runtime.models('codex');
    clock.at += MODELS_TTL_MS;
    expect(await runtime.models('codex')).toEqual({ models: LISTED, fromSdk: true });
  });
});
