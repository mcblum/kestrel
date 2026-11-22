// Signing an agent in from Kestrel (server/src/agents/sign-in.ts). The server starts the agent's own
// login command, which opens the sign-in page in the browser; this module owns the `signIn` slice
// of the store, so every place that offers Sign in (a failed turn, Settings, first-launch setup)
// shows the same one. When a sign-in succeeds, which agents can start is asked again.
import type { Agent } from '@kestrel/server/model';
import { asSignInProgress, NO_SIGN_IN, type SignInProgress } from '@kestrel/server/sign-in';
import { AGENTS_PATH, asAgentStatus } from './components/useAgents.ts';
import { fetchResource } from './data/resources.ts';
import { AGENT_LABEL } from './labels.ts';
import { appStore, call, setApp, useApp } from './store.ts';
import { toasts } from './toasts.ts';

const pathOf = (agent: Agent, step = '') => `/api/agents/${agent}/sign-in${step}`;
const put = (agent: Agent, progress: SignInProgress) => setApp({ signIn: { ...appStore.get().signIn, [agent]: progress } });
const failed = (error: unknown): SignInProgress => ({ state: 'failed', reason: error instanceof Error ? error.message : String(error) });
const ask = (path: string): Promise<SignInProgress> => call<unknown>(path, { method: 'POST' }).then(asSignInProgress, failed);

/** How far the agent's sign-in has got. */
export const useSignIn = (agent: Agent): SignInProgress => useApp((s) => s.signIn[agent]) ?? NO_SIGN_IN;

export const signInActions = {
  /** Begin a sign-in (or join the one under way), and follow it to its end. */
  async start(agent: Agent): Promise<void> {
    if (appStore.get().signIn[agent]?.state === 'waiting') return;
    put(agent, { state: 'waiting', url: null });
    const begun = await ask(pathOf(agent));
    put(agent, begun);
    if (begun.state !== 'waiting') return signInActions.ended(agent, begun);
    const ended = await ask(pathOf(agent, '/wait'));
    put(agent, ended);
    return signInActions.ended(agent, ended);
  },
  /**
   * A sign-in that worked changes which agents can start: every view that shows it hears, and a
   * toast says so. Nothing is kept of it afterwards, so an agent found signed out again later is
   * offered Sign in again.
   */
  async ended(agent: Agent, progress: SignInProgress): Promise<void> {
    if (progress.state !== 'done') return;
    await fetchResource(AGENTS_PATH, asAgentStatus, true);
    put(agent, NO_SIGN_IN);
    toasts.show(`${AGENT_LABEL[agent]} is signed in.`);
  },
  /** A code the sign-in page showed, for a browser that could not hand it over itself. */
  async code(agent: Agent, code: string): Promise<void> {
    await call(pathOf(agent, '/code'), { method: 'POST', body: JSON.stringify({ code }) }).catch((error: unknown) => put(agent, failed(error)));
  },
  async cancel(agent: Agent): Promise<void> {
    await call(pathOf(agent), { method: 'DELETE' }).catch(() => undefined);
  },
};
