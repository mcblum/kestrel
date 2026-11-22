import { describe, expect, it } from 'vitest';
import type { AgentSignIn, SignInProgress } from './agents/sign-in.ts';
import { Refused } from './workspace.ts';
import { signInRoute } from './sign-in-api.ts';

function host(progress: SignInProgress = { state: 'waiting', url: 'https://sign-in.example/x' }) {
  const calls: string[] = [];
  const signIn: AgentSignIn = {
    start: async () => (calls.push('start'), progress),
    wait: async () => (calls.push('wait'), { state: 'done' }),
    code: (text) => void calls.push(`code ${text}`),
    cancel: () => void calls.push('cancel'),
  };
  return {
    calls,
    agentSignIn: (agent: string) => {
      if (agent === 'opencode') throw new Refused('Kestrel cannot sign OpenCode in.');
      return signIn;
    },
  };
}
const path = (rest: string) => ['api', ...rest.split('/')];
const noBody = async () => ({});

describe('the sign-in routes', () => {
  it('begin, follow, take a code and cancel', async () => {
    const h = host();
    expect(await signInRoute(path('agents/claude/sign-in'), 'POST', noBody, h)).toEqual({ status: 200, body: { state: 'waiting', url: 'https://sign-in.example/x' } });
    expect(await signInRoute(path('agents/claude/sign-in/wait'), 'POST', noBody, h)).toEqual({ status: 200, body: { state: 'done' } });
    expect(await signInRoute(path('agents/codex/sign-in/code'), 'POST', async () => ({ code: 'abc' }), h)).toEqual({ status: 204 });
    expect(await signInRoute(path('agents/claude/sign-in'), 'DELETE', noBody, h)).toEqual({ status: 204 });
    expect(h.calls).toEqual(['start', 'wait', 'code abc', 'cancel']);
  });

  it('refuse a code that is not text, and an agent that does not exist', async () => {
    const h = host();
    expect((await signInRoute(path('agents/claude/sign-in/code'), 'POST', async () => ({ code: 7 }), h))?.status).toBe(400);
    expect((await signInRoute(path('agents/nobody/sign-in'), 'POST', noBody, h))?.status).toBe(404);
    expect(h.calls).toEqual([]);
  });

  it('refuse with the reason for an agent Kestrel cannot sign in', async () => {
    await expect(signInRoute(path('agents/opencode/sign-in'), 'POST', noBody, host())).rejects.toThrow('Kestrel cannot sign OpenCode in.');
  });

  it('leave every other path alone', async () => {
    const h = host();
    expect(await signInRoute(path('agents/claude/models'), 'GET', noBody, h)).toBeNull();
    expect(await signInRoute(path('agents/claude/sign-in'), 'GET', noBody, h)).toBeNull();
    expect(await signInRoute(path('agents/claude/sign-in'), 'POST', noBody, null)).toBeNull();
  });
});
