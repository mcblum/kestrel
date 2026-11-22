// HTTP routes for signing an agent in from Kestrel (agents/sign-in.ts). Shaped like controls-api.ts:
// the caller hands over the path parts and gets an answer, or null.
//
//   POST   /api/agents/:agent/sign-in        begin (or join) a sign-in: SignInProgress, once the page is known
//   POST   /api/agents/:agent/sign-in/wait   SignInProgress when the sign-in under way ends
//   POST   /api/agents/:agent/sign-in/code   { code }: a code the sign-in page showed
//   DELETE /api/agents/:agent/sign-in        cancel it
//
// An agent Kestrel cannot sign in is refused with the reason (409, from `agentSignIn`).
import type { AgentSignIn, SignInProgress } from './agents/sign-in.ts';
import { isSelectableAgent, type Agent } from './model.ts';

export type SignInAnswer = { status: number; body?: unknown };

export interface SignInHost {
  agentSignIn(agent: Agent): AgentSignIn;
}

export async function signInRoute(parts: readonly string[], method: string, readBody: () => Promise<Record<string, unknown>>, host: SignInHost | null): Promise<SignInAnswer | null> {
  if (!host || parts[1] !== 'agents' || parts[3] !== 'sign-in' || parts.length < 4 || parts.length > 5) return null;
  if (!isSelectableAgent(parts[2])) return { status: 404, body: { error: 'No such agent.' } };
  const step = parts[4];
  const signIn = host.agentSignIn(parts[2]);
  const progress = (body: SignInProgress): SignInAnswer => ({ status: 200, body });
  if (method === 'DELETE' && step === undefined) {
    signIn.cancel();
    return { status: 204 };
  }
  if (method !== 'POST') return null;
  if (step === undefined) return progress(await signIn.start());
  if (step === 'wait') return progress(await signIn.wait());
  if (step === 'code') {
    const { code } = await readBody();
    if (typeof code !== 'string' || !code.trim()) return { status: 400, body: { error: 'code must be the text the sign-in page showed', field: 'code' } };
    signIn.code(code);
    return { status: 204 };
  }
  return null;
}
