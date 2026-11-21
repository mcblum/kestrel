import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { opener } from '../route.ts';

/**
 * The Overview's introduction: a serif headline and one sentence. No bird here: it has the launch
 * screen and the sidebar, and the page is quieter for the projects and whatever needs attention.
 */
export function OverviewIntro({ title, line, onNewSession }: { title: string; line: ReactNode; onNewSession?: (newTab: boolean) => void }) {
  return (
    <header className="intro">
      <div className="intro-text">
        <h1>{title}</h1>
        <p>{line}</p>
      </div>
      {onNewSession && (
        <button className="primary-button small" {...opener(onNewSession)}>
          <Plus aria-hidden /> New session
        </button>
      )}
    </header>
  );
}
