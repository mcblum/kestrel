// Sign in to an agent from Kestrel: one button, and while the browser has the sign-in page, where
// that page is, a place for the code it may show, and Cancel. Drawn wherever an agent is found not
// signed in (a failed turn, Settings → Connections, first-launch setup); they all share one sign-in.
import { useState } from 'react';
import { ExternalLink, LogIn } from 'lucide-react';
import type { Agent } from '@kestrel/server/model';
import { useResource } from '../data/resources.ts';
import { AGENT_LABEL } from '../labels.ts';
import { signInActions, useSignIn } from '../signIn.ts';
import { useApp } from '../store.ts';
import { AGENTS_PATH, asAgentStatus } from './useAgents.ts';

export function SignIn({ agent, small = false }: { agent: Agent; small?: boolean }) {
  const progress = useSignIn(agent);
  const [code, setCode] = useState('');
  const size = small ? ' small' : '';
  // Signed in: the views that offered this hear from the server and stop offering it (signIn.ts).
  if (progress.state === 'done') return null;
  if (progress.state === 'waiting')
    return (
      <div className="sign-in" role="status">
        <p className="sign-in-note">
          Finish signing in to {AGENT_LABEL[agent]} in your browser.{' '}
          {progress.url && <a href={progress.url} target="_blank" rel="noreferrer">Open the sign-in page <ExternalLink aria-hidden /></a>}
        </p>
        <form
          className="sign-in-code"
          onSubmit={(e) => {
            e.preventDefault();
            if (!code.trim()) return;
            void signInActions.code(agent, code);
            setCode('');
          }}
        >
          <input type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code, if the page shows one" aria-label={`Code from the ${AGENT_LABEL[agent]} sign-in page`} autoComplete="off" spellCheck={false} />
          <button type="submit" className={`secondary-button${size}`} disabled={!code.trim()}>Submit code</button>
          <button type="button" className={`secondary-button${size}`} onClick={() => void signInActions.cancel(agent)}>Cancel</button>
        </form>
      </div>
    );
  return (
    <div className="sign-in">
      {progress.state === 'failed' && <p className="field-error" role="alert">{progress.reason}</p>}
      <button className={`primary-button${size}`} onClick={() => void signInActions.start(agent)}>
        <LogIn aria-hidden />
        {progress.state === 'failed' ? 'Try again' : `Sign in to ${AGENT_LABEL[agent]}`}
      </button>
    </div>
  );
}

/**
 * Under a turn that failed because the session's agent is not signed in: Sign in, while that is
 * still so and Kestrel can do it. Showing it asks again which agents can start, since the failure
 * is newer than what was known.
 */
export function SignInOffer({ sessionId }: { sessionId: string }) {
  const agent = useApp((s) => s.sessionsById.get(sessionId)?.agent);
  const status = useResource(AGENTS_PATH, asAgentStatus).value;
  const underWay = useApp((s) => (agent ? s.signIn[agent]?.state : undefined)) ?? 'idle';
  if (!agent) return null;
  const offered = status.state === 'ready' && status.value.signIn.includes(agent);
  if (!offered && underWay === 'idle') return null;
  return <SignIn agent={agent} small />;
}
