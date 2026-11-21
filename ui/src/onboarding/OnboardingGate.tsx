import { useState, type ReactNode } from 'react';
import { useResource } from '../data/resources.ts';
import { asSetup, SETUP_PATH } from './data.ts';
import './onboarding.css';

/**
 * Setup itself takes the whole window (App.tsx) and never reaches here unfinished. This is what the
 * Overview shows when setup progress could not be read: a notice, with the Overview under it.
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const { value, refresh } = useResource(SETUP_PATH, asSetup);
  const [dismissed, setDismissed] = useState(false);
  if (value.state === 'loading') return <div className="page column" role="status">Loading your workspace…</div>;
  if (value.state === 'unavailable') return <>
    {!dismissed && <div className="column setup-unavailable" role="status">
      <span>Setup is unavailable. {value.reason}</span>
      <button className="quiet-button" onClick={() => void refresh()}>Try again</button>
      <button className="quiet-button" onClick={() => setDismissed(true)}>Dismiss</button>
    </div>}
    {children}
  </>;
  return children;
}
